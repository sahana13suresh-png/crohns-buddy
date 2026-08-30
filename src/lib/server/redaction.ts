/**
 * Outbound payload redaction (Requirements 7.6, 12.9).
 *
 * Anything bound for a third-party analytics service or error-reporting sink
 * passes through `redactOutboundPayload` first. The helper works two ways at
 * once, because either alone is escapable:
 *
 *  1. By key — a value held under a sensitive key (Meal_Plan content, quiz
 *     answers, email address, display name, Auth_Token) is replaced wholesale,
 *     recursively, however deeply it is nested.
 *  2. By value — every surviving string is scrubbed of email addresses, bearer
 *     credentials, and JWT-shaped tokens, so a sensitive value pasted into an
 *     error message or a stack frame is removed even under an innocuous key.
 *
 * The redacted payload keeps its keys and its shape so a report stays
 * diagnosable; only the values are removed.
 */

/** The single placeholder substituted for every removed value. */
export const REDACTED = '[redacted]';

/** Substituted when a structure nests deeper than the walk allows. */
export const REDACTED_DEPTH = '[redacted-depth]';

/** Substituted when a structure refers back to itself. */
export const REDACTED_CIRCULAR = '[redacted-circular]';

/** Maximum object/array nesting the walk descends before truncating. */
const MAX_DEPTH = 12;

/**
 * Keys whose values are never allowed out, compared after normalization
 * (lowercased with every non-alphanumeric character removed), so `display_name`,
 * `displayName`, and `Display Name` are all the same key.
 */
const SENSITIVE_KEYS: ReadonlySet<string> = new Set([
  // Meal_Plan content — every field of MealPlanRecord/MealPlanContent that can
  // hold Patient-authored text, plus the wrappers they travel in.
  'content', 'mealplan', 'mealplans', 'mealplancontent', 'mealplanrecord',
  'meals', 'meal', 'mealname', 'items', 'item', 'portion',
  'summary', 'notes', 'note', 'warnings', 'warning', 'title',
  'record', 'records',
  // Device-local tracker entries travel in the same export document.
  'trackerentries', 'trackerentry', 'foodconsumed',
  // Quiz answers — the wrappers and every free-text or list answer field.
  'quiz', 'quizanswers', 'answers', 'answer',
  'flarestatus', 'currentsymptoms', 'symptomchecklist', 'doctordietinstructions',
  'surgeryorobstruction', 'recentweightloss', 'foodallergies', 'foodstoavoid',
  'safefoods', 'triggerfoods', 'reintroducefoods', 'fibertolerance',
  'preferredmealtypes', 'refusedfoods', 'proteinpreferences', 'carbpreferences',
  'applianceaccess', 'dietarygoals', 'extranotes',
  // Email addresses and display names.
  'email', 'emails', 'emailaddress', 'useremail',
  'displayname', 'name', 'fullname', 'firstname', 'lastname', 'nickname',
  'profilename', 'username',
  // Auth_Token values and every neighbouring credential.
  'token', 'tokens', 'idtoken', 'authtoken', 'accesstoken', 'refreshtoken',
  'authorization', 'bearer', 'jwt', 'credential', 'credentials',
  'password', 'newpassword', 'secret', 'apikey', 'sessioncookie',
]);

/**
 * Key fragments that make a key sensitive wherever they appear, catching
 * variants the explicit set does not enumerate (`firebaseIdToken`,
 * `userDisplayName`, `smtpPassword`, `section3_foodTolerance`).
 */
const SENSITIVE_KEY_FRAGMENTS: readonly string[] = [
  'token', 'password', 'secret', 'apikey', 'credential',
  'email', 'displayname', 'quizanswer', 'mealplan',
];

/**
 * The keys Requirement 7.6 explicitly permits. They are checked before the
 * sensitive set, so `mealPlanId` survives even though it shares the `mealplan`
 * fragment with the content keys.
 */
const PERMITTED_KEYS: ReadonlySet<string> = new Set([
  'mealplanid', 'op', 'outcome', 'failurecategory', 'atms', 'event',
]);

/** Quiz answers arrive keyed by section, e.g. `section1_crohnsStatus`. */
const SECTION_KEY = /^section\d/;

/** Email addresses appearing anywhere inside a surviving string. */
const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;

/** `Authorization: Bearer <token>` and bare `Bearer <token>` fragments. */
const BEARER_PATTERN = /\bbearer\s+\S+/gi;

/** Three base64url segments — the shape of a JWT, whoever signed it. */
const JWT_PATTERN = /\b[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g;

/** Lowercases a key and strips separators so variants compare equal. */
function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * True when a value held under `key` must be removed regardless of its shape.
 */
export function isSensitiveKey(key: string): boolean {
  const normalized = normalizeKey(key);
  if (normalized === '') return false;
  if (PERMITTED_KEYS.has(normalized)) return false;
  if (SENSITIVE_KEYS.has(normalized)) return true;
  if (SECTION_KEY.test(normalized)) return true;
  return SENSITIVE_KEY_FRAGMENTS.some((fragment) => normalized.includes(fragment));
}

/**
 * Removes email addresses, bearer credentials, and JWT-shaped tokens from a
 * string. Returns the string unchanged when it holds none of them.
 */
export function redactString(value: string): string {
  return value
    .replace(BEARER_PATTERN, `Bearer ${REDACTED}`)
    .replace(JWT_PATTERN, REDACTED)
    .replace(EMAIL_PATTERN, REDACTED);
}

function isPlainish(value: object): boolean {
  return !(value instanceof Date) && typeof value !== 'function';
}

function redactValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) return value;

  switch (typeof value) {
    case 'string':
      return redactString(value);
    case 'number':
    case 'boolean':
      return value;
    case 'bigint':
      return value.toString();
    case 'function':
    case 'symbol':
      return REDACTED;
    default:
      break;
  }

  const object = value as object;

  if (object instanceof Date) return object.toISOString();

  if (seen.has(object)) return REDACTED_CIRCULAR;
  if (depth >= MAX_DEPTH) return REDACTED_DEPTH;
  seen.add(object);

  try {
    if (Array.isArray(object)) {
      return object.map((element) => redactValue(element, depth + 1, seen));
    }

    if (object instanceof Error) {
      return { name: object.name, message: redactString(object.message) };
    }

    if (object instanceof Map) {
      return Array.from(object.entries()).map(([key, entryValue]) => [
        typeof key === 'string' ? redactString(key) : redactValue(key, depth + 1, seen),
        typeof key === 'string' && isSensitiveKey(key)
          ? REDACTED
          : redactValue(entryValue, depth + 1, seen),
      ]);
    }

    if (object instanceof Set) {
      return Array.from(object.values()).map((element) => redactValue(element, depth + 1, seen));
    }

    if (!isPlainish(object)) return REDACTED;

    const result: Record<string, unknown> = {};
    for (const [key, entryValue] of Object.entries(object)) {
      result[key] = isSensitiveKey(key) ? REDACTED : redactValue(entryValue, depth + 1, seen);
    }
    return result;
  } finally {
    seen.delete(object);
  }
}

/**
 * Returns a copy of `payload` safe to hand to a third-party analytics or
 * error-reporting sink: no Meal_Plan content, quiz answer, email address,
 * display name, or Auth_Token value survives, at any nesting depth.
 *
 * A sensitive top-level value is removed outright — a bare Auth_Token string or
 * a Meal_Plan_Record passed directly both come back with their content gone.
 */
export function redactOutboundPayload(payload: unknown): unknown {
  return redactValue(payload, 0, new WeakSet<object>());
}

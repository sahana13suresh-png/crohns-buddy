/**
 * Property-based test for store-operation logging and outbound-payload redaction.
 *
 * Feature: user-auth-and-cloud-storage, Property 18.
 *
 * Both halves of the property are answered by searching the *emitted text* for
 * values that must not appear, never by inspecting key names. Meal_Plan content
 * arrives as `arbMarkedRecord()` markers, and the email address, display name,
 * and Auth_Token values are marked the same way, so a leak shows up as a
 * specific string in the output rather than as an argument about which keys a
 * redaction helper ought to have covered.
 */

import fc from 'fast-check';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { redactOutboundPayload } from './redaction';
import {
  logStoreOp,
  type StoreFailureCategory,
  type StoreOp,
  type StoreOutcome,
} from './storeLog';
import { arbMarkedRecord, MARKER_PREFIX, type MarkedMealPlanRecord } from '@/test/arbitraries';

// ─── Log entries (Requirement 7.6) ─────────────────────────────────────────────

/** The only keys Requirement 7.6 permits in a store-operation log entry. */
const PERMITTED_LOG_KEYS = ['atMs', 'event', 'failureCategory', 'mealPlanId', 'op', 'outcome'];

const arbOp = fc.constantFrom<StoreOp[]>(
  'create',
  'update',
  'rename',
  'get',
  'list',
  'delete',
  'purge',
);

const arbFailureCategory = fc.constantFrom<StoreFailureCategory[]>(
  'not-found',
  'cap',
  'size',
  'throttled',
  'unavailable',
  'validation',
);

/** A success carries no failure category; a failure carries one. */
const arbOutcome: fc.Arbitrary<{
  outcome: StoreOutcome;
  failureCategory?: StoreFailureCategory;
}> = fc.oneof(
  fc.constant<{ outcome: StoreOutcome }>({ outcome: 'success' }),
  arbFailureCategory.map((failureCategory) => ({
    outcome: 'failure' as StoreOutcome,
    failureCategory,
  })),
);

const arbAtMs = fc.integer({ min: 0, max: Date.UTC(2035, 0, 1) });

// ─── Outbound payloads (Requirement 12.9) ──────────────────────────────────────

/** Keys a real report would carry that hold nothing sensitive. */
const INNOCUOUS_KEYS = [
  'context',
  'extra',
  'detail',
  'payload',
  'tags',
  'meta',
  'breadcrumbs',
  'frames',
  'attributes',
];

/**
 * Keys under which each kind of sensitive value plausibly travels. Every
 * sensitive value in a generated payload sits under one of these, since a value
 * hidden under a genuinely meaningless key is unrecoverable by any redaction
 * scheme that does not simply discard the whole report — except for email
 * addresses and Auth_Tokens, which are recognizable by shape and are therefore
 * also planted inside free-text messages below.
 */
const CONTENT_KEYS = ['record', 'records', 'mealPlan', 'mealPlans', 'content', 'plan'];
const QUIZ_KEYS = ['quizAnswers', 'quiz', 'answers'];
const EMAIL_KEYS = ['email', 'userEmail', 'emailAddress'];
const NAME_KEYS = ['displayName', 'profileName', 'name'];
const TOKEN_KEYS = ['idToken', 'authToken', 'authorization', 'credential'];

/** Marked personal data that travels alongside a Meal_Plan_Record. */
interface MarkedIdentity {
  email: string;
  displayName: string;
  /** JWT-shaped, so it is recognizable by value as well as by key. */
  jwt: string;
  /** Opaque credential, only ever emitted behind a `Bearer ` prefix. */
  opaqueToken: string;
  /** Quiz answers, each free-text and list answer a distinct marker. */
  quizAnswers: Record<string, unknown>;
  /** Every marked value above, for the absence assertion. */
  markers: string[];
}

const arbMarkedIdentity: fc.Arbitrary<MarkedIdentity> = fc
  .integer({ min: 0, max: 0x7fff_ffff })
  .map((seed) => {
    const tag = seed.toString(16).padStart(8, '0');
    const email = `${MARKER_PREFIX.toLowerCase()}-${tag}@marked.example`;
    const displayName = `${MARKER_PREFIX}-${tag}-displayName`;
    // Three base64url segments — the shape of any RS256 Auth_Token.
    const jwt = `eyJhbGciOiJSUzI1NiIsImtpZCI6Im1hcmtlciJ9.eyJzdWIiOiJNQVJLRVIifQ.sig-${tag}-signature`;
    const opaqueToken = `opaque-${tag}-token`;
    const quizAnswers = {
      section1_crohnsStatus: {
        flareStatus: 'active-flare',
        currentSymptoms: `${MARKER_PREFIX}-${tag}-currentSymptoms`,
        symptomChecklist: [`${MARKER_PREFIX}-${tag}-symptom0`],
      },
      section3_foodTolerance: {
        triggerFoods: [`${MARKER_PREFIX}-${tag}-triggerFood0`],
        fiberTolerance: 'low',
      },
      section6_output: { extraNotes: `${MARKER_PREFIX}-${tag}-extraNotes` },
    };

    return {
      email,
      displayName,
      jwt,
      opaqueToken,
      quizAnswers,
      markers: [
        email,
        displayName,
        jwt,
        opaqueToken,
        `${MARKER_PREFIX}-${tag}-currentSymptoms`,
        `${MARKER_PREFIX}-${tag}-symptom0`,
        `${MARKER_PREFIX}-${tag}-triggerFood0`,
        `${MARKER_PREFIX}-${tag}-extraNotes`,
      ],
    };
  });

/** One nesting step: an array wrapper or an object under an innocuous key. */
const arbWrapStep = fc.constantFrom('[]', ...INNOCUOUS_KEYS);

/** Up to three nesting steps, outermost first. */
const arbWrapPath = fc.array(arbWrapStep, { minLength: 0, maxLength: 3 });

/** Wraps `leaf` in the given nesting path, outermost step first. */
function wrap(leaf: unknown, path: readonly string[]): unknown {
  let acc = leaf;
  for (let i = path.length - 1; i >= 0; i -= 1) {
    acc = path[i] === '[]' ? [acc] : { [path[i]]: acc };
  }
  return acc;
}

/** One sensitive value, keyed and nested as it would arrive in a real report. */
interface Slot {
  key: string;
  value: unknown;
  path: readonly string[];
}

function arbSlot(keys: readonly string[], value: unknown): fc.Arbitrary<Slot> {
  return fc
    .tuple(fc.constantFrom(...keys), arbWrapPath)
    .map(([key, path]) => ({ key, value, path }));
}

/** Free-text messages carrying an email address or an Auth_Token by value. */
function arbMessages(identity: MarkedIdentity): fc.Arbitrary<string[]> {
  return fc.subarray(
    [
      `verification failed for token ${identity.jwt}`,
      `Authorization: Bearer ${identity.opaqueToken}`,
      `no account for ${identity.email}`,
      `Bearer ${identity.jwt} rejected while contacting ${identity.email}`,
      'store unavailable after 3 attempts',
    ],
    { minLength: 1 },
  );
}

/** A payload bound for a third-party analytics or error-reporting sink. */
interface OutboundCase {
  payload: Record<string, unknown>;
  /** Every value that must not survive redaction. */
  markers: string[];
  mealPlanId: string;
}

const arbOutboundCase: fc.Arbitrary<OutboundCase> = fc
  .tuple(arbMarkedRecord(), arbMarkedIdentity, arbOp, arbAtMs)
  .chain(([marked, identity, op, atMs]: [MarkedMealPlanRecord, MarkedIdentity, StoreOp, number]) =>
    fc
      .tuple(
        arbSlot(CONTENT_KEYS, marked.record),
        arbSlot(CONTENT_KEYS, [marked.record, marked.record.content]),
        arbSlot(QUIZ_KEYS, identity.quizAnswers),
        arbSlot(EMAIL_KEYS, identity.email),
        arbSlot(NAME_KEYS, identity.displayName),
        arbSlot(TOKEN_KEYS, identity.jwt),
        arbSlot(TOKEN_KEYS, identity.opaqueToken),
        arbMessages(identity),
        fc.constantFrom('save_failed', 'list_failed', 'client_error'),
      )
      .map(([record, plans, quiz, email, name, jwt, opaque, messages, event]) => {
        const slots: Slot[] = [record, plans, quiz, email, name, jwt, opaque];

        // Diagnostic fields Requirement 7.6 explicitly permits, plus the
        // free-text messages a real error report carries.
        const payload: Record<string, unknown> = {
          event,
          mealPlanId: marked.record.mealPlanId,
          op,
          outcome: 'failure',
          atMs,
          message: messages[0],
          stack: messages.join('\n  at '),
          error: new Error(messages[messages.length - 1]),
        };

        slots.forEach((slot, index) => {
          payload[`slot${index}`] = wrap({ [slot.key]: slot.value }, slot.path);
        });

        return {
          payload,
          markers: [...marked.markers, ...identity.markers],
          mealPlanId: marked.record.mealPlanId,
        };
      }),
  );

// ─── The property ──────────────────────────────────────────────────────────────

describe('store-operation logging and outbound-payload redaction', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Feature: user-auth-and-cloud-storage, Property 18: Store-operation logs and
  // outbound payloads carry no content or personal data
  it('limits every store-operation log entry to the Meal_Plan_Id, operation, outcome, and timestamp', () => {
    fc.assert(
      fc.property(arbMarkedRecord(), arbOp, arbOutcome, arbAtMs, (marked, op, outcome, atMs) => {
        const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
        try {
          logStoreOp({ mealPlanId: marked.record.mealPlanId, op, atMs, ...outcome });

          expect(spy).toHaveBeenCalledTimes(1);
          const emitted = String(spy.mock.calls[0][0]);
          const line = JSON.parse(emitted) as Record<string, unknown>;

          // Only permitted fields, and every permitted field carries the value
          // it was given — the entry stays diagnosable.
          for (const key of Object.keys(line)) expect(PERMITTED_LOG_KEYS).toContain(key);
          expect(line.mealPlanId).toBe(marked.record.mealPlanId);
          expect(line.op).toBe(op);
          expect(line.outcome).toBe(outcome.outcome);
          expect(line.atMs).toBe(atMs);
          expect('failureCategory' in line).toBe(outcome.failureCategory !== undefined);
          if (outcome.failureCategory !== undefined) {
            expect(line.failureCategory).toBe(outcome.failureCategory);
          }

          // No Meal_Plan content, and no User_Id, reaches the log output.
          for (const value of marked.markers) expect(emitted).not.toContain(value);
          expect(emitted).not.toContain(marked.record.userId);
        } finally {
          spy.mockRestore();
        }
      }),
      { numRuns: 300 },
    );
  });

  // Feature: user-auth-and-cloud-storage, Property 18: Store-operation logs and
  // outbound payloads carry no content or personal data
  it('strips content, quiz answers, email addresses, display names, and Auth_Tokens from any outbound payload', () => {
    fc.assert(
      fc.property(arbOutboundCase, ({ payload, markers, mealPlanId }) => {
        // Guard against a vacuous pass: every marker really is in the payload
        // handed to the helper, so the absence assertions below have something
        // to find.
        const raw = JSON.stringify(payload);
        for (const value of markers) expect(raw).toContain(value);

        const redacted = redactOutboundPayload(payload);
        const emitted = JSON.stringify(redacted);

        for (const value of markers) expect(emitted).not.toContain(value);
        // Not one marker of any kind survives, however it was nested.
        expect(emitted).not.toContain(MARKER_PREFIX);

        // The report remains useful: the permitted diagnostic fields survive.
        expect(emitted).toContain(mealPlanId);
        expect((redacted as Record<string, unknown>).event).toBe(payload.event);
        expect((redacted as Record<string, unknown>).atMs).toBe(payload.atMs);
      }),
      { numRuns: 300 },
    );
  });
});

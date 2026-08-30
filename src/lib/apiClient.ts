/**
 * The single browser-side entry point for every Meal_Plan_API and account
 * request.
 *
 * Three behaviors the requirements repeat for each endpoint are written once
 * here instead of at each call site:
 *
 * - **The 10-second bound** (Requirements 5.11, 6.6, 8.5, 8.8, 10.9) is the
 *   default timeout, enforced with `AbortController` — the same pattern
 *   `src/lib/bedrock.ts` uses for its 90-second Bedrock timeout.
 * - **The Auth_Token** is attached from `getIdTokenForRequest()`, so no caller
 *   reads the token itself.
 * - **`unauthorized` is handled centrally**: the Session is discarded and every
 *   subscriber is notified so the plan list empties and the expiry message
 *   appears. That is the same path Requirement 2.13 describes for an elapsed
 *   Session, so an expired token and an elapsed Session look identical.
 *
 * Callers own the rest: a failed request never destroys displayed state. The
 * result is additive — a failure carries a `kind` and a `message` to show
 * beside the data that is already on screen, never a reset of that data.
 */

import { getIdTokenForRequest, signOutEverywhere } from './auth';

// ─── Types ─────────────────────────────────────────────────────────────────────

/**
 * The failure categories a caller can act on. Every response status and
 * transport failure collapses into exactly one of these.
 */
export type ApiFailureKind =
  | 'unauthorized'
  | 'not-found'
  | 'conflict'
  | 'too-large'
  | 'ack-required'
  | 'validation'
  | 'unavailable'
  | 'timeout';

export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; kind: ApiFailureKind; message: string };

export interface CallApiOptions {
  /** Defaults to `DEFAULT_TIMEOUT_MS`. */
  timeoutMs?: number;
}

// ─── Constants ─────────────────────────────────────────────────────────────────

/** Requirements 5.11, 6.6, 8.5, 8.8, and 10.9 all name the same 10 seconds. */
export const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * The one message shown when a request is refused for a credential reason.
 * Requirement 2.13 asks for this same wording when a Session's 30 days elapse,
 * and the two paths are deliberately identical: the response body for a 401 is
 * opaque by design (Requirement 4.3), so there is nothing more specific to say.
 */
export const SESSION_EXPIRED_MESSAGE =
  'Your session expired. Sign in again to see your saved meal plans.';

/**
 * Fallback wording per failure kind, used when the response carries no message
 * of its own. The server does supply one for its own failures; a transport
 * failure has no body at all.
 */
const DEFAULT_MESSAGES: Record<ApiFailureKind, string> = {
  unauthorized: SESSION_EXPIRED_MESSAGE,
  'not-found': 'That meal plan is not available to this account.',
  conflict: 'You have reached the 100 saved meal plan limit. Delete one before saving another.',
  'too-large': 'That meal plan is too large to save.',
  'ack-required': 'Acknowledge the storage notice before saving a meal plan.',
  validation: 'That request could not be completed as submitted.',
  unavailable: 'Saved meal plans are temporarily unreachable. Please try again.',
  timeout: 'The request took too long to complete. Please try again.',
};

// ─── Central unauthorized handling ─────────────────────────────────────────────

type UnauthorizedListener = () => void;

const unauthorizedListeners = new Set<UnauthorizedListener>();

/**
 * Subscribes to credential refusals. The listener runs exactly once per refused
 * call, after the locally held Session has been discarded, and is where the
 * plan list is emptied and the expiry message is shown (Requirement 2.13).
 * Returns an unsubscribe function.
 */
export function onUnauthorized(listener: UnauthorizedListener): () => void {
  unauthorizedListeners.add(listener);
  return () => {
    unauthorizedListeners.delete(listener);
  };
}

/** Drops every subscriber. Exists for test isolation. */
export function clearUnauthorizedListeners(): void {
  unauthorizedListeners.clear();
}

/**
 * Discards the Session, then notifies subscribers. `signOutEverywhere` already
 * swallows an Auth_Service failure and clears the local Session first, so the
 * notification is not gated on the network (Requirement 2.8).
 */
function handleUnauthorized(): void {
  void signOutEverywhere();
  for (const listener of Array.from(unauthorizedListeners)) {
    try {
      listener();
    } catch {
      // One failing subscriber must not stop the others, and must not turn a
      // credential refusal into a thrown error at the call site.
    }
  }
}

// ─── Status mapping ────────────────────────────────────────────────────────────

/**
 * The response status to failure-kind mapping from the design's failure
 * taxonomy. Anything outside the taxonomy — a 429 from an edge, a 502 from a
 * proxy, an unexpected 4xx — reports `unavailable`, because the caller's
 * behavior for an unclassified failure is the same as for an outage: keep what
 * is displayed, show a message, offer a retry.
 */
function kindForStatus(status: number): ApiFailureKind {
  switch (status) {
    case 401:
    case 403:
      return 'unauthorized';
    case 404:
      return 'not-found';
    case 409:
      return 'conflict';
    case 413:
      return 'too-large';
    case 428:
      return 'ack-required';
    case 400:
    // 422 is the deserializer refusing a stored record. It is a distinct server
    // class with its own cannot-open guidance (Requirement 6.9), but from the
    // browser's side it is the same shape: this request will not succeed as
    // submitted, so retrying it unchanged is pointless.
    case 422:
      return 'validation';
    default:
      return 'unavailable';
  }
}

// ─── Request and response plumbing ─────────────────────────────────────────────

async function buildHeaders(init: RequestInit): Promise<Headers> {
  const headers = new Headers(init.headers);

  if (!headers.has('Authorization')) {
    const token = await getIdTokenForRequest();
    if (token) {
      headers.set('Authorization', `Bearer ${token}`);
    }
  }

  if (init.body !== undefined && init.body !== null && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  return headers;
}

/** The response body as JSON, or null when there is no parseable body. */
async function readJsonBody(response: Response): Promise<unknown> {
  if (response.status === 204) return null;
  try {
    const text = await response.text();
    if (text.trim().length === 0) return null;
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** The server's own wording for a failure, when it supplied one. */
function messageFrom(body: unknown): string | null {
  if (body === null || typeof body !== 'object') return null;
  const candidate = (body as { message?: unknown; error?: unknown });
  for (const value of [candidate.message, candidate.error]) {
    if (typeof value === 'string' && value.trim().length > 0) {
      return value;
    }
  }
  return null;
}

function failure(kind: ApiFailureKind, message?: string | null): { ok: false; kind: ApiFailureKind; message: string } {
  return { ok: false, kind, message: message ?? DEFAULT_MESSAGES[kind] };
}

// ─── The wrapper ───────────────────────────────────────────────────────────────

/**
 * Performs one request against the Website's own API, attaching the Auth_Token
 * and bounding the wait, and reports the outcome as a value rather than by
 * throwing — every failure a caller must render is a `kind` in `ApiResult`.
 *
 * A `204 No Content` response resolves to `{ ok: true }` with `data` absent, so
 * a caller expecting no body can declare `callApi<void>(...)`.
 */
export async function callApi<T>(
  path: string,
  init: RequestInit = {},
  opts: CallApiOptions = {}
): Promise<ApiResult<T>> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let headers: Headers;
  try {
    headers = await buildHeaders(init);
  } catch {
    // The token read failed outright, which is not a signal about the Session's
    // validity — the request simply never left. Reported as retryable.
    return failure('unavailable');
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetch(path, { ...init, headers, signal: controller.signal });
  } catch (error: unknown) {
    clearTimeout(timeoutId);
    if (error instanceof Error && error.name === 'AbortError') {
      return failure('timeout');
    }
    return failure('unavailable');
  }

  clearTimeout(timeoutId);

  const body = await readJsonBody(response);

  if (!response.ok) {
    const kind = kindForStatus(response.status);
    if (kind === 'unauthorized') {
      handleUnauthorized();
      // The server's 401 body is one opaque constant for every credential
      // cause, so the Session-expiry wording is used instead of echoing it.
      return failure('unauthorized');
    }
    return failure(kind, messageFrom(body));
  }

  // `204 No Content` carries no body, so `data` is left absent rather than set
  // to a stand-in value a `callApi<void>` caller would have to ignore.
  if (response.status === 204) {
    return { ok: true } as ApiResult<T>;
  }

  return { ok: true, data: body as T };
}

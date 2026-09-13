import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  callApi,
  clearUnauthorizedListeners,
  DEFAULT_TIMEOUT_MS,
  onUnauthorized,
  SESSION_EXPIRED_MESSAGE,
  type ApiFailureKind,
} from './apiClient';
import { fetchAuthSession, signOutEverywhere } from './auth';

// `callApi` asks the server to refresh a refused cookie session and discards the
// Session after a final refusal. Those are the only auth touchpoints here.
vi.mock('./auth', () => ({
  fetchAuthSession: vi.fn(async () => null),
  signOutEverywhere: vi.fn(async () => undefined),
}));

const mockFetchAuthSession = vi.mocked(fetchAuthSession);
const mockSignOutEverywhere = vi.mocked(signOutEverywhere);

function jsonResponse(status: number, body: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Stubs `fetch` with a fixed response and returns the spy, for header assertions. */
function stubFetch(response: () => Response) {
  const spy = vi.fn(async (_path: string, _init?: RequestInit) => response());
  vi.stubGlobal('fetch', spy);
  return spy;
}

/** The headers the wrapper sent on its first (and only) request. */
function headersOf(spy: ReturnType<typeof stubFetch>): Headers {
  return new Headers(spy.mock.calls[0]?.[1]?.headers);
}

/** A `fetch` that never resolves until the request is aborted. */
function stubHangingFetch() {
  const spy = vi.fn(
    (_path: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const abortError = new Error('aborted');
          abortError.name = 'AbortError';
          reject(abortError);
        });
      })
  );
  vi.stubGlobal('fetch', spy);
  return spy;
}

beforeEach(() => {
  mockFetchAuthSession.mockReset();
  mockFetchAuthSession.mockResolvedValue(null);
  mockSignOutEverywhere.mockReset();
  mockSignOutEverywhere.mockResolvedValue(undefined);
});

afterEach(() => {
  clearUnauthorizedListeners();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('callApi', () => {
  it('returns the parsed body on success', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, { items: [] })));

    const result = await callApi<{ items: string[] }>('/api/meal-plans');

    expect(result).toEqual({ ok: true, data: { items: [] } });
  });

  it('reports a 409 as a conflict carrying the server message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(409, { message: 'Delete one first.' })));

    const result = await callApi('/api/meal-plans', { method: 'POST', body: '{}' });

    expect(result).toEqual({ ok: false, kind: 'conflict', message: 'Delete one first.' });
  });

  it('handles a credential refusal centrally, exactly once per call', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(401, { message: 'opaque' })));
    const listener = vi.fn();
    onUnauthorized(listener);

    const result = await callApi('/api/meal-plans');

    expect(result).toEqual({
      ok: false,
      kind: 'unauthorized',
      message: SESSION_EXPIRED_MESSAGE,
    });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('reports a timeout once the default bound elapses', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_path: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              const abortError = new Error('aborted');
              abortError.name = 'AbortError';
              reject(abortError);
            });
          })
      )
    );

    const pending = callApi('/api/meal-plans');
    await vi.advanceTimersByTimeAsync(DEFAULT_TIMEOUT_MS);

    expect(await pending).toMatchObject({ ok: false, kind: 'timeout' });
  });
});

// ─── Status to kind mapping ────────────────────────────────────────────────────

describe('callApi status mapping', () => {
  // The taxonomy from the design, plus the statuses that fall outside it. An
  // unclassified failure reports `unavailable` because the caller's behavior is
  // the same as for an outage: keep what is displayed, offer a retry.
  const cases: Array<[number, ApiFailureKind]> = [
    [401, 'unauthorized'],
    [403, 'unauthorized'],
    [404, 'not-found'],
    [409, 'conflict'],
    [413, 'too-large'],
    [428, 'ack-required'],
    [400, 'validation'],
    [422, 'validation'],
    [429, 'unavailable'],
    [500, 'unavailable'],
    [502, 'unavailable'],
    [503, 'unavailable'],
    [418, 'unavailable'],
  ];

  it.each(cases)('maps %i to %s', async (status, kind) => {
    stubFetch(() => jsonResponse(status, undefined));

    const result = await callApi('/api/meal-plans');

    expect(result).toMatchObject({ ok: false, kind });
  });

  it('reports a transport failure as unavailable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      })
    );

    const result = await callApi('/api/meal-plans');

    expect(result).toMatchObject({ ok: false, kind: 'unavailable' });
  });

  it('resolves a 204 to a success with no data', async () => {
    stubFetch(() => new Response(null, { status: 204 }));

    const result = await callApi<void>('/api/meal-plans/abc', { method: 'DELETE' });

    expect(result.ok).toBe(true);
    expect('data' in result).toBe(false);
  });
});

// ─── Timeout ───────────────────────────────────────────────────────────────────

describe('callApi timeout', () => {
  it('honours a caller-supplied bound and not a moment sooner', async () => {
    vi.useFakeTimers();
    stubHangingFetch();

    let settled = false;
    const pending = callApi('/api/meal-plans', {}, { timeoutMs: 2_500 }).then((result) => {
      settled = true;
      return result;
    });

    await vi.advanceTimersByTimeAsync(2_499);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toMatchObject({ ok: false, kind: 'timeout' });
  });

  it('leaves a response that arrives inside the bound untouched', async () => {
    vi.useFakeTimers();
    stubFetch(() => jsonResponse(200, { ok: 'yes' }));

    const result = await callApi<{ ok: string }>('/api/meal-plans');

    expect(result).toEqual({ ok: true, data: { ok: 'yes' } });
  });
});

// ─── Headers ───────────────────────────────────────────────────────────────────

describe('callApi headers', () => {
  it('uses same-origin cookies without exposing an Authorization token', async () => {
    const fetchSpy = stubFetch(() => jsonResponse(200, {}));

    await callApi('/api/meal-plans');

    const headers = headersOf(fetchSpy);
    expect(headers.has('Authorization')).toBe(false);
    expect(fetchSpy.mock.calls[0]?.[1]?.credentials).toBe('same-origin');
  });

  it('never overwrites an Authorization header the caller supplied', async () => {
    const fetchSpy = stubFetch(() => jsonResponse(200, {}));

    await callApi('/api/internal/pending-deletion-sweep', {
      method: 'POST',
      headers: { Authorization: 'Bearer cron-secret' },
    });

    const headers = headersOf(fetchSpy);
    expect(headers.get('Authorization')).toBe('Bearer cron-secret');
    expect(mockFetchAuthSession).not.toHaveBeenCalled();
  });

  it('sets a JSON content type when a body is present and none was given', async () => {
    const fetchSpy = stubFetch(() => jsonResponse(201, {}));

    await callApi('/api/meal-plans', { method: 'POST', body: JSON.stringify({ title: 'x' }) });

    const headers = headersOf(fetchSpy);
    expect(headers.get('Content-Type')).toBe('application/json');
  });

  it('keeps a content type the caller supplied', async () => {
    const fetchSpy = stubFetch(() => jsonResponse(200, {}));

    await callApi('/api/meal-plans', {
      method: 'POST',
      body: 'a=1',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    const headers = headersOf(fetchSpy);
    expect(headers.get('Content-Type')).toBe('application/x-www-form-urlencoded');
  });

  it('sets no content type on a bodyless request', async () => {
    const fetchSpy = stubFetch(() => jsonResponse(200, {}));

    await callApi('/api/meal-plans');

    const headers = headersOf(fetchSpy);
    expect(headers.has('Content-Type')).toBe(false);
  });
});

// ─── Central unauthorized handling ─────────────────────────────────────────────

describe('callApi unauthorized handling', () => {
  it('discards the Session and notifies every subscriber once', async () => {
    stubFetch(() => jsonResponse(401, { message: 'opaque' }));
    const first = vi.fn();
    const second = vi.fn();
    onUnauthorized(first);
    onUnauthorized(second);

    await callApi('/api/meal-plans');

    expect(mockSignOutEverywhere).toHaveBeenCalledTimes(1);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('takes the same path for a 403 as for a 401', async () => {
    stubFetch(() => jsonResponse(403, { message: 'forbidden' }));
    const listener = vi.fn();
    onUnauthorized(listener);

    const result = await callApi('/api/meal-plans');

    expect(result).toEqual({
      ok: false,
      kind: 'unauthorized',
      message: SESSION_EXPIRED_MESSAGE,
    });
    expect(mockSignOutEverywhere).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('notifies once per refused call, not once per session', async () => {
    stubFetch(() => jsonResponse(401, {}));
    const listener = vi.fn();
    onUnauthorized(listener);

    await callApi('/api/meal-plans');
    await callApi('/api/meal-plans');

    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('does not surface a throwing subscriber at the call site', async () => {
    stubFetch(() => jsonResponse(401, {}));
    const thrower = vi.fn(() => {
      throw new Error('render failed');
    });
    const after = vi.fn();
    onUnauthorized(thrower);
    onUnauthorized(after);

    const result = await callApi('/api/meal-plans');

    expect(result).toMatchObject({ ok: false, kind: 'unauthorized' });
    expect(thrower).toHaveBeenCalledTimes(1);
    expect(after).toHaveBeenCalledTimes(1);
  });

  it('stops notifying once the subscriber unsubscribes', async () => {
    stubFetch(() => jsonResponse(401, {}));
    const listener = vi.fn();
    const unsubscribe = onUnauthorized(listener);

    unsubscribe();
    await callApi('/api/meal-plans');

    expect(listener).not.toHaveBeenCalled();
  });

  it('leaves subscribers alone for a failure that is not a credential refusal', async () => {
    stubFetch(() => jsonResponse(503, {}));
    const listener = vi.fn();
    onUnauthorized(listener);

    await callApi('/api/meal-plans');

    expect(listener).not.toHaveBeenCalled();
    expect(mockSignOutEverywhere).not.toHaveBeenCalled();
  });
});

// ─── Failure messages ──────────────────────────────────────────────────────────

describe('callApi failure messages', () => {
  it('prefers the server message over the per-kind default', async () => {
    stubFetch(() => jsonResponse(413, { message: 'That plan is 140 KB.' }));

    const result = await callApi('/api/meal-plans', { method: 'POST', body: '{}' });

    expect(result).toEqual({ ok: false, kind: 'too-large', message: 'That plan is 140 KB.' });
  });

  it('falls back to the server error field when there is no message field', async () => {
    stubFetch(() => jsonResponse(400, { error: 'title exceeds 100 characters' }));

    const result = await callApi('/api/meal-plans', { method: 'POST', body: '{}' });

    expect(result).toEqual({
      ok: false,
      kind: 'validation',
      message: 'title exceeds 100 characters',
    });
  });

  it('uses the per-kind default when the body carries no wording', async () => {
    stubFetch(() => jsonResponse(404, { detail: 'nope' }));

    const result = await callApi('/api/meal-plans/abc');

    expect(result).toMatchObject({
      ok: false,
      kind: 'not-found',
      message: 'That meal plan is not available to this account.',
    });
  });

  it('uses the per-kind default when there is no body at all', async () => {
    stubFetch(() => new Response(null, { status: 503 }));

    const result = await callApi('/api/meal-plans');

    expect(result).toMatchObject({
      ok: false,
      kind: 'unavailable',
      message: 'Saved meal plans are temporarily unreachable. Please try again.',
    });
  });

  it('uses the per-kind default when the body is not JSON', async () => {
    stubFetch(() => new Response('<html>gateway</html>', { status: 502 }));

    const result = await callApi('/api/meal-plans');

    expect(result).toMatchObject({ ok: false, kind: 'unavailable' });
  });

  it('never echoes the opaque 401 body', async () => {
    // The server's 401 body is one frozen constant for every credential cause
    // (Requirement 4.3), so there is nothing more specific to show than the
    // Session-expiry wording an elapsed Session shows.
    stubFetch(() => jsonResponse(401, { message: 'Unauthorized.', error: 'Unauthorized.' }));

    const result = await callApi('/api/meal-plans');

    expect(result).toEqual({
      ok: false,
      kind: 'unauthorized',
      message: SESSION_EXPIRED_MESSAGE,
    });
  });
});

import { describe, it, expect, vi, afterEach } from 'vitest';
import { logStoreOp } from './storeLog';

function captureLine(fn: () => void): Record<string, unknown> {
  const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
  try {
    fn();
    expect(spy).toHaveBeenCalledTimes(1);
    return JSON.parse(String(spy.mock.calls[0][0])) as Record<string, unknown>;
  } finally {
    spy.mockRestore();
  }
}

describe('logStoreOp', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('emits only the permitted fields on success', () => {
    const line = captureLine(() =>
      logStoreOp({ mealPlanId: '01JBQ8Z2K9AB0CDEFGH1JKMNPQ', op: 'create', outcome: 'success', atMs: 1_700_000_000_000 }),
    );

    expect(Object.keys(line).sort()).toEqual(['atMs', 'event', 'mealPlanId', 'op', 'outcome']);
    expect(line).toMatchObject({
      event: 'mealPlanStoreOp',
      mealPlanId: '01JBQ8Z2K9AB0CDEFGH1JKMNPQ',
      op: 'create',
      outcome: 'success',
      atMs: 1_700_000_000_000,
    });
  });

  it('carries the failure category on failure and omits it otherwise', () => {
    const failure = captureLine(() =>
      logStoreOp({ mealPlanId: 'abc', op: 'delete', outcome: 'failure', failureCategory: 'throttled', atMs: 1 }),
    );
    expect(failure.failureCategory).toBe('throttled');

    const success = captureLine(() => logStoreOp({ mealPlanId: 'abc', op: 'get', outcome: 'success', atMs: 1 }));
    expect('failureCategory' in success).toBe(false);
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountPurgeResult } from '@/app/api/account/purge/accountPurge';
import {
  advanceAccountDeletion,
  CONFIRMATION_TEXT,
  confirmAccountDeletion,
  createBrowserDeletionPorts,
  DELETION_TRANSITIONS,
  DESTRUCTIVE_EFFECT_ORDER,
  findDeletionTransition,
  hasRemovedData,
  initialDeletionContext,
  isConfirmEnabled,
  MAX_REAUTH_ATTEMPTS,
  matchesConfirmationText,
  reduceDeletion,
  REAUTH_WINDOW_MS,
  submitReauthentication,
  type AccountDeletionPorts,
  type DeletionContext,
} from './accountDeletion';
import { classifyAuthError, deleteCurrentAccount, reauthenticate, signOutEverywhere } from './auth';
import { callApi } from './apiClient';
import { clearAllEntries } from './trackerStorage';

// The flow's only runtime dependencies are these three modules, and
// `createBrowserDeletionPorts` is the sole place they are reached. Replacing
// them keeps the state machine tests free of the Firebase SDK and localStorage.
vi.mock('./auth', () => ({
  classifyAuthError: vi.fn(() => 'unknown'),
  deleteCurrentAccount: vi.fn(async () => undefined),
  reauthenticate: vi.fn(async () => undefined),
  signOutEverywhere: vi.fn(async () => undefined),
}));

vi.mock('./apiClient', () => ({ callApi: vi.fn(async () => ({ ok: true, data: {} })) }));
vi.mock('./trackerStorage', () => ({ clearAllEntries: vi.fn() }));

const AUTH_TIME = 1_700_000_000_000;
const FRESH_NOW = AUTH_TIME + 1_000;
const STALE_NOW = AUTH_TIME + REAUTH_WINDOW_MS + 1;

function purgeResult(over: Partial<AccountPurgeResult> = {}): AccountPurgeResult {
  return { deletedCount: 3, remaining: 0, pendingDeletion: false, ...over };
}

interface FakePorts extends AccountDeletionPorts {
  /** Every port call, in the order it happened. */
  readonly calls: string[];
}

/**
 * Ports that record their own call order, so the ordering assertions read the
 * effects as they actually happened rather than as the context reports them.
 */
function fakePorts(over: Partial<AccountDeletionPorts> = {}): FakePorts {
  const calls: string[] = [];
  const base: AccountDeletionPorts = {
    purgeRecords: async () => ({ ok: true, data: purgeResult() }),
    removeAccount: async () => 'removed',
    clearTrackerEntries: () => undefined,
    endSession: async () => undefined,
    reauthenticate: async () => 'succeeded',
  };
  const merged = { ...base, ...over };
  return {
    calls,
    purgeRecords: async () => {
      calls.push('remove-records');
      return merged.purgeRecords();
    },
    removeAccount: async () => {
      calls.push('remove-account');
      return merged.removeAccount();
    },
    clearTrackerEntries: async () => {
      calls.push('clear-tracker');
      return merged.clearTrackerEntries();
    },
    endSession: async () => {
      calls.push('end-session');
      return merged.endSession();
    },
    reauthenticate: async (password) => {
      calls.push('reauthenticate');
      return merged.reauthenticate(password);
    },
  };
}

/** A confirming context with `DELETE` already typed. */
function typedDelete(): DeletionContext {
  return reduceDeletion(initialDeletionContext(), {
    type: 'confirmation-text-changed',
    text: CONFIRMATION_TEXT,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('the confirmation gate (Requirements 11.2, 11.8)', () => {
  it('opens with the confirm control disabled and nothing removed', () => {
    const context = initialDeletionContext();
    expect(context.state).toBe('confirming');
    expect(isConfirmEnabled(context)).toBe(false);
    expect(hasRemovedData(context)).toBe(false);
  });

  it('enables the confirm control only for the exact uppercase text', () => {
    for (const text of ['DELETE']) {
      expect(matchesConfirmationText(text)).toBe(true);
    }
    for (const text of ['delete', 'Delete', ' DELETE', 'DELETE ', 'DELETED', 'DELET', '']) {
      expect(matchesConfirmationText(text)).toBe(false);
    }
  });

  it('keeps the flow open with the field editable and removes nothing on a mismatch', async () => {
    const ports = fakePorts();
    const typed = reduceDeletion(initialDeletionContext(), {
      type: 'confirmation-text-changed',
      text: 'delete',
    });

    const after = await confirmAccountDeletion(typed, ports, AUTH_TIME, FRESH_NOW);

    expect(after.state).toBe('confirming');
    expect(after.message).toBe('confirmation-mismatch');
    expect(after.confirmationText).toBe('delete');
    expect(ports.calls).toEqual([]);
    expect(hasRemovedData(after)).toBe(false);
  });

  it('clears the mismatch message as soon as the field is edited', () => {
    const mismatched = reduceDeletion(
      reduceDeletion(initialDeletionContext(), { type: 'confirmation-text-changed', text: 'x' }),
      { type: 'confirm-submitted', authTimeMs: AUTH_TIME, nowMs: FRESH_NOW }
    );
    expect(mismatched.message).toBe('confirmation-mismatch');

    const edited = reduceDeletion(mismatched, {
      type: 'confirmation-text-changed',
      text: CONFIRMATION_TEXT,
    });
    expect(edited.message).toBeNull();
    expect(isConfirmEnabled(edited)).toBe(true);
  });
});

describe('the re-authentication gate (Requirements 11.5, 11.6, 11.10)', () => {
  it('prompts and removes nothing when the authentication is more than 5 minutes old', async () => {
    const ports = fakePorts();

    const after = await confirmAccountDeletion(typedDelete(), ports, AUTH_TIME, STALE_NOW);

    expect(after.state).toBe('reauthenticating');
    expect(after.message).toBe('reauth-required');
    expect(ports.calls).toEqual([]);
    expect(hasRemovedData(after)).toBe(false);
  });

  it('treats the 5-minute boundary itself as still fresh', async () => {
    const ports = fakePorts();

    const after = await confirmAccountDeletion(
      typedDelete(),
      ports,
      AUTH_TIME,
      AUTH_TIME + REAUTH_WINDOW_MS
    );

    expect(after.state).toBe('completed');
  });

  it('returns to the confirmation step with the field emptied after a successful re-auth', async () => {
    const ports = fakePorts();
    const prompted = await confirmAccountDeletion(typedDelete(), ports, AUTH_TIME, STALE_NOW);

    const after = await submitReauthentication(prompted, ports, 'pw');

    expect(after.state).toBe('confirming');
    expect(after.confirmationText).toBe('');
    expect(isConfirmEnabled(after)).toBe(false);
    expect(after.message).toBe('retype-confirmation');
    // Re-authenticating alone must not reach a destructive port.
    expect(ports.calls).toEqual(['reauthenticate']);
  });

  it('has no transition at all from re-authentication into purging', () => {
    const straightToPurging = DELETION_TRANSITIONS.filter(
      (transition) => transition.from === 'reauthenticating' && transition.to === 'purging'
    );
    expect(straightToPurging).toEqual([]);
  });

  it('ends the flow with nothing removed when the prompt is cancelled', async () => {
    const ports = fakePorts({ reauthenticate: async () => 'cancelled' });
    const prompted = await confirmAccountDeletion(typedDelete(), ports, AUTH_TIME, STALE_NOW);

    const after = await submitReauthentication(prompted, ports);

    expect(after.state).toBe('aborted');
    expect(after.message).toBe('not-deleted');
    expect(hasRemovedData(after)).toBe(false);
  });

  it('ends the flow after 3 consecutive failures and not before', async () => {
    const ports = fakePorts({ reauthenticate: async () => 'failed' });
    let context = await confirmAccountDeletion(typedDelete(), ports, AUTH_TIME, STALE_NOW);

    for (let attempt = 1; attempt < MAX_REAUTH_ATTEMPTS; attempt += 1) {
      context = await submitReauthentication(context, ports, 'wrong');
      expect(context.state).toBe('reauthenticating');
      expect(context.reauthFailures).toBe(attempt);
    }

    context = await submitReauthentication(context, ports, 'wrong');

    expect(context.reauthFailures).toBe(MAX_REAUTH_ATTEMPTS);
    expect(context.state).toBe('aborted');
    expect(context.message).toBe('not-deleted');
    expect(hasRemovedData(context)).toBe(false);
  });
});

describe('the ordered removal (Requirements 11.3, 11.4, 11.7)', () => {
  it('removes records, then the Account, then tracker entries, then the Session', async () => {
    const ports = fakePorts();

    const after = await confirmAccountDeletion(typedDelete(), ports, AUTH_TIME, FRESH_NOW);

    expect(ports.calls).toEqual([...DESTRUCTIVE_EFFECT_ORDER]);
    expect(after.completedEffects).toEqual([...DESTRUCTIVE_EFFECT_ORDER]);
    expect(after.state).toBe('completed');
    expect(after.message).toBe('completed');
    expect(after.deletedCount).toBe(3);
  });

  it('reports the pending-deletion wording when records remain after the purge', async () => {
    const ports = fakePorts({
      purgeRecords: async () => ({
        ok: true,
        data: purgeResult({ deletedCount: 90, remaining: 10, pendingDeletion: true }),
      }),
    });

    const after = await confirmAccountDeletion(typedDelete(), ports, AUTH_TIME, FRESH_NOW);

    expect(ports.calls).toEqual([...DESTRUCTIVE_EFFECT_ORDER]);
    expect(after.state).toBe('completed');
    expect(after.pendingDeletion).toBe(true);
    expect(after.remaining).toBe(10);
    expect(after.message).toBe('completed-pending');
  });
});

describe('a record removal that fails before the Account is removed (Requirement 11.9)', () => {
  it('aborts with nothing removed and never reaches the Auth_Service', async () => {
    const ports = fakePorts({
      purgeRecords: async () => ({ ok: false, kind: 'unavailable', message: 'store down' }),
    });

    const after = await confirmAccountDeletion(typedDelete(), ports, AUTH_TIME, FRESH_NOW);

    expect(after.state).toBe('aborted');
    expect(after.message).toBe('deletion-incomplete');
    expect(after.completedEffects).toEqual([]);
    expect(ports.calls).toEqual(['remove-records']);
  });

  it('offers a restart that returns to an empty confirmation field', async () => {
    const ports = fakePorts({
      purgeRecords: async () => ({ ok: false, kind: 'timeout', message: 'too slow' }),
    });
    const aborted = await confirmAccountDeletion(typedDelete(), ports, AUTH_TIME, FRESH_NOW);

    const restarted = reduceDeletion(aborted, { type: 'restart' });

    expect(restarted.state).toBe('confirming');
    expect(restarted.confirmationText).toBe('');
    expect(isConfirmEnabled(restarted)).toBe(false);
    expect(restarted.message).toBeNull();
  });
});

describe('a Session that expires mid-flow (Requirement 11.6)', () => {
  it('removes nothing, prompts, and requires the confirmation text again', async () => {
    const ports = fakePorts({
      purgeRecords: async () => ({ ok: false, kind: 'unauthorized', message: 'expired' }),
    });

    const prompted = await confirmAccountDeletion(typedDelete(), ports, AUTH_TIME, FRESH_NOW);

    expect(prompted.state).toBe('reauthenticating');
    expect(prompted.message).toBe('session-expired');
    expect(prompted.completedEffects).toEqual([]);
    expect(ports.calls).toEqual(['remove-records']);

    const resumed = await submitReauthentication(prompted, ports, 'pw');

    expect(resumed.state).toBe('confirming');
    expect(resumed.confirmationText).toBe('');
    // Still nothing removed, and the purge has not been re-issued.
    expect(ports.calls).toEqual(['remove-records', 'reauthenticate']);
  });

  it('re-prompts rather than aborting when the Account removal needs a recent login', async () => {
    const ports = fakePorts({ removeAccount: async () => 'requires-recent-login' });

    const after = await confirmAccountDeletion(typedDelete(), ports, AUTH_TIME, FRESH_NOW);

    expect(after.state).toBe('reauthenticating');
    expect(after.confirmationText).toBe('');
    expect(after.completedEffects).toEqual(['remove-records']);
    expect(ports.calls).toEqual(['remove-records', 'remove-account']);
  });

  it('stops before the tracker and the Session when the Account removal fails outright', async () => {
    const ports = fakePorts({ removeAccount: async () => 'failed' });

    const after = await confirmAccountDeletion(typedDelete(), ports, AUTH_TIME, FRESH_NOW);

    expect(after.state).toBe('aborted');
    expect(after.message).toBe('account-removal-incomplete');
    expect(ports.calls).toEqual(['remove-records', 'remove-account']);
  });
});

describe('the machine ignores events its current state does not admit', () => {
  it('cannot be advanced into a removal by dispatching a later event early', () => {
    const context = initialDeletionContext();
    for (const event of [
      { type: 'purge-succeeded', result: purgeResult() },
      { type: 'account-removed' },
      { type: 'tracker-cleared' },
      { type: 'session-ended' },
      { type: 'reauth-succeeded' },
    ] as const) {
      const after = reduceDeletion(context, event);
      expect(after).toEqual(context);
      expect(findDeletionTransition(context, event)).toBeNull();
    }
  });

  it('runs no port from a state that names no effect', async () => {
    const ports = fakePorts();
    expect((await advanceAccountDeletion(initialDeletionContext(), ports)).state).toBe('confirming');
    expect(ports.calls).toEqual([]);
  });

  it('does not re-authenticate outside the re-authentication state', async () => {
    const ports = fakePorts();
    const context = typedDelete();
    expect(await submitReauthentication(context, ports)).toEqual(context);
    expect(ports.calls).toEqual([]);
  });
});

describe('createBrowserDeletionPorts', () => {
  it('posts to the purge route under the 30-second bound', async () => {
    vi.mocked(callApi).mockResolvedValue({ ok: true, data: purgeResult() });

    await createBrowserDeletionPorts().purgeRecords();

    expect(callApi).toHaveBeenCalledWith(
      '/api/account/purge',
      { method: 'POST' },
      { timeoutMs: 30_000 }
    );
  });

  it('classifies a stale-login rejection of the Account removal', async () => {
    vi.mocked(deleteCurrentAccount).mockRejectedValue(new Error('stale'));
    vi.mocked(classifyAuthError).mockReturnValue('requires-recent-login');

    expect(await createBrowserDeletionPorts().removeAccount()).toBe('requires-recent-login');
  });

  it('classifies any other Account removal rejection as a plain failure', async () => {
    vi.mocked(deleteCurrentAccount).mockRejectedValue(new Error('offline'));
    vi.mocked(classifyAuthError).mockReturnValue('unavailable');

    expect(await createBrowserDeletionPorts().removeAccount()).toBe('failed');
  });

  it('classifies a cancelled re-authentication apart from a failed one', async () => {
    const ports = createBrowserDeletionPorts();

    vi.mocked(reauthenticate).mockRejectedValueOnce(new Error('closed'));
    vi.mocked(classifyAuthError).mockReturnValueOnce('popup-cancelled');
    expect(await ports.reauthenticate()).toBe('cancelled');

    vi.mocked(reauthenticate).mockRejectedValueOnce(new Error('wrong'));
    vi.mocked(classifyAuthError).mockReturnValueOnce('invalid-credentials');
    expect(await ports.reauthenticate('pw')).toBe('failed');
  });

  it('clears the tracker entries on this device and ends the Session', async () => {
    const ports = createBrowserDeletionPorts();

    await ports.clearTrackerEntries();
    await ports.endSession();

    expect(clearAllEntries).toHaveBeenCalledTimes(1);
    expect(signOutEverywhere).toHaveBeenCalledTimes(1);
  });
});

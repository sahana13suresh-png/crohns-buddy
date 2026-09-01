import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AccountSettingsPage, {
  CONFIRM_DELETE_LABEL,
  DELETE_ACCOUNT_LABEL,
  EXPORT_FAILED_MESSAGE,
  EXPORT_LABEL,
  EXPORT_RETRY_LABEL,
  REAUTH_CANCEL_LABEL,
  REAUTH_SUBMIT_LABEL,
  RESTART_LABEL,
  SIGNED_OUT_MESSAGE,
  type AccountExportFile,
} from './AccountSettingsPage';
import type { SessionContextValue, SessionStatus } from '@/components/auth/SessionProvider';
import { DELETION_MESSAGE_TEXT, type AccountDeletionPorts } from '@/lib/accountDeletion';
import type { AccountDataExport } from '@/app/api/account/export/accountExport';
import type { TrackerEntry } from '@/lib/types';

// The Session is an input to this view, so it is supplied directly rather than
// driven through Firebase.
const { mockUseSession } = vi.hoisted(() => ({ mockUseSession: vi.fn() }));
vi.mock('@/components/auth/SessionProvider', () => ({ useSession: mockUseSession }));

// `callApi` and the deletion state machine run for real. Only the `auth.ts`
// touchpoints are replaced, which is what keeps the Firebase SDK out of here;
// the five destructive ports are injected instead.
vi.mock('@/lib/auth', () => ({
  isCognitoConfigured: () => true,
  isSelfRegistrationEnabled: () => false,
  getIdTokenForRequest: vi.fn(async () => 'token-1'),
  signOutEverywhere: vi.fn(async () => undefined),
  classifyAuthError: vi.fn(() => 'unknown'),
  deleteCurrentAccount: vi.fn(async () => undefined),
  reauthenticate: vi.fn(async () => undefined),
  // Read at module scope by the provider controls `AuthModal` imports.
  signInWithProvider: vi.fn(async () => ({ status: 'cancelled' })),
}));

// ─── Fixtures ──────────────────────────────────────────────────────────────────

/** 23:30 UTC, a time at which some local zones are already on the next day. */
const NOW_MS = Date.UTC(2025, 0, 15, 23, 30, 0);

const STALE_AUTH_MS = NOW_MS - 10 * 60 * 1000;

const EXPORT_DOCUMENT: AccountDataExport = {
  userId: 'uid-1',
  displayName: 'Ada Lovelace',
  email: 'ada@example.com',
  accountCreatedAt: '2025-01-01T00:00:00.000Z',
  mealPlans: [],
};

const TRACKER_ENTRY: TrackerEntry = {
  date: '2025-01-14',
  foodConsumed: 'Oatmeal',
  painLevel: 3,
  bowelMovements: 2,
  stressLevel: 4,
  energyLevel: 6,
  submittedAt: '2025-01-14T09:00:00.000Z',
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Queues one response per call, so a retry can differ from the first attempt. */
function stubFetch(...responses: Array<() => Response>) {
  const spy = vi.fn(async () => {
    const next = responses.length > 1 ? responses.shift()! : responses[0];
    return next();
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

// ─── Download capture ──────────────────────────────────────────────────────────

/**
 * Every `Blob` the page constructs, as the JSON it was given. A failed export
 * must leave this empty — that is how "no partial file" is checked.
 */
let blobPayloads: string[] = [];
/** The `download` attribute of every anchor the page activated. */
let downloadNames: string[] = [];

class RecordingBlob {
  constructor(parts: unknown[]) {
    blobPayloads.push(parts.map(String).join(''));
  }
}

function theDownloadedFile(): AccountExportFile {
  expect(blobPayloads).toHaveLength(1);
  return JSON.parse(blobPayloads[0]) as AccountExportFile;
}

// ─── Deletion ports ────────────────────────────────────────────────────────────

const CLEAN_PURGE = { deletedCount: 2, remaining: 0, pendingDeletion: false } as const;

/**
 * Ports that record the destructive effects they perform, so the order
 * Requirement 11.3 fixes is observable, and so a test can assert that a gate
 * held by showing nothing was called at all.
 */
function recordingPorts(overrides: Partial<AccountDeletionPorts> = {}) {
  const calls: string[] = [];
  const base: AccountDeletionPorts = {
    purgeRecords: async () => ({ ok: true, data: { ...CLEAN_PURGE } }),
    removeAccount: async () => 'removed',
    clearTrackerEntries: () => undefined,
    endSession: async () => undefined,
    reauthenticate: async () => 'succeeded',
  };
  const ports: AccountDeletionPorts = {
    purgeRecords: () => {
      calls.push('remove-records');
      return (overrides.purgeRecords ?? base.purgeRecords)();
    },
    removeAccount: () => {
      calls.push('remove-account');
      return (overrides.removeAccount ?? base.removeAccount)();
    },
    clearTrackerEntries: () => {
      calls.push('clear-tracker');
      return (overrides.clearTrackerEntries ?? base.clearTrackerEntries)();
    },
    endSession: () => {
      calls.push('end-session');
      return (overrides.endSession ?? base.endSession)();
    },
    reauthenticate: (password) => {
      calls.push('reauthenticate');
      return (overrides.reauthenticate ?? base.reauthenticate)(password);
    },
  };
  return { ports, calls };
}

// ─── Render ────────────────────────────────────────────────────────────────────

function renderPage(
  options: { status?: SessionStatus; authTimeMs?: number; ports?: AccountDeletionPorts } = {}
) {
  const status = options.status ?? 'authenticated';
  const value: SessionContextValue = {
    session:
      status === 'authenticated'
        ? {
            userId: 'uid-1',
            displayName: 'Ada Lovelace',
            email: 'ada@example.com',
            emailVerified: true,
            authTimeMs: options.authTimeMs ?? NOW_MS,
            sessionStartedAtMs: NOW_MS,
          }
        : null,
    status,
    expiredMessage: null,
    planViewEpoch: 0,
    signOut: vi.fn(),
    dismissExpiredMessage: vi.fn(),
    redirectOutcome: null,
    clearRedirectOutcome: vi.fn(),
  };
  mockUseSession.mockReturnValue(value);
  return render(<AccountSettingsPage deletionPorts={options.ports} />);
}

/** Opens the deletion flow and types the exact confirmation text. */
async function openFlowAndTypeDelete(user: ReturnType<typeof userEvent.setup>, text = 'DELETE') {
  await user.click(screen.getByRole('button', { name: DELETE_ACCOUNT_LABEL }));
  await user.type(screen.getByLabelText(/type delete to confirm/i), text);
}

// ─── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  blobPayloads = [];
  downloadNames = [];
  window.localStorage.clear();

  // The UTC date the download name carries, and the freshness reference the
  // deletion gate compares against.
  vi.spyOn(Date, 'now').mockReturnValue(NOW_MS);

  vi.stubGlobal('Blob', RecordingBlob);
  Object.defineProperty(URL, 'createObjectURL', {
    value: vi.fn(() => 'blob:mock'),
    configurable: true,
    writable: true,
  });
  Object.defineProperty(URL, 'revokeObjectURL', {
    value: vi.fn(),
    configurable: true,
    writable: true,
  });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement
  ) {
    downloadNames.push(this.download);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ─── Export (Requirements 10.1, 10.3, 10.4, 10.9) ──────────────────────────────

describe('AccountSettingsPage export control', () => {
  it('merges the device tracker entries in and names the file from the UTC date', async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(
      'crohns-buddy-tracker-entries',
      JSON.stringify({ [TRACKER_ENTRY.date]: TRACKER_ENTRY })
    );
    stubFetch(() => jsonResponse(200, EXPORT_DOCUMENT));
    renderPage();

    await user.click(screen.getByRole('button', { name: EXPORT_LABEL }));

    await waitFor(() => expect(blobPayloads).toHaveLength(1));
    const file = theDownloadedFile();
    expect(file.userId).toBe('uid-1');
    expect(file.mealPlans).toEqual([]);
    expect(file.trackerEntries).toEqual({ [TRACKER_ENTRY.date]: TRACKER_ENTRY });
    // Requirement 10.4 — the UTC date, not the local one.
    expect(downloadNames).toEqual(['crohns-buddy-export-2025-01-15.json']);
  });

  it('exports an empty tracker collection rather than omitting it', async () => {
    const user = userEvent.setup();
    stubFetch(() => jsonResponse(200, EXPORT_DOCUMENT));
    renderPage();

    await user.click(screen.getByRole('button', { name: EXPORT_LABEL }));

    await waitFor(() => expect(blobPayloads).toHaveLength(1));
    const file = theDownloadedFile();
    expect(Object.hasOwn(file, 'trackerEntries')).toBe(true);
    expect(file.trackerEntries).toEqual({});
  });

  it('reports a failed export with a retry control and writes no partial file', async () => {
    const user = userEvent.setup();
    const fetchSpy = stubFetch(
      () => jsonResponse(503, { error: 'STORE_UNAVAILABLE' }),
      () => jsonResponse(200, EXPORT_DOCUMENT)
    );
    renderPage();

    await user.click(screen.getByRole('button', { name: EXPORT_LABEL }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(EXPORT_FAILED_MESSAGE));
    // Requirement 10.9 — no file at all, not a truncated one.
    expect(blobPayloads).toEqual([]);
    expect(downloadNames).toEqual([]);

    await user.click(screen.getByRole('button', { name: EXPORT_RETRY_LABEL }));

    await waitFor(() => expect(blobPayloads).toHaveLength(1));
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});

// ─── Deletion (Requirements 11.1 through 11.10) ─────────────────────────────────

describe('AccountSettingsPage deletion flow', () => {
  it('lists what is removed and keeps the confirm control disabled until the text is exactly DELETE', async () => {
    const user = userEvent.setup();
    const { ports, calls } = recordingPorts();
    renderPage({ ports });

    await user.click(screen.getByRole('button', { name: DELETE_ACCOUNT_LABEL }));

    // Scoped to the flow, because the export description names the same data.
    const flow = within(screen.getByRole('region', { name: 'Delete your account' }));
    expect(flow.getByText(/cannot be undone/i)).toBeInTheDocument();
    expect(flow.getByText(/every meal plan saved to your account/i)).toBeInTheDocument();
    expect(flow.getByText(/symptom tracker entries held in this browser/i)).toBeInTheDocument();
    const confirm = screen.getByRole('button', { name: CONFIRM_DELETE_LABEL });
    expect(confirm).toBeDisabled();

    const field = screen.getByLabelText(/type delete to confirm/i);
    await user.type(field, 'delete');
    expect(confirm).toBeDisabled();

    await user.clear(field);
    await user.type(field, 'DELETE');
    expect(confirm).toBeEnabled();
    expect(calls).toEqual([]);
  });

  it('reports the exact-match requirement and removes nothing when other text is submitted', async () => {
    const user = userEvent.setup();
    const { ports, calls } = recordingPorts();
    renderPage({ ports });

    await openFlowAndTypeDelete(user, 'delete me');
    await user.keyboard('{Enter}');

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        DELETION_MESSAGE_TEXT['confirmation-mismatch']
      )
    );
    expect(calls).toEqual([]);
    // Requirement 11.8 — the flow stays open with the field editable.
    expect(screen.getByLabelText(/type delete to confirm/i)).toHaveValue('delete me');
  });

  it('removes records, then the account, then the device entries, then the session, and confirms', async () => {
    const user = userEvent.setup();
    const { ports, calls } = recordingPorts();
    renderPage({ ports });

    await openFlowAndTypeDelete(user);
    await user.click(screen.getByRole('button', { name: CONFIRM_DELETE_LABEL }));

    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(DELETION_MESSAGE_TEXT.completed)
    );
    expect(calls).toEqual(['remove-records', 'remove-account', 'clear-tracker', 'end-session']);
    // Self-registration remains disabled after account removal.
    expect(screen.getByRole('button', { name: 'Log In / Sign Up' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sign Up' })).not.toBeInTheDocument();
  });

  it('says removal of the remaining meal plan data is still in progress when records are left behind', async () => {
    const user = userEvent.setup();
    const { ports } = recordingPorts({
      purgeRecords: async () => ({
        ok: true,
        data: { deletedCount: 1, remaining: 2, pendingDeletion: true },
      }),
    });
    renderPage({ ports });

    await openFlowAndTypeDelete(user);
    await user.click(screen.getByRole('button', { name: CONFIRM_DELETE_LABEL }));

    // Requirement 11.7 — the Account is removed and the residue is named.
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(
        DELETION_MESSAGE_TEXT['completed-pending']
      )
    );
  });

  it('prompts for re-authentication on a stale authentication and requires the text again', async () => {
    const user = userEvent.setup();
    const { ports, calls } = recordingPorts();
    renderPage({ ports, authTimeMs: STALE_AUTH_MS });

    await openFlowAndTypeDelete(user);
    await user.click(screen.getByRole('button', { name: CONFIRM_DELETE_LABEL }));

    // Requirement 11.5 — nothing is removed until re-authentication succeeds.
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(DELETION_MESSAGE_TEXT['reauth-required'])
    );
    expect(calls).toEqual([]);

    await user.click(screen.getByRole('button', { name: REAUTH_SUBMIT_LABEL }));

    // Requirement 11.6 — back at the confirmation step with the field emptied.
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        DELETION_MESSAGE_TEXT['retype-confirmation']
      )
    );
    expect(screen.getByLabelText(/type delete to confirm/i)).toHaveValue('');
    expect(screen.getByRole('button', { name: CONFIRM_DELETE_LABEL })).toBeDisabled();
    expect(calls).toEqual(['reauthenticate']);
  });

  it('ends the flow with nothing removed when the re-authentication prompt is cancelled', async () => {
    const user = userEvent.setup();
    const { ports, calls } = recordingPorts();
    renderPage({ ports, authTimeMs: STALE_AUTH_MS });

    await openFlowAndTypeDelete(user);
    await user.click(screen.getByRole('button', { name: CONFIRM_DELETE_LABEL }));
    await waitFor(() => screen.getByRole('button', { name: REAUTH_CANCEL_LABEL }));
    await user.click(screen.getByRole('button', { name: REAUTH_CANCEL_LABEL }));

    // Requirement 11.10 — the Account was not deleted.
    expect(screen.getByRole('alert')).toHaveTextContent(DELETION_MESSAGE_TEXT['not-deleted']);
    expect(calls).toEqual([]);
  });

  it('offers a restart when the record removal fails, leaving the account intact', async () => {
    const user = userEvent.setup();
    const { ports, calls } = recordingPorts({
      purgeRecords: async () => ({ ok: false, kind: 'unavailable', message: 'store down' }),
    });
    renderPage({ ports });

    await openFlowAndTypeDelete(user);
    await user.click(screen.getByRole('button', { name: CONFIRM_DELETE_LABEL }));

    // Requirement 11.9 — the Account is untouched and a restart is offered.
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        DELETION_MESSAGE_TEXT['deletion-incomplete']
      )
    );
    expect(calls).toEqual(['remove-records']);

    await user.click(screen.getByRole('button', { name: RESTART_LABEL }));

    expect(screen.getByLabelText(/type delete to confirm/i)).toHaveValue('');
    expect(screen.getByRole('button', { name: CONFIRM_DELETE_LABEL })).toBeDisabled();
  });
});

// ─── Privacy_Notice and the signed-out view ────────────────────────────────────

describe('AccountSettingsPage surrounding state', () => {
  it('links to the Privacy_Notice', () => {
    renderPage();

    expect(screen.getByRole('link', { name: 'Privacy Notice' })).toHaveAttribute(
      'href',
      '/privacy'
    );
  });

  it('offers account access without export controls with no Session', () => {
    renderPage({ status: 'unauthenticated' });

    expect(screen.getByText(SIGNED_OUT_MESSAGE)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Log In / Sign Up' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sign Up' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: EXPORT_LABEL })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Privacy Notice' })).toBeInTheDocument();
  });
});

// @vitest-environment node

import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  authenticateLogtoSession: vi.fn(),
  deleteLogtoUser: vi.fn(),
  authenticateCognitoSession: vi.fn(),
}));

vi.mock('@/lib/server/logtoAuth', () => ({
  authenticateLogtoSession: mocks.authenticateLogtoSession,
  deleteLogtoUser: mocks.deleteLogtoUser,
}));

vi.mock('@/lib/server/cognitoAuth', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/server/cognitoAuth')>();
  return {
    ...actual,
    authenticateCognitoSession: mocks.authenticateCognitoSession,
  };
});

import { DELETE } from './route';

const originalEnv = process.env;

beforeEach(() => {
  process.env = { ...originalEnv, AUTH_PROVIDER: 'logto' };
  vi.clearAllMocks();
  mocks.authenticateLogtoSession.mockResolvedValue({
    ok: true,
    session: {
      identity: {
        userId: 'logto-user-1',
        email: 'patient@example.com',
        displayName: 'Patient',
        emailVerified: true,
        authTimeMs: Date.now(),
      },
      accessToken: 'access-token',
    },
  });
  mocks.deleteLogtoUser.mockResolvedValue('ok');
});

afterEach(() => {
  process.env = originalEnv;
});

describe('DELETE /api/auth/account with Logto', () => {
  it('requires a fresh authenticated session and removes the derived user', async () => {
    const request = new NextRequest(
      'https://www.crohns-buddy.com/api/auth/account',
      { method: 'DELETE' },
    );
    const response = await DELETE(request);

    expect(mocks.authenticateLogtoSession).toHaveBeenCalledWith(request, {
      allowRefresh: true,
      requireFreshRevocationCheck: true,
    });
    expect(mocks.deleteLogtoUser).toHaveBeenCalledWith('logto-user-1');
    expect(response.status).toBe(204);
    expect(response.headers.get('set-cookie')).toContain(
      '__Host-cb-id-token=',
    );
  });

  it('does not call the management API without authentication', async () => {
    mocks.authenticateLogtoSession.mockResolvedValue({
      ok: false,
      kind: 'missing',
    });

    const response = await DELETE(
      new NextRequest('https://www.crohns-buddy.com/api/auth/account', {
        method: 'DELETE',
      }),
    );

    expect(response.status).toBe(401);
    expect(mocks.deleteLogtoUser).not.toHaveBeenCalled();
  });

  it('reports an unavailable management service without clearing the account', async () => {
    mocks.deleteLogtoUser.mockResolvedValue('unavailable');

    const response = await DELETE(
      new NextRequest('https://www.crohns-buddy.com/api/auth/account', {
        method: 'DELETE',
      }),
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      message: 'The account could not be removed.',
    });
  });
});

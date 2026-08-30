// @vitest-environment node

import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  authenticateCognitoSession: vi.fn(),
}));

vi.mock('@/lib/server/cognitoAuth', () => ({
  AUTH_COOKIE_NAMES: {
    idToken: '__Host-cb-id-token',
    accessToken: '__Host-cb-access-token',
    refreshToken: '__Host-cb-refresh-token',
    oauthState: '__Host-cb-oauth-state',
    oauthVerifier: '__Host-cb-oauth-verifier',
    oauthReturnTo: '__Host-cb-oauth-return-to',
  },
  authenticateCognitoSession: mocks.authenticateCognitoSession,
}));

import { AUTH_COOKIE_NAMES } from '@/lib/server/cognitoAuth';
import { GET } from './route';

function sessionRequest(): NextRequest {
  return new NextRequest('https://www.crohns-buddy.com/api/auth/session');
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/auth/session', () => {
  it('returns the minimal account session and rotates refreshed cookies', async () => {
    mocks.authenticateCognitoSession.mockResolvedValue({
      ok: true,
      session: {
        identity: {
          userId: 'user-1',
          displayName: 'Ada Lovelace',
          email: 'ada@example.test',
          emailVerified: true,
          authTimeMs: 1_700_000_000_000,
        },
        accessToken: 'new-access-token',
        tokens: {
          idToken: 'new-id-token',
          accessToken: 'new-access-token',
          refreshToken: 'new-refresh-token',
          expiresIn: 3_600,
        },
      },
    });

    const response = await GET(sessionRequest());

    expect(mocks.authenticateCognitoSession).toHaveBeenCalledWith(
      expect.any(NextRequest),
      { allowRefresh: true },
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      authenticated: true,
      session: {
        userId: 'user-1',
        displayName: 'Ada Lovelace',
        email: 'ada@example.test',
        emailVerified: true,
        authTimeMs: 1_700_000_000_000,
        sessionStartedAtMs: 1_700_000_000_000,
      },
    });
    expect(response.cookies.get(AUTH_COOKIE_NAMES.idToken)?.value).toBe(
      'new-id-token',
    );
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('clears an invalid session without exposing a credential reason', async () => {
    mocks.authenticateCognitoSession.mockResolvedValue({
      ok: false,
      kind: 'invalid',
    });

    const response = await GET(sessionRequest());

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ authenticated: false });
    const setCookie = response.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain(`${AUTH_COOKIE_NAMES.idToken}=`);
    expect(setCookie).toContain('Max-Age=0');
  });

  it('preserves cookies during a temporary identity-service outage', async () => {
    mocks.authenticateCognitoSession.mockResolvedValue({
      ok: false,
      kind: 'unavailable',
    });

    const response = await GET(sessionRequest());

    expect(response.status).toBe(503);
    expect(response.headers.get('set-cookie')).toBeNull();
  });
});

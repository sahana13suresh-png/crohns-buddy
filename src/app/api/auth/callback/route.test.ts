// @vitest-environment node

import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  exchangeAuthorizationCode: vi.fn(),
  verifyCognitoTokenSet: vi.fn(),
  requestOrigin: vi.fn(() => 'https://www.crohns-buddy.com'),
}));

vi.mock('@/lib/server/cognitoAuth', () => {
  const cookieNames = {
    idToken: '__Host-cb-id-token',
    accessToken: '__Host-cb-access-token',
    refreshToken: '__Host-cb-refresh-token',
    passwordChallenge: '__Host-cb-password-challenge',
    oauthState: '__Host-cb-oauth-state',
    oauthVerifier: '__Host-cb-oauth-verifier',
    oauthReturnTo: '__Host-cb-oauth-return-to',
  } as const;

  return {
    AUTH_COOKIE_NAMES: cookieNames,
    exchangeAuthorizationCode: mocks.exchangeAuthorizationCode,
    verifyCognitoTokenSet: mocks.verifyCognitoTokenSet,
    requestOrigin: mocks.requestOrigin,
    safeReturnTo(value: string | null) {
      return value?.startsWith('/') && !value.startsWith('//') ? value : '/';
    },
    readCookieValue(request: Request, name: string) {
      const entries = (request.headers.get('cookie') ?? '').split(';');
      for (const entry of entries) {
        const separator = entry.indexOf('=');
        if (separator < 0 || entry.slice(0, separator).trim() !== name) continue;
        return decodeURIComponent(entry.slice(separator + 1).trim());
      }
      return null;
    },
  };
});

import { AUTH_COOKIE_NAMES } from '@/lib/server/cognitoAuth';
import { GET } from './route';

const TOKENS = {
  idToken: 'id-token',
  accessToken: 'access-token',
  refreshToken: 'refresh-token',
  expiresIn: 3_600,
};

function callbackRequest(query = 'code=code-1&state=state-1'): NextRequest {
  return new NextRequest(
    `https://www.crohns-buddy.com/api/auth/callback?${query}`,
    {
      headers: {
        cookie: [
          `${AUTH_COOKIE_NAMES.oauthState}=state-1`,
          `${AUTH_COOKIE_NAMES.oauthVerifier}=verifier-1`,
          `${AUTH_COOKIE_NAMES.oauthReturnTo}=${encodeURIComponent('/account?tab=security')}`,
        ].join('; '),
      },
    },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.exchangeAuthorizationCode.mockResolvedValue({ ok: true, tokens: TOKENS });
  mocks.verifyCognitoTokenSet.mockResolvedValue({
    ok: true,
    session: {
      identity: {
        userId: 'user-1',
        displayName: 'Ada',
        email: 'ada@example.test',
        emailVerified: true,
        authTimeMs: 1_700_000_000_000,
      },
      accessToken: TOKENS.accessToken,
      tokens: TOKENS,
    },
  });
});

describe('GET /api/auth/callback', () => {
  it('validates state, verifies the token set, and issues server-only session cookies', async () => {
    const response = await GET(callbackRequest());

    expect(mocks.exchangeAuthorizationCode).toHaveBeenCalledWith({
      code: 'code-1',
      codeVerifier: 'verifier-1',
      redirectUri: 'https://www.crohns-buddy.com/api/auth/callback',
    });
    expect(mocks.verifyCognitoTokenSet).toHaveBeenCalledWith(TOKENS, {
      requireFreshRevocationCheck: true,
    });
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(
      'https://www.crohns-buddy.com/account?tab=security',
    );
    expect(response.cookies.get(AUTH_COOKIE_NAMES.idToken)?.value).toBe('id-token');
    expect(response.cookies.get(AUTH_COOKIE_NAMES.accessToken)?.value).toBe(
      'access-token',
    );
    expect(response.cookies.get(AUTH_COOKIE_NAMES.refreshToken)?.value).toBe(
      'refresh-token',
    );
    const setCookie = response.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Secure');
    expect(setCookie).toContain(`${AUTH_COOKIE_NAMES.oauthState}=`);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('rejects a callback whose anti-CSRF state does not match', async () => {
    const response = await GET(callbackRequest('code=code-1&state=wrong-state'));

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toContain('/auth/error?reason=state');
    expect(mocks.exchangeAuthorizationCode).not.toHaveBeenCalled();
    expect(response.headers.get('set-cookie')).toContain(
      `${AUTH_COOKIE_NAMES.oauthState}=`,
    );
    expect(response.headers.get('set-cookie')).toContain(
      `${AUTH_COOKIE_NAMES.idToken}=`,
    );
    expect(response.headers.get('set-cookie')).toContain(
      `${AUTH_COOKIE_NAMES.accessToken}=`,
    );
  });

  it('uses the configured public origin for callback errors behind the hosting proxy', async () => {
    const response = await GET(
      new NextRequest(
        'http://localhost:3000/api/auth/callback?code=code-1&state=wrong-state',
        {
          headers: {
            host: 'localhost:3000',
            'x-forwarded-host': 'www.crohns-buddy.com',
            'x-forwarded-proto': 'https',
          },
        },
      ),
    );

    expect(response.headers.get('location')).toBe(
      'https://www.crohns-buddy.com/auth/error?reason=state',
    );
  });

  it('does not exchange a code after an identity-provider error', async () => {
    const response = await GET(
      callbackRequest('error=access_denied&state=state-1'),
    );

    expect(response.headers.get('location')).toContain(
      '/auth/error?reason=provider',
    );
    expect(mocks.exchangeAuthorizationCode).not.toHaveBeenCalled();
  });

  it('fails closed when the exchanged tokens cannot be verified', async () => {
    mocks.verifyCognitoTokenSet.mockResolvedValue({
      ok: false,
      kind: 'invalid',
    });

    const response = await GET(callbackRequest());

    expect(response.headers.get('location')).toContain(
      '/auth/error?reason=invalid',
    );
    expect(response.cookies.get(AUTH_COOKIE_NAMES.idToken)?.value).toBe('');
  });
});

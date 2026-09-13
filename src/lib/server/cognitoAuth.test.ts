// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AUTH_COOKIE_NAMES,
  deriveCognitoDisplayName,
  exchangeAuthorizationCode,
  readAuthCookies,
  readCognitoConfig,
  requestOrigin,
  resetCognitoAuthCaches,
  safeReturnTo,
} from './cognitoAuth';

const AUTH_ENV: Record<string, string> = {
  COGNITO_AWS_REGION: 'us-east-1',
  COGNITO_USER_POOL_ID: 'us-east-1_TestPool',
  COGNITO_CLIENT_ID: 'test-client-id',
  COGNITO_DOMAIN: 'https://crohns-buddy-test.auth.us-east-1.amazoncognito.com',
  AUTH_ALLOWED_ORIGINS:
    'https://www.crohns-buddy.com, https://www.crohns-buddy.com, http://127.0.0.1:3000',
  AUTH_SOCIAL_PROVIDERS: 'Google,Google',
};

const originalEnv = process.env;

beforeEach(() => {
  process.env = { ...originalEnv, ...AUTH_ENV };
});

afterEach(() => {
  resetCognitoAuthCaches();
  process.env = originalEnv;
  vi.unstubAllGlobals();
});

describe('Cognito server configuration', () => {
  it('normalizes origins and provider names without duplicating entries', () => {
    expect(readCognitoConfig()).toMatchObject({
      region: 'us-east-1',
      userPoolId: 'us-east-1_TestPool',
      clientId: 'test-client-id',
      domain: 'https://crohns-buddy-test.auth.us-east-1.amazoncognito.com',
      issuer:
        'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_TestPool',
      allowedOrigins: [
        'https://www.crohns-buddy.com',
        'http://127.0.0.1:3000',
      ],
      socialProviders: ['Google'],
    });
  });

  it('rejects a non-HTTPS Cognito domain', () => {
    process.env.COGNITO_DOMAIN = 'http://cognito.example.test';
    expect(() => readCognitoConfig()).toThrow(/HTTPS origin/);
  });

  it('accepts only authentication requests from configured origins', () => {
    expect(
      requestOrigin(
        new Request('https://www.crohns-buddy.com/api/auth/start'),
      ),
    ).toBe('https://www.crohns-buddy.com');
    expect(() =>
      requestOrigin(new Request('https://attacker.example/api/auth/start')),
    ).toThrow(/not allowed for authentication/);
  });

  it('uses an allow-listed forwarded host behind a trusted hosting proxy', () => {
    expect(
      requestOrigin(
        new Request('https://internal-compute.example/api/auth/start', {
          headers: {
            host: 'internal-compute.example',
            'x-forwarded-host': 'www.crohns-buddy.com',
            'x-forwarded-proto': 'https',
          },
        }),
      ),
    ).toBe('https://www.crohns-buddy.com');
  });
});

describe('Cognito request helpers', () => {
  it('keeps local paths and rejects absolute or protocol-relative return targets', () => {
    expect(safeReturnTo('/account?tab=security#delete')).toBe(
      '/account?tab=security#delete',
    );
    expect(safeReturnTo('//attacker.example/path')).toBe('/');
    expect(safeReturnTo('https://attacker.example/path')).toBe('/');
    expect(safeReturnTo(null)).toBe('/');
  });

  it('reads URL-encoded HttpOnly token cookie values from a request', () => {
    const request = new Request('https://www.crohns-buddy.com/api/auth/session', {
      headers: {
        cookie: [
          `${AUTH_COOKIE_NAMES.idToken}=id%2Etoken`,
          `${AUTH_COOKIE_NAMES.accessToken}=access%2Etoken`,
          `${AUTH_COOKIE_NAMES.refreshToken}=refresh%2Etoken`,
        ].join('; '),
      },
    });

    expect(readAuthCookies(request)).toEqual({
      idToken: 'id.token',
      accessToken: 'access.token',
      refreshToken: 'refresh.token',
    });
  });

  it('derives a bounded display name without requiring a profile name', () => {
    expect(
      deriveCognitoDisplayName({ name: '  Ada Lovelace  ', email: 'ada@example.test' }),
    ).toBe('Ada Lovelace');
    expect(deriveCognitoDisplayName({ email: 'grace.hopper@example.test' })).toBe(
      'grace.hopper',
    );
    expect(deriveCognitoDisplayName({ name: 'x'.repeat(80) })).toHaveLength(50);
  });
});

describe('OAuth token exchange', () => {
  it('uses authorization code plus PKCE and never sends an app-client secret', async () => {
    const fetchSpy = vi.fn(async (_url: string, init?: RequestInit) => {
      return new Response(
        JSON.stringify({
          id_token: 'id-token',
          access_token: 'access-token',
          refresh_token: 'refresh-token',
          expires_in: 3_600,
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    });
    vi.stubGlobal('fetch', fetchSpy);

    await expect(
      exchangeAuthorizationCode({
        code: 'authorization-code',
        codeVerifier: 'pkce-verifier',
        redirectUri: 'https://www.crohns-buddy.com/api/auth/callback',
      }),
    ).resolves.toEqual({
      ok: true,
      tokens: {
        idToken: 'id-token',
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        expiresIn: 3_600,
      },
    });

    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe(
      'https://crohns-buddy-test.auth.us-east-1.amazoncognito.com/oauth2/token',
    );
    expect(init?.method).toBe('POST');
    const body = new URLSearchParams(String(init?.body));
    expect(Object.fromEntries(body)).toEqual({
      grant_type: 'authorization_code',
      client_id: 'test-client-id',
      code: 'authorization-code',
      redirect_uri: 'https://www.crohns-buddy.com/api/auth/callback',
      code_verifier: 'pkce-verifier',
    });
    expect(String(init?.body)).not.toContain('client_secret');
  });

  it('classifies an upstream Cognito outage as retryable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 503 })),
    );

    await expect(
      exchangeAuthorizationCode({
        code: 'authorization-code',
        codeVerifier: 'pkce-verifier',
        redirectUri: 'https://www.crohns-buddy.com/api/auth/callback',
      }),
    ).resolves.toEqual({ ok: false, kind: 'unavailable' });
  });
});

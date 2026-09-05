// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  deriveLogtoDisplayName,
  exchangeLogtoAuthorizationCode,
  logtoLogoutUrl,
  readLogtoConfig,
  requestOriginForLogto,
} from './logtoAuth';

const originalEnv = process.env;

beforeEach(() => {
  process.env = {
    ...originalEnv,
    LOGTO_ENDPOINT: 'https://auth.crohns-buddy.com/',
    LOGTO_APP_ID: 'crohns-buddy-web',
    LOGTO_APP_SECRET: 'app-secret',
    AUTH_ALLOWED_ORIGINS:
      'https://www.crohns-buddy.com,https://www.crohns-buddy.com,not-an-origin',
    AUTH_SOCIAL_PROVIDERS: 'google,Facebook,google',
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
  process.env = originalEnv;
});

describe('Logto authentication configuration', () => {
  it('normalizes origins, issuer, and supported connector targets', () => {
    expect(readLogtoConfig()).toEqual({
      endpoint: 'https://auth.crohns-buddy.com',
      issuer: 'https://auth.crohns-buddy.com/oidc',
      clientId: 'crohns-buddy-web',
      clientSecret: 'app-secret',
      allowedOrigins: ['https://www.crohns-buddy.com'],
      socialProviders: ['google', 'facebook'],
    });
  });

  it('requires an HTTPS endpoint and application ID', () => {
    process.env.LOGTO_ENDPOINT = 'http://auth.crohns-buddy.com';
    expect(() => readLogtoConfig()).toThrow(/HTTPS origin/);

    process.env.LOGTO_ENDPOINT = 'https://auth.crohns-buddy.com';
    delete process.env.LOGTO_APP_ID;
    expect(() => readLogtoConfig()).toThrow(/LOGTO_APP_ID/);
  });

  it('derives a bounded display name without exposing infrastructure details', () => {
    expect(
      deriveLogtoDisplayName({
        email: 'patient@example.com',
        name: '  Avery Patient  ',
      }),
    ).toBe('Avery Patient');
    expect(deriveLogtoDisplayName({ email: 'patient@example.com' })).toBe(
      'patient',
    );
  });

  it('accepts only an explicitly allowed request origin', () => {
    expect(
      requestOriginForLogto(
        new Request('https://internal-amplify-host/api/auth/start', {
          headers: {
            host: 'internal-amplify-host',
            'x-forwarded-host': 'www.crohns-buddy.com',
            'x-forwarded-proto': 'https',
          },
        }),
      ),
    ).toBe('https://www.crohns-buddy.com');

    expect(() =>
      requestOriginForLogto(
        new Request('https://attacker.example/api/auth/start'),
      ),
    ).toThrow(/not allowed/);
  });

  it('builds a provider logout URL that returns to the application', () => {
    const logout = new URL(logtoLogoutUrl('https://www.crohns-buddy.com'));
    expect(logout.pathname).toBe('/oidc/session/end');
    expect(logout.searchParams.get('client_id')).toBe('crohns-buddy-web');
    expect(logout.searchParams.get('post_logout_redirect_uri')).toBe(
      'https://www.crohns-buddy.com/',
    );
  });

  it('authenticates authorization-code exchanges as the confidential web app', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id_token: 'id-token',
          access_token: 'access-token',
          refresh_token: 'refresh-token',
          expires_in: 3600,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      exchangeLogtoAuthorizationCode({
        code: 'authorization-code',
        codeVerifier: 'pkce-verifier',
        redirectUri: 'https://www.crohns-buddy.com/api/auth/callback',
      }),
    ).resolves.toMatchObject({ ok: true });

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = new URLSearchParams(String(request.body));
    expect(body.get('client_id')).toBe('crohns-buddy-web');
    expect(body.get('client_secret')).toBe('app-secret');
    expect(body.get('code_verifier')).toBe('pkce-verifier');
  });
});

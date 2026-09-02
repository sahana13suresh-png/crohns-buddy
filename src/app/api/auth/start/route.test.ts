// @vitest-environment node

import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AUTH_COOKIE_NAMES } from '@/lib/server/cognitoAuth';
import { GET } from './route';

const originalEnv = process.env;

beforeEach(() => {
  process.env = {
    ...originalEnv,
    COGNITO_AWS_REGION: 'us-east-1',
    COGNITO_USER_POOL_ID: 'us-east-1_TestPool',
    COGNITO_CLIENT_ID: 'test-client-id',
    COGNITO_DOMAIN: 'https://crohns-buddy-test.auth.us-east-1.amazoncognito.com',
    AUTH_ALLOWED_ORIGINS: 'https://www.crohns-buddy.com',
    AUTH_SOCIAL_PROVIDERS: 'Google',
    AUTH_SELF_REGISTRATION_ENABLED: 'false',
  };
});

afterEach(() => {
  process.env = originalEnv;
});

describe('GET /api/auth/start', () => {
  it('blocks native account creation when self-registration is disabled', async () => {
    const response = GET(
      new NextRequest(
        'https://www.crohns-buddy.com/api/auth/start?intent=signup&returnTo=%2Faccount%3Ftab%3Dsecurity',
      ),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      message: 'Self-registration is disabled.',
    });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('location')).toBeNull();
  });

  it('retains native account creation behind an explicit deployment gate', () => {
    process.env.AUTH_SELF_REGISTRATION_ENABLED = 'true';
    const response = GET(
      new NextRequest(
        'https://www.crohns-buddy.com/api/auth/start?intent=signup&returnTo=%2Faccount%3Ftab%3Dsecurity',
      ),
    );

    expect(response.status).toBe(307);
    const location = new URL(response.headers.get('location')!);
    expect(location.origin).toBe(
      'https://crohns-buddy-test.auth.us-east-1.amazoncognito.com',
    );
    expect(location.pathname).toBe('/signup');
    expect(location.searchParams.get('client_id')).toBe('test-client-id');
    expect(location.searchParams.get('response_type')).toBe('code');
    expect(location.searchParams.get('code_challenge_method')).toBe('S256');
    expect(location.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(location.searchParams.get('state')).toHaveLength(43);

    expect(response.cookies.get(AUTH_COOKIE_NAMES.oauthState)?.value).toHaveLength(43);
    expect(response.cookies.get(AUTH_COOKIE_NAMES.oauthVerifier)?.value).toHaveLength(86);
    expect(response.cookies.get(AUTH_COOKIE_NAMES.oauthReturnTo)?.value).toBe(
      '/account?tab=security',
    );
    const setCookie = response.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Secure');
    expect(setCookie).toContain('SameSite=lax');
    expect(setCookie).toContain('Path=/');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('sends an enabled social provider through the authorization endpoint', () => {
    const response = GET(
      new NextRequest(
        'https://www.crohns-buddy.com/api/auth/start?provider=google&returnTo=%2F',
      ),
    );

    const location = new URL(response.headers.get('location')!);
    expect(location.pathname).toBe('/oauth2/authorize');
    expect(location.searchParams.get('identity_provider')).toBe('Google');
  });

  it.each(['Facebook', 'LoginWithAmazon', 'SignInWithApple'])(
    'preserves the Cognito provider identifier for %s',
    (provider) => {
      process.env.AUTH_SOCIAL_PROVIDERS = provider;
      const response = GET(
        new NextRequest(
          `https://www.crohns-buddy.com/api/auth/start?provider=${provider}`,
        ),
      );

      const location = new URL(response.headers.get('location')!);
      expect(location.pathname).toBe('/oauth2/authorize');
      expect(location.searchParams.get('identity_provider')).toBe(provider);
    },
  );

  it('rejects a provider that is not enabled for this deployment', async () => {
    const response = GET(
      new NextRequest(
        'https://www.crohns-buddy.com/api/auth/start?provider=Facebook',
      ),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      message: 'That sign-in provider is not enabled.',
    });
  });

  it('does not construct redirects for an untrusted request origin', () => {
    const response = GET(
      new NextRequest('https://attacker.example/api/auth/start'),
    );

    expect(response.status).toBe(503);
    expect(response.headers.get('location')).toBeNull();
  });

  it('starts Logto registration on its dedicated first screen', () => {
    process.env.AUTH_PROVIDER = 'logto';
    process.env.LOGTO_ENDPOINT = 'https://auth.crohns-buddy.com';
    process.env.LOGTO_APP_ID = 'crohns-buddy-web';
    process.env.AUTH_SOCIAL_PROVIDERS = 'google,facebook,amazon,apple';

    const response = GET(
      new NextRequest(
        'https://www.crohns-buddy.com/api/auth/start?intent=signup&loginHint=patient%40example.com&returnTo=%2Faccount',
      ),
    );

    expect(response.status).toBe(307);
    const location = new URL(response.headers.get('location')!);
    expect(location.origin).toBe('https://auth.crohns-buddy.com');
    expect(location.pathname).toBe('/oidc/auth');
    expect(location.searchParams.get('client_id')).toBe('crohns-buddy-web');
    expect(location.searchParams.get('first_screen')).toBe('register');
    expect(location.searchParams.get('login_hint')).toBe('patient@example.com');
    expect(location.searchParams.get('scope')).toContain('offline_access');
    expect(response.cookies.get(AUTH_COOKIE_NAMES.oauthReturnTo)?.value).toBe(
      '/account',
    );
  });

  it('uses Logto direct social sign-in only for an enabled connector', async () => {
    process.env.AUTH_PROVIDER = 'logto';
    process.env.LOGTO_ENDPOINT = 'https://auth.crohns-buddy.com';
    process.env.LOGTO_APP_ID = 'crohns-buddy-web';
    process.env.AUTH_SOCIAL_PROVIDERS = 'google,facebook,amazon,apple';

    const response = GET(
      new NextRequest(
        'https://www.crohns-buddy.com/api/auth/start?intent=signup&provider=LoginWithAmazon',
      ),
    );
    const location = new URL(response.headers.get('location')!);

    expect(location.searchParams.get('first_screen')).toBe('register');
    expect(location.searchParams.get('direct_sign_in')).toBe('social:amazon');

    process.env.AUTH_SOCIAL_PROVIDERS = 'google';
    const blocked = GET(
      new NextRequest(
        'https://www.crohns-buddy.com/api/auth/start?provider=Facebook',
      ),
    );
    expect(blocked.status).toBe(400);
    await expect(blocked.json()).resolves.toEqual({
      message: 'That sign-in provider is not enabled.',
    });
  });
});

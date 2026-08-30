import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  verifyCognitoTokenSet: vi.fn(),
  signUpWithPassword: vi.fn(),
  confirmPasswordSignUp: vi.fn(),
  resendPasswordSignUpCode: vi.fn(),
  signInWithPassword: vi.fn(),
  completePasswordMfa: vi.fn(),
  beginPasswordReset: vi.fn(),
  completePasswordReset: vi.fn(),
}));

vi.mock('@/lib/server/cognitoAuth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/server/cognitoAuth')>();
  return { ...actual, verifyCognitoTokenSet: mocks.verifyCognitoTokenSet };
});

vi.mock('@/lib/server/cognitoPasswordAuth', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/server/cognitoPasswordAuth')>();
  return {
    ...actual,
    signUpWithPassword: mocks.signUpWithPassword,
    confirmPasswordSignUp: mocks.confirmPasswordSignUp,
    resendPasswordSignUpCode: mocks.resendPasswordSignUpCode,
    signInWithPassword: mocks.signInWithPassword,
    completePasswordMfa: mocks.completePasswordMfa,
    beginPasswordReset: mocks.beginPasswordReset,
    completePasswordReset: mocks.completePasswordReset,
  };
});

import { POST } from './route';

const TOKENS = {
  idToken: 'id-token',
  accessToken: 'access-token',
  refreshToken: 'refresh-token',
  expiresIn: 3600,
};

function request(
  body: Record<string, unknown>,
  origin = 'https://example.test',
): NextRequest {
  return new NextRequest('https://example.test/api/auth/password', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin,
      host: 'example.test',
      'sec-fetch-site': origin === 'https://example.test' ? 'same-origin' : 'cross-site',
    },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.verifyCognitoTokenSet.mockResolvedValue({
    ok: true,
    session: {
      identity: {
        userId: 'user-1',
        email: 'patient@example.com',
        displayName: 'Patient',
        emailVerified: true,
        authTimeMs: 1,
      },
      accessToken: 'access-token',
    },
  });
});

describe('POST /api/auth/password', () => {
  it('starts signup without returning or storing the submitted password', async () => {
    mocks.signUpWithPassword.mockResolvedValue({ step: 'confirm-signup' });

    const response = await POST(
      request({
        action: 'signup',
        email: 'patient@example.com',
        password: 'Strong!Password1',
        displayName: 'Patient',
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ step: 'confirm-signup' });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(mocks.signUpWithPassword).toHaveBeenCalledWith({
      email: 'patient@example.com',
      password: 'Strong!Password1',
      displayName: 'Patient',
    });
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('sets Secure HttpOnly session cookies after verified login', async () => {
    mocks.signInWithPassword.mockResolvedValue({ step: 'done', tokens: TOKENS });

    const response = await POST(
      request({
        action: 'signin',
        email: 'patient@example.com',
        password: 'Strong!Password1',
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ step: 'done' });
    const setCookie = response.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('__Host-cb-id-token=id-token');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Secure');
    expect(setCookie).toContain('SameSite=lax');
  });

  it('stores only the opaque MFA challenge in a short-lived HttpOnly cookie', async () => {
    mocks.signInWithPassword.mockResolvedValue({
      step: 'mfa',
      challenge: {
        challengeName: 'SOFTWARE_TOKEN_MFA',
        session: 'opaque-session',
        username: 'patient@example.com',
      },
    });

    const response = await POST(
      request({
        action: 'signin',
        email: 'patient@example.com',
        password: 'Strong!Password1',
      }),
    );

    expect(await response.json()).toEqual({
      step: 'mfa',
      method: 'authenticator',
    });
    const setCookie = response.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('__Host-cb-password-challenge=');
    expect(setCookie).toContain('Max-Age=300');
    expect(setCookie).not.toContain('Strong!Password1');
  });

  it('rejects cross-site account requests before reading credentials', async () => {
    const response = await POST(
      request(
        {
          action: 'signin',
          email: 'patient@example.com',
          password: 'Strong!Password1',
        },
        'https://attacker.example',
      ),
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ code: 'invalid-input' });
    expect(mocks.signInWithPassword).not.toHaveBeenCalled();
  });

  it('requires JSON requests', async () => {
    const invalid = new NextRequest(
      'https://example.test/api/auth/password',
      {
        method: 'POST',
        headers: {
          'content-type': 'text/plain',
          origin: 'https://example.test',
          host: 'example.test',
        },
        body: 'action=signin',
      },
    );

    const response = await POST(invalid);
    expect(response.status).toBe(415);
    expect(await response.json()).toEqual({ code: 'invalid-input' });
  });
});

import { type NextResponse } from 'next/server';

import {
  AUTH_COOKIE_NAMES,
  type CognitoTokenSet,
} from './cognitoAuth';
import type { AuthChallenge } from './cognitoPasswordAuth';

const BASE_OPTIONS = {
  httpOnly: true,
  secure: true,
  sameSite: 'lax' as const,
  path: '/',
};

const THIRTY_DAYS_SECONDS = 30 * 24 * 60 * 60;
const FIVE_MINUTES_SECONDS = 5 * 60;

export function setAuthCookies(response: NextResponse, tokens: CognitoTokenSet): void {
  response.cookies.set(AUTH_COOKIE_NAMES.idToken, tokens.idToken, {
    ...BASE_OPTIONS,
    maxAge: tokens.expiresIn,
  });
  response.cookies.set(AUTH_COOKIE_NAMES.accessToken, tokens.accessToken, {
    ...BASE_OPTIONS,
    maxAge: tokens.expiresIn,
  });
  if (tokens.refreshToken) {
    response.cookies.set(AUTH_COOKIE_NAMES.refreshToken, tokens.refreshToken, {
      ...BASE_OPTIONS,
      maxAge: THIRTY_DAYS_SECONDS,
    });
  }
}

export function setOAuthCookies(
  response: NextResponse,
  values: { state: string; verifier: string; returnTo: string },
): void {
  const options = { ...BASE_OPTIONS, maxAge: 10 * 60 };
  response.cookies.set(AUTH_COOKIE_NAMES.oauthState, values.state, options);
  response.cookies.set(AUTH_COOKIE_NAMES.oauthVerifier, values.verifier, options);
  response.cookies.set(AUTH_COOKIE_NAMES.oauthReturnTo, values.returnTo, options);
}

export function setPasswordChallengeCookie(
  response: NextResponse,
  challenge: AuthChallenge,
): void {
  response.cookies.set(
    AUTH_COOKIE_NAMES.passwordChallenge,
    Buffer.from(JSON.stringify(challenge)).toString('base64url'),
    { ...BASE_OPTIONS, maxAge: FIVE_MINUTES_SECONDS },
  );
}

export function readPasswordChallengeCookie(request: Request): AuthChallenge | null {
  const cookie = request.headers.get('cookie');
  if (!cookie) return null;
  const prefix = `${AUTH_COOKIE_NAMES.passwordChallenge}=`;
  const encoded = cookie
    .split(';')
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith(prefix))
    ?.slice(prefix.length);
  if (!encoded || encoded.length > 6_000) return null;
  try {
    const value: unknown = JSON.parse(
      Buffer.from(decodeURIComponent(encoded), 'base64url').toString('utf8'),
    );
    if (value === null || typeof value !== 'object') return null;
    const candidate = value as Partial<AuthChallenge>;
    if (
      (candidate.challengeName !== 'SOFTWARE_TOKEN_MFA' &&
        candidate.challengeName !== 'SMS_MFA') ||
      typeof candidate.session !== 'string' ||
      candidate.session.length === 0 ||
      typeof candidate.username !== 'string' ||
      candidate.username.length === 0
    ) {
      return null;
    }
    return candidate as AuthChallenge;
  } catch {
    return null;
  }
}

function clearCookie(response: NextResponse, name: string): void {
  response.cookies.set(name, '', { ...BASE_OPTIONS, maxAge: 0 });
}

export function clearPasswordChallengeCookie(response: NextResponse): void {
  clearCookie(response, AUTH_COOKIE_NAMES.passwordChallenge);
}

export function clearOAuthCookies(response: NextResponse): void {
  clearCookie(response, AUTH_COOKIE_NAMES.oauthState);
  clearCookie(response, AUTH_COOKIE_NAMES.oauthVerifier);
  clearCookie(response, AUTH_COOKIE_NAMES.oauthReturnTo);
}

export function clearAuthCookies(response: NextResponse): void {
  clearCookie(response, AUTH_COOKIE_NAMES.idToken);
  clearCookie(response, AUTH_COOKIE_NAMES.accessToken);
  clearCookie(response, AUTH_COOKIE_NAMES.refreshToken);
  clearPasswordChallengeCookie(response);
}

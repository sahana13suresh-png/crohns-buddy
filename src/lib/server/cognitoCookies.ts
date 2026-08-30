import { type NextResponse } from 'next/server';

import {
  AUTH_COOKIE_NAMES,
  type CognitoTokenSet,
} from './cognitoAuth';

const BASE_OPTIONS = {
  httpOnly: true,
  secure: true,
  sameSite: 'lax' as const,
  path: '/',
};

const THIRTY_DAYS_SECONDS = 30 * 24 * 60 * 60;

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

function clearCookie(response: NextResponse, name: string): void {
  response.cookies.set(name, '', { ...BASE_OPTIONS, maxAge: 0 });
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
}


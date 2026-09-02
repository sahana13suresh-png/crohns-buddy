import { NextRequest, NextResponse } from 'next/server';

import {
  AUTH_COOKIE_NAMES,
  exchangeAuthorizationCode,
  readCookieValue,
  requestOrigin,
  safeReturnTo,
  verifyCognitoTokenSet,
} from '@/lib/server/cognitoAuth';
import { configuredAuthProvider } from '@/lib/server/authProvider';
import {
  clearOAuthCookies,
  setAuthCookies,
} from '@/lib/server/cognitoCookies';
import {
  exchangeLogtoAuthorizationCode,
  requestOriginForLogto,
  verifyLogtoTokenSet,
} from '@/lib/server/logtoAuth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function errorRedirect(request: NextRequest, reason: string): NextResponse {
  const response = NextResponse.redirect(
    new URL(`/auth/error?reason=${encodeURIComponent(reason)}`, request.url),
  );
  response.headers.set('Cache-Control', 'no-store');
  clearOAuthCookies(response);
  return response;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const returnedState = request.nextUrl.searchParams.get('state');
  const expectedState = readCookieValue(request, AUTH_COOKIE_NAMES.oauthState);
  const verifier = readCookieValue(request, AUTH_COOKIE_NAMES.oauthVerifier);
  const returnTo = safeReturnTo(
    readCookieValue(request, AUTH_COOKIE_NAMES.oauthReturnTo),
  );

  if (request.nextUrl.searchParams.has('error')) {
    return errorRedirect(request, 'provider');
  }
  if (!returnedState || !expectedState || returnedState !== expectedState || !verifier) {
    return errorRedirect(request, 'state');
  }

  const code = request.nextUrl.searchParams.get('code');
  if (!code) return errorRedirect(request, 'code');

  try {
    const isLogto = configuredAuthProvider() === 'logto';
    const origin = isLogto
      ? requestOriginForLogto(request)
      : requestOrigin(request);
    const exchanged = await (isLogto
      ? exchangeLogtoAuthorizationCode({
          code,
          codeVerifier: verifier,
          redirectUri: `${origin}/api/auth/callback`,
        })
      : exchangeAuthorizationCode({
          code,
          codeVerifier: verifier,
          redirectUri: `${origin}/api/auth/callback`,
        }));
    if (!exchanged.ok) return errorRedirect(request, exchanged.kind);

    const verified = await (isLogto
      ? verifyLogtoTokenSet(exchanged.tokens, {
          requireFreshRevocationCheck: true,
        })
      : verifyCognitoTokenSet(exchanged.tokens, {
          requireFreshRevocationCheck: true,
        }));
    if (!verified.ok) return errorRedirect(request, verified.kind);

    const response = NextResponse.redirect(new URL(returnTo, origin));
    response.headers.set('Cache-Control', 'no-store');
    setAuthCookies(response, exchanged.tokens);
    clearOAuthCookies(response);
    return response;
  } catch {
    return errorRedirect(request, 'unavailable');
  }
}

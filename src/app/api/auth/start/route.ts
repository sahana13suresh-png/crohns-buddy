import { createHash, randomBytes } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';

import {
  isSelfRegistrationEnabled,
  readCognitoConfig,
  requestOrigin,
  safeReturnTo,
} from '@/lib/server/cognitoAuth';
import { setOAuthCookies } from '@/lib/server/cognitoCookies';
import { configuredAuthProvider } from '@/lib/server/authProvider';
import {
  readLogtoConfig,
  requestOriginForLogto,
} from '@/lib/server/logtoAuth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function base64Url(bytes: Buffer): string {
  return bytes.toString('base64url');
}

export function GET(request: NextRequest): NextResponse {
  try {
    if (configuredAuthProvider() === 'logto') {
      return startLogto(request);
    }
    const config = readCognitoConfig();
    const origin = requestOrigin(request);
    const returnTo = safeReturnTo(request.nextUrl.searchParams.get('returnTo'));
    const intent = request.nextUrl.searchParams.get('intent');
    if (intent === 'signup' && !isSelfRegistrationEnabled()) {
      return NextResponse.json(
        { message: 'Self-registration is disabled.' },
        { status: 403, headers: { 'Cache-Control': 'no-store' } },
      );
    }
    const providerRequest = request.nextUrl.searchParams.get('provider')?.trim() ?? '';
    const provider = config.socialProviders.find(
      (candidate) => candidate.toLowerCase() === providerRequest.toLowerCase(),
    );
    if (providerRequest && !provider) {
      return NextResponse.json({ message: 'That sign-in provider is not enabled.' }, { status: 400 });
    }

    const state = base64Url(randomBytes(32));
    const verifier = base64Url(randomBytes(64));
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const redirectUri = `${origin}/api/auth/callback`;

    const authorizationPath = intent === 'signup' && !provider
      ? '/signup'
      : '/oauth2/authorize';
    const authorizationUrl = new URL(authorizationPath, config.domain);
    authorizationUrl.search = new URLSearchParams({
      client_id: config.clientId,
      response_type: 'code',
      scope: 'openid email profile aws.cognito.signin.user.admin',
      redirect_uri: redirectUri,
      state,
      code_challenge_method: 'S256',
      code_challenge: challenge,
    }).toString();

    if (provider) {
      authorizationUrl.searchParams.set('identity_provider', provider);
    }
    if (request.nextUrl.searchParams.get('prompt') === 'login') {
      authorizationUrl.searchParams.set('prompt', 'login');
    }

    const response = NextResponse.redirect(authorizationUrl);
    response.headers.set('Cache-Control', 'no-store');
    setOAuthCookies(response, { state, verifier, returnTo });
    return response;
  } catch {
    return NextResponse.json(
      { message: 'Account sign-in is temporarily unavailable.' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}

const LOGTO_PROVIDER_TARGETS: Record<string, string> = {
  google: 'google',
  facebook: 'facebook',
  loginwithamazon: 'amazon',
  amazon: 'amazon',
  signinwithapple: 'apple',
  apple: 'apple',
};

// Logto 1.43 only includes the OIDC auth_time claim when max_age is requested.
// The callback verifier needs that original authentication time for the
// application's reauthentication window; a one-day age also avoids silently
// reusing an old Logto session indefinitely.
const LOGTO_MAX_AUTH_AGE_SECONDS = 24 * 60 * 60;

function startLogto(request: NextRequest): NextResponse {
  const config = readLogtoConfig();
  const origin = requestOriginForLogto(request);
  const returnTo = safeReturnTo(request.nextUrl.searchParams.get('returnTo'));
  const intent = request.nextUrl.searchParams.get('intent');
  const providerRequest =
    request.nextUrl.searchParams.get('provider')?.trim().toLowerCase() ?? '';
  const providerTarget = providerRequest
    ? LOGTO_PROVIDER_TARGETS[providerRequest]
    : undefined;
  if (
    providerRequest &&
    (!providerTarget || !config.socialProviders.includes(providerTarget))
  ) {
    return NextResponse.json(
      { message: 'That sign-in provider is not enabled.' },
      { status: 400, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  const state = base64Url(randomBytes(32));
  const verifier = base64Url(randomBytes(64));
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const redirectUri = `${origin}/api/auth/callback`;
  const authorizationUrl = new URL(`${config.issuer}/auth`);
  authorizationUrl.search = new URLSearchParams({
    client_id: config.clientId,
    response_type: 'code',
    scope: 'openid offline_access profile email',
    max_age: String(LOGTO_MAX_AUTH_AGE_SECONDS),
    redirect_uri: redirectUri,
    state,
    code_challenge_method: 'S256',
    code_challenge: challenge,
  }).toString();

  const loginHint = request.nextUrl.searchParams.get('loginHint')?.trim();
  if (loginHint) authorizationUrl.searchParams.set('login_hint', loginHint);
  if (providerTarget) {
    authorizationUrl.searchParams.set(
      'direct_sign_in',
      `social:${providerTarget}`,
    );
  } else {
    authorizationUrl.searchParams.set(
      'first_screen',
      intent === 'signup'
        ? 'register'
        : intent === 'recovery'
          ? 'reset_password'
          : 'sign_in',
    );
  }
  // Registration must never silently reuse an existing Logto session. A stale
  // session can otherwise complete the authorization request as an old user
  // instead of presenting a fresh registration flow.
  if (
    intent === 'signup' ||
    request.nextUrl.searchParams.get('prompt') === 'login'
  ) {
    authorizationUrl.searchParams.set('prompt', 'login');
  }

  const response = NextResponse.redirect(authorizationUrl);
  response.headers.set('Cache-Control', 'no-store');
  setOAuthCookies(response, { state, verifier, returnTo });
  return response;
}

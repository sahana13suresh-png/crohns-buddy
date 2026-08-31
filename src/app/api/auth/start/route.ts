import { createHash, randomBytes } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';

import {
  isSelfRegistrationEnabled,
  readCognitoConfig,
  requestOrigin,
  safeReturnTo,
} from '@/lib/server/cognitoAuth';
import { setOAuthCookies } from '@/lib/server/cognitoCookies';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function base64Url(bytes: Buffer): string {
  return bytes.toString('base64url');
}

export function GET(request: NextRequest): NextResponse {
  try {
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

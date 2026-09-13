import { NextRequest, NextResponse } from 'next/server';

import {
  assertSameOriginRequest,
  isSelfRegistrationEnabled,
  verifyCognitoTokenSet,
  type CognitoTokenSet,
} from '@/lib/server/cognitoAuth';
import {
  clearPasswordChallengeCookie,
  readPasswordChallengeCookie,
  setAuthCookies,
  setPasswordChallengeCookie,
} from '@/lib/server/cognitoCookies';
import {
  beginPasswordReset,
  completePasswordMfa,
  completePasswordReset,
  confirmPasswordSignUp,
  PasswordAuthError,
  resendPasswordSignUpCode,
  signInWithPassword,
  signUpWithPassword,
} from '@/lib/server/cognitoPasswordAuth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_REQUEST_BODY_CHARS = 4_096;

type RequestBody = Record<string, unknown> & { action?: unknown };

function json(
  body: Record<string, unknown>,
  init: { status?: number } = {},
): NextResponse {
  return NextResponse.json(body, {
    ...init,
    headers: { 'Cache-Control': 'no-store' },
  });
}

async function readBody(request: NextRequest): Promise<RequestBody> {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
    throw new PasswordAuthError('invalid-input', 415);
  }
  const text = await request.text();
  if (text.length === 0 || text.length > MAX_REQUEST_BODY_CHARS) {
    throw new PasswordAuthError('invalid-input', 400);
  }
  const parsed: unknown = JSON.parse(text);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new PasswordAuthError('invalid-input', 400);
  }
  return parsed as RequestBody;
}

async function authenticatedResponse(tokens: CognitoTokenSet): Promise<NextResponse> {
  const verified = await verifyCognitoTokenSet(tokens, {
    requireFreshRevocationCheck: true,
  });
  if (!verified.ok) {
    throw new PasswordAuthError(
      verified.kind === 'unavailable' ? 'unavailable' : 'invalid-credentials',
      verified.kind === 'unavailable' ? 503 : 401,
    );
  }
  const response = json({ step: 'done' });
  setAuthCookies(response, tokens);
  clearPasswordChallengeCookie(response);
  return response;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    assertSameOriginRequest(request);
  } catch {
    return json({ code: 'invalid-input' }, { status: 403 });
  }

  try {
    const body = await readBody(request);
    switch (body.action) {
      case 'signup': {
        if (!isSelfRegistrationEnabled()) {
          return json(
            { code: 'self-registration-disabled' },
            { status: 403 },
          );
        }
        const result = await signUpWithPassword({
          email: body.email,
          password: body.password,
          displayName: body.displayName,
        });
        return json(result);
      }
      case 'confirm-signup':
        if (!isSelfRegistrationEnabled()) {
          return json(
            { code: 'self-registration-disabled' },
            { status: 403 },
          );
        }
        await confirmPasswordSignUp({ email: body.email, code: body.code });
        return json({ step: 'sign-in' });
      case 'resend-signup':
        if (!isSelfRegistrationEnabled()) {
          return json(
            { code: 'self-registration-disabled' },
            { status: 403 },
          );
        }
        await resendPasswordSignUpCode(body.email);
        return json({ step: 'confirm-signup' });
      case 'signin': {
        const result = await signInWithPassword({
          email: body.email,
          password: body.password,
        });
        if (result.step === 'done') return authenticatedResponse(result.tokens);
        const response = json({
          step: 'mfa',
          method:
            result.challenge.challengeName === 'SOFTWARE_TOKEN_MFA'
              ? 'authenticator'
              : 'sms',
        });
        setPasswordChallengeCookie(response, result.challenge);
        return response;
      }
      case 'mfa': {
        const challenge = readPasswordChallengeCookie(request);
        if (!challenge) throw new PasswordAuthError('invalid-code', 400);
        return authenticatedResponse(await completePasswordMfa(challenge, body.code));
      }
      case 'forgot-password':
        await beginPasswordReset(body.email);
        return json({ step: 'reset-password' });
      case 'reset-password':
        await completePasswordReset({
          email: body.email,
          code: body.code,
          password: body.password,
        });
        return json({ step: 'sign-in' });
      default:
        throw new PasswordAuthError('invalid-input', 400);
    }
  } catch (error: unknown) {
    if (error instanceof SyntaxError) {
      return json({ code: 'invalid-input' }, { status: 400 });
    }
    if (error instanceof PasswordAuthError) {
      return json({ code: error.code }, { status: error.status });
    }
    return json({ code: 'unavailable' }, { status: 503 });
  }
}

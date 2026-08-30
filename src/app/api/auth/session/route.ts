import { NextRequest, NextResponse } from 'next/server';

import { authenticateCognitoSession } from '@/lib/server/cognitoAuth';
import {
  clearAuthCookies,
  setAuthCookies,
} from '@/lib/server/cognitoCookies';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const result = await authenticateCognitoSession(request, { allowRefresh: true });
    if (!result.ok) {
      const response = NextResponse.json(
        { authenticated: false },
        {
          status: result.kind === 'unavailable' ? 503 : 401,
          headers: { 'Cache-Control': 'no-store' },
        },
      );
      if (result.kind !== 'unavailable') clearAuthCookies(response);
      return response;
    }

    const response = NextResponse.json(
      {
        authenticated: true,
        session: {
          userId: result.session.identity.userId,
          displayName: result.session.identity.displayName,
          email: result.session.identity.email,
          emailVerified: result.session.identity.emailVerified,
          authTimeMs: result.session.identity.authTimeMs,
          sessionStartedAtMs: result.session.identity.authTimeMs,
        },
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
    if (result.session.tokens) setAuthCookies(response, result.session.tokens);
    return response;
  } catch {
    return NextResponse.json(
      { authenticated: false },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}


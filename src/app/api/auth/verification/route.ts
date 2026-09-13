import { GetUserAttributeVerificationCodeCommand } from '@aws-sdk/client-cognito-identity-provider';
import { NextRequest, NextResponse } from 'next/server';

import {
  authenticateCognitoSession,
  cognitoClientForRegion,
  readCognitoConfig,
} from '@/lib/server/cognitoAuth';
import { setAuthCookies } from '@/lib/server/cognitoCookies';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const result = await authenticateCognitoSession(request, {
      allowRefresh: true,
      requireFreshRevocationCheck: true,
    });
    if (!result.ok) {
      return NextResponse.json(
        { message: 'Authentication is required.' },
        { status: result.kind === 'unavailable' ? 503 : 401 },
      );
    }

    const config = readCognitoConfig();
    await cognitoClientForRegion(config.region).send(
      new GetUserAttributeVerificationCodeCommand({
        AccessToken: result.session.accessToken,
        AttributeName: 'email',
      }),
    );
    const response = new NextResponse(null, { status: 204 });
    if (result.session.tokens) setAuthCookies(response, result.session.tokens);
    return response;
  } catch {
    return NextResponse.json(
      { message: 'A verification message could not be sent.' },
      { status: 503 },
    );
  }
}


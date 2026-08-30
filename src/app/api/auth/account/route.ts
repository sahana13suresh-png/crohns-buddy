import { DeleteUserCommand } from '@aws-sdk/client-cognito-identity-provider';
import { NextRequest, NextResponse } from 'next/server';

import {
  authenticateCognitoSession,
  cognitoClientForRegion,
  readCognitoConfig,
} from '@/lib/server/cognitoAuth';
import { clearAuthCookies } from '@/lib/server/cognitoCookies';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function DELETE(request: NextRequest): Promise<NextResponse> {
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
      new DeleteUserCommand({ AccessToken: result.session.accessToken }),
    );
    const response = new NextResponse(null, { status: 204 });
    clearAuthCookies(response);
    return response;
  } catch {
    return NextResponse.json(
      { message: 'The account could not be removed.' },
      { status: 503 },
    );
  }
}


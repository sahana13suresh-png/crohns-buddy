import { RevokeTokenCommand } from '@aws-sdk/client-cognito-identity-provider';
import { NextRequest, NextResponse } from 'next/server';

import {
  cognitoClientForRegion,
  readAuthCookies,
  readCognitoConfig,
  requestOrigin,
} from '@/lib/server/cognitoAuth';
import { clearAuthCookies, clearOAuthCookies } from '@/lib/server/cognitoCookies';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function revokeRefreshToken(request: NextRequest): Promise<void> {
  const config = readCognitoConfig();
  const refreshToken = readAuthCookies(request).refreshToken;
  if (!refreshToken) return;
  try {
    await cognitoClientForRegion(config.region).send(
      new RevokeTokenCommand({
        ClientId: config.clientId,
        Token: refreshToken,
      }),
    );
  } catch {
    // Local cookies are still cleared. Revocation is best-effort because the
    // refresh token may already be expired or revoked.
  }
}

function managedLogoutUrl(request: NextRequest): string {
  const config = readCognitoConfig();
  const origin = requestOrigin(request);
  const url = new URL('/logout', config.domain);
  url.search = new URLSearchParams({
    client_id: config.clientId,
    logout_uri: `${origin}/`,
  }).toString();
  return url.toString();
}

function clearAll(response: NextResponse): void {
  clearAuthCookies(response);
  clearOAuthCookies(response);
  response.headers.set('Cache-Control', 'no-store');
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    await revokeRefreshToken(request);
    const response = NextResponse.json({ logoutUrl: managedLogoutUrl(request) });
    clearAll(response);
    return response;
  } catch {
    const response = NextResponse.json({ logoutUrl: '/' });
    clearAll(response);
    return response;
  }
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    await revokeRefreshToken(request);
    const response = NextResponse.redirect(managedLogoutUrl(request));
    clearAll(response);
    return response;
  } catch {
    const response = NextResponse.redirect(new URL('/', request.url));
    clearAll(response);
    return response;
  }
}


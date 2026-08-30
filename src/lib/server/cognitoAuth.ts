import {
  CognitoIdentityProviderClient,
  GetUserCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import {
  createRemoteJWKSet,
  decodeJwt,
  jwtVerify,
  type JWTPayload,
} from 'jose';

import type { VerifiedIdentity, VerifyResult } from './authTokenVerifier';
import { assertServerEnv } from './env';

export const AUTH_TOKEN_MAX_CHARS = 8_192;
export const CLOCK_TOLERANCE_SECONDS = 60;
export const SESSION_REFRESH_WINDOW_SECONDS = 5 * 60;
export const AUTH_SERVICE_TIMEOUT_MS = 5_000;
export const REVOCATION_CACHE_TTL_MS = 5 * 60 * 1_000;

export const AUTH_COOKIE_NAMES = {
  idToken: '__Host-cb-id-token',
  accessToken: '__Host-cb-access-token',
  refreshToken: '__Host-cb-refresh-token',
  oauthState: '__Host-cb-oauth-state',
  oauthVerifier: '__Host-cb-oauth-verifier',
  oauthReturnTo: '__Host-cb-oauth-return-to',
} as const;

export interface CognitoConfig {
  region: string;
  userPoolId: string;
  clientId: string;
  domain: string;
  issuer: string;
  allowedOrigins: string[];
  socialProviders: string[];
}

export interface CognitoTokenSet {
  idToken: string;
  accessToken: string;
  refreshToken?: string;
  expiresIn: number;
}

export interface AuthenticatedCognitoSession {
  identity: VerifiedIdentity & { emailVerified: boolean };
  accessToken: string;
  tokens?: CognitoTokenSet;
}

type SessionResult =
  | { ok: true; session: AuthenticatedCognitoSession }
  | { ok: false; kind: 'missing' | 'invalid' | 'unavailable' };

interface RevocationEntry {
  expiresAtMs: number;
  outcome: 'ok' | 'invalid';
}

const jwksByIssuer = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
const revocationCache = new Map<string, RevocationEntry>();
const cognitoClients = new Map<string, CognitoIdentityProviderClient>();

function normalizeOrigin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

export function readCognitoConfig(): CognitoConfig {
  assertServerEnv(['AUTH_SERVICE']);

  const region = process.env.COGNITO_AWS_REGION?.trim() ?? '';
  const userPoolId = process.env.COGNITO_USER_POOL_ID?.trim() ?? '';
  const clientId = process.env.COGNITO_CLIENT_ID?.trim() ?? '';
  const domain = (process.env.COGNITO_DOMAIN?.trim() ?? '').replace(/\/+$/, '');
  const allowedOrigins = (process.env.AUTH_ALLOWED_ORIGINS?.trim() ?? '')
    .split(',')
    .map((value) => normalizeOrigin(value.trim()))
    .filter((value): value is string => value !== null);
  const socialProviders = (process.env.AUTH_SOCIAL_PROVIDERS?.trim() ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  if (!domain.startsWith('https://')) {
    throw new Error('COGNITO_DOMAIN must be an HTTPS origin.');
  }
  if (allowedOrigins.length === 0) {
    throw new Error('AUTH_ALLOWED_ORIGINS must contain at least one valid origin.');
  }

  return {
    region,
    userPoolId,
    clientId,
    domain,
    issuer: `https://cognito-idp.${region}.amazonaws.com/${userPoolId}`,
    allowedOrigins: Array.from(new Set(allowedOrigins)),
    socialProviders: Array.from(new Set(socialProviders)),
  };
}

export function resetCognitoAuthCaches(): void {
  jwksByIssuer.clear();
  revocationCache.clear();
  for (const client of cognitoClients.values()) {
    client.destroy();
  }
  cognitoClients.clear();
}

export function cognitoClientForRegion(region: string): CognitoIdentityProviderClient {
  const existing = cognitoClients.get(region);
  if (existing) return existing;
  const client = new CognitoIdentityProviderClient({ region });
  cognitoClients.set(region, client);
  return client;
}

function jwksFor(issuer: string): ReturnType<typeof createRemoteJWKSet> {
  const existing = jwksByIssuer.get(issuer);
  if (existing) return existing;
  const jwks = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`), {
    timeoutDuration: AUTH_SERVICE_TIMEOUT_MS,
    cooldownDuration: 30_000,
    cacheMaxAge: 6 * 60 * 60 * 1_000,
  });
  jwksByIssuer.set(issuer, jwks);
  return jwks;
}

function firstCodePoints(value: string, limit: number): string {
  return Array.from(value).slice(0, limit).join('');
}

export function deriveCognitoDisplayName(payload: JWTPayload): string {
  for (const candidate of [payload.name, payload.given_name]) {
    if (typeof candidate === 'string' && candidate.trim() !== '') {
      return firstCodePoints(candidate.trim(), 50);
    }
  }
  const email = typeof payload.email === 'string' ? payload.email : '';
  const localPart = email.split('@')[0]?.trim() ?? '';
  return firstCodePoints(localPart || 'Patient', 50);
}

export function readCookieValue(req: Request, name: string): string | null {
  const cookie = req.headers.get('cookie');
  if (!cookie) return null;
  for (const entry of cookie.split(';')) {
    const separator = entry.indexOf('=');
    if (separator < 0) continue;
    const key = entry.slice(0, separator).trim();
    if (key !== name) continue;
    try {
      return decodeURIComponent(entry.slice(separator + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

export function readAuthCookies(req: Request): {
  idToken: string | null;
  accessToken: string | null;
  refreshToken: string | null;
} {
  return {
    idToken: readCookieValue(req, AUTH_COOKIE_NAMES.idToken),
    accessToken: readCookieValue(req, AUTH_COOKIE_NAMES.accessToken),
    refreshToken: readCookieValue(req, AUTH_COOKIE_NAMES.refreshToken),
  };
}

function readBearerToken(req: Request): string | null {
  const header = req.headers.get('authorization');
  if (!header) return null;
  const [scheme, ...rest] = header.trim().split(/\s+/);
  if (scheme?.toLowerCase() !== 'bearer') return null;
  const token = rest.join(' ').trim();
  return token === '' ? null : token;
}

function isNetworkFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error instanceof TypeError ||
    error.name === 'AbortError' ||
    error.name === 'TimeoutError' ||
    error.message.toLowerCase().includes('fetch failed')
  );
}

function validStringClaim(payload: JWTPayload, name: keyof JWTPayload): string | null {
  const value = payload[name];
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

async function verifyIdToken(
  idToken: string,
  config: CognitoConfig,
): Promise<
  | { ok: true; identity: VerifiedIdentity & { emailVerified: boolean }; expiresAt: number }
  | { ok: false; kind: 'invalid' | 'unavailable' }
> {
  if (idToken.length > AUTH_TOKEN_MAX_CHARS) return { ok: false, kind: 'invalid' };

  try {
    const { payload, protectedHeader } = await jwtVerify(idToken, jwksFor(config.issuer), {
      issuer: config.issuer,
      audience: config.clientId,
      algorithms: ['RS256'],
      clockTolerance: CLOCK_TOLERANCE_SECONDS,
    });

    if (protectedHeader.alg !== 'RS256' || payload.token_use !== 'id') {
      return { ok: false, kind: 'invalid' };
    }

    const userId = validStringClaim(payload, 'sub');
    const email = validStringClaim(payload, 'email');
    const authTime = typeof payload.auth_time === 'number' ? payload.auth_time : null;
    const expiresAt = typeof payload.exp === 'number' ? payload.exp : null;
    if (!userId || !email || authTime === null || expiresAt === null) {
      return { ok: false, kind: 'invalid' };
    }

    return {
      ok: true,
      identity: {
        userId,
        authTimeMs: authTime * 1_000,
        email,
        displayName: deriveCognitoDisplayName(payload),
        emailVerified: payload.email_verified === true,
      },
      expiresAt,
    };
  } catch (error: unknown) {
    return { ok: false, kind: isNetworkFailure(error) ? 'unavailable' : 'invalid' };
  }
}

function isCredentialRejection(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return [
    'NotAuthorizedException',
    'UserNotFoundException',
    'ResourceNotFoundException',
  ].includes(error.name);
}

async function verifyAccessTokenActive(
  accessToken: string | null,
  identity: VerifiedIdentity,
  config: CognitoConfig,
  requireFresh: boolean,
): Promise<'ok' | 'invalid' | 'unavailable'> {
  if (!accessToken || accessToken.length > AUTH_TOKEN_MAX_CHARS) {
    return requireFresh ? 'invalid' : 'ok';
  }

  const key = `${identity.userId}:${identity.authTimeMs}`;
  const cached = revocationCache.get(key);
  if (!requireFresh && cached && cached.expiresAtMs > Date.now()) {
    return cached.outcome;
  }

  try {
    const result = await cognitoClientForRegion(config.region).send(
      new GetUserCommand({ AccessToken: accessToken }),
    );
    const subject = result.UserAttributes?.find((attribute) => attribute.Name === 'sub')?.Value;
    const outcome = subject === identity.userId ? 'ok' : 'invalid';
    revocationCache.set(key, {
      outcome,
      expiresAtMs: Date.now() + REVOCATION_CACHE_TTL_MS,
    });
    return outcome;
  } catch (error: unknown) {
    if (isCredentialRejection(error)) {
      revocationCache.set(key, {
        outcome: 'invalid',
        expiresAtMs: Date.now() + REVOCATION_CACHE_TTL_MS,
      });
      return 'invalid';
    }
    return 'unavailable';
  }
}

export async function verifyCognitoRequest(
  req: Request,
  opts: { requireFreshRevocationCheck?: boolean } = {},
): Promise<VerifyResult> {
  const config = readCognitoConfig();
  const cookies = readAuthCookies(req);
  const idToken = readBearerToken(req) ?? cookies.idToken;
  if (!idToken) return { ok: false, kind: 'missing' };

  const verified = await verifyIdToken(idToken, config);
  if (!verified.ok) return verified;

  const active = await verifyAccessTokenActive(
    cookies.accessToken,
    verified.identity,
    config,
    opts.requireFreshRevocationCheck === true,
  );
  if (active !== 'ok') return { ok: false, kind: active };

  return { ok: true, identity: verified.identity };
}

function validTokenResponse(value: unknown): CognitoTokenSet | null {
  if (value === null || typeof value !== 'object') return null;
  const body = value as Record<string, unknown>;
  if (
    typeof body.id_token !== 'string' ||
    typeof body.access_token !== 'string' ||
    typeof body.expires_in !== 'number'
  ) {
    return null;
  }
  return {
    idToken: body.id_token,
    accessToken: body.access_token,
    refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : undefined,
    expiresIn: body.expires_in,
  };
}

async function tokenRequest(
  config: CognitoConfig,
  form: URLSearchParams,
): Promise<
  | { ok: true; tokens: CognitoTokenSet }
  | { ok: false; kind: 'invalid' | 'unavailable' }
> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AUTH_SERVICE_TIMEOUT_MS);
  try {
    const response = await fetch(`${config.domain}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form,
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!response.ok) {
      return {
        ok: false,
        kind: response.status === 408 || response.status === 429 || response.status >= 500
          ? 'unavailable'
          : 'invalid',
      };
    }
    const tokens = validTokenResponse(await response.json().catch(() => null));
    return tokens ? { ok: true, tokens } : { ok: false, kind: 'unavailable' };
  } catch {
    return { ok: false, kind: 'unavailable' };
  } finally {
    clearTimeout(timeout);
  }
}

export async function exchangeAuthorizationCode(input: {
  code: string;
  codeVerifier: string;
  redirectUri: string;
}): Promise<
  | { ok: true; tokens: CognitoTokenSet }
  | { ok: false; kind: 'invalid' | 'unavailable' }
> {
  const config = readCognitoConfig();
  return tokenRequest(
    config,
    new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: config.clientId,
      code: input.code,
      redirect_uri: input.redirectUri,
      code_verifier: input.codeVerifier,
    }),
  );
}

export async function refreshCognitoTokens(
  refreshToken: string,
): Promise<
  | { ok: true; tokens: CognitoTokenSet }
  | { ok: false; kind: 'invalid' | 'unavailable' }
> {
  const config = readCognitoConfig();
  return tokenRequest(
    config,
    new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: config.clientId,
      refresh_token: refreshToken,
    }),
  );
}

function tokenNeedsRefresh(idToken: string): boolean {
  try {
    const payload = decodeJwt(idToken);
    if (typeof payload.exp !== 'number') return true;
    return payload.exp - Math.floor(Date.now() / 1_000) <= SESSION_REFRESH_WINDOW_SECONDS;
  } catch {
    return true;
  }
}

export async function authenticateCognitoSession(
  req: Request,
  options: { allowRefresh?: boolean; requireFreshRevocationCheck?: boolean } = {},
): Promise<SessionResult> {
  const config = readCognitoConfig();
  const current = readAuthCookies(req);

  if (current.idToken && current.accessToken) {
    const verified = await verifyIdToken(current.idToken, config);
    if (verified.ok) {
      const active = await verifyAccessTokenActive(
        current.accessToken,
        verified.identity,
        config,
        options.requireFreshRevocationCheck === true,
      );
      if (active === 'ok' && (!options.allowRefresh || !tokenNeedsRefresh(current.idToken))) {
        return {
          ok: true,
          session: { identity: verified.identity, accessToken: current.accessToken },
        };
      }
      if (active === 'unavailable') return { ok: false, kind: 'unavailable' };
      if (active === 'invalid' && !options.allowRefresh) return { ok: false, kind: 'invalid' };
    } else if (verified.kind === 'unavailable') {
      return verified;
    }
  }

  if (!options.allowRefresh || !current.refreshToken) {
    return {
      ok: false,
      kind: current.idToken || current.accessToken ? 'invalid' : 'missing',
    };
  }

  const refreshed = await refreshCognitoTokens(current.refreshToken);
  if (!refreshed.ok) return refreshed;
  const refreshToken = refreshed.tokens.refreshToken ?? current.refreshToken;
  const tokens = { ...refreshed.tokens, refreshToken };
  const verified = await verifyIdToken(tokens.idToken, config);
  if (!verified.ok) return verified;
  const active = await verifyAccessTokenActive(
    tokens.accessToken,
    verified.identity,
    config,
    true,
  );
  if (active !== 'ok') return { ok: false, kind: active };

  return {
    ok: true,
    session: {
      identity: verified.identity,
      accessToken: tokens.accessToken,
      tokens,
    },
  };
}

export async function verifyCognitoTokenSet(
  tokens: CognitoTokenSet,
  options: { requireFreshRevocationCheck?: boolean } = {},
): Promise<SessionResult> {
  const config = readCognitoConfig();
  const verified = await verifyIdToken(tokens.idToken, config);
  if (!verified.ok) return verified;
  const active = await verifyAccessTokenActive(
    tokens.accessToken,
    verified.identity,
    config,
    options.requireFreshRevocationCheck === true,
  );
  if (active !== 'ok') return { ok: false, kind: active };
  return {
    ok: true,
    session: {
      identity: verified.identity,
      accessToken: tokens.accessToken,
      tokens,
    },
  };
}

export function requestOrigin(req: Request): string {
  const config = readCognitoConfig();
  const requestUrl = new URL(req.url);
  const forwardedHost = req.headers.get('x-forwarded-host')?.split(',')[0]?.trim();
  const host = forwardedHost || req.headers.get('host')?.trim();
  const forwardedProto = req.headers.get('x-forwarded-proto')?.split(',')[0]?.trim();
  const protocol = forwardedProto || requestUrl.protocol.replace(/:$/, '');
  const candidates = [
    host ? normalizeOrigin(`${protocol}://${host}`) : null,
    requestUrl.origin,
  ].filter((value): value is string => value !== null);

  const allowed = candidates.find((origin) => config.allowedOrigins.includes(origin));
  if (!allowed) {
    throw new Error(
      `Request origins ${candidates.join(', ') || '(none)'} are not allowed for authentication.`,
    );
  }
  return allowed;
}

export function safeReturnTo(value: string | null): string {
  if (!value || !value.startsWith('/') || value.startsWith('//')) return '/';
  try {
    const parsed = new URL(value, 'https://return.invalid');
    return parsed.origin === 'https://return.invalid'
      ? `${parsed.pathname}${parsed.search}${parsed.hash}`
      : '/';
  } catch {
    return '/';
  }
}

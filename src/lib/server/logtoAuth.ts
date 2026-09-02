import {
  createRemoteJWKSet,
  decodeJwt,
  jwtVerify,
  type JWTPayload,
} from 'jose';

import type { VerifiedIdentity, VerifyResult } from './authTokenVerifier';
import {
  AUTH_COOKIE_NAMES,
  AUTH_SERVICE_TIMEOUT_MS,
  AUTH_TOKEN_MAX_CHARS,
  CLOCK_TOLERANCE_SECONDS,
  REVOCATION_CACHE_TTL_MS,
  SESSION_REFRESH_WINDOW_SECONDS,
  readCookieValue,
} from './cognitoAuth';

export interface LogtoConfig {
  endpoint: string;
  issuer: string;
  clientId: string;
  allowedOrigins: string[];
  socialProviders: string[];
}

export interface LogtoTokenSet {
  idToken: string;
  accessToken: string;
  refreshToken?: string;
  expiresIn: number;
}

interface LogtoManagementConfig {
  endpoint: string;
  clientId: string;
  clientSecret: string;
  apiIndicator: string;
}

export interface AuthenticatedLogtoSession {
  identity: VerifiedIdentity & { emailVerified: boolean };
  accessToken: string;
  tokens?: LogtoTokenSet;
}

type SessionResult =
  | { ok: true; session: AuthenticatedLogtoSession }
  | { ok: false; kind: 'missing' | 'invalid' | 'unavailable' };

interface RevocationEntry {
  expiresAtMs: number;
  outcome: 'ok' | 'invalid';
}

const jwksByIssuer = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
const revocationCache = new Map<string, RevocationEntry>();
let managementTokenCache:
  | { accessToken: string; expiresAtMs: number; clientId: string }
  | undefined;

function normalizeOrigin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

export function readLogtoConfig(): LogtoConfig {
  const endpoint = (process.env.LOGTO_ENDPOINT?.trim() ?? '').replace(/\/+$/, '');
  const clientId = process.env.LOGTO_APP_ID?.trim() ?? '';
  const allowedOrigins = (process.env.AUTH_ALLOWED_ORIGINS?.trim() ?? '')
    .split(',')
    .map((value) => normalizeOrigin(value.trim()))
    .filter((value): value is string => value !== null);
  const socialProviders = (process.env.AUTH_SOCIAL_PROVIDERS?.trim() ?? '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);

  if (!endpoint.startsWith('https://')) {
    throw new Error('LOGTO_ENDPOINT must be an HTTPS origin.');
  }
  if (!clientId) {
    throw new Error('LOGTO_APP_ID is required.');
  }
  if (allowedOrigins.length === 0) {
    throw new Error('AUTH_ALLOWED_ORIGINS must contain at least one valid origin.');
  }

  return {
    endpoint,
    issuer: `${endpoint}/oidc`,
    clientId,
    allowedOrigins: Array.from(new Set(allowedOrigins)),
    socialProviders: Array.from(new Set(socialProviders)),
  };
}

function readLogtoManagementConfig(): LogtoManagementConfig {
  const { endpoint } = readLogtoConfig();
  const clientId = process.env.LOGTO_MANAGEMENT_APP_ID?.trim() ?? '';
  const clientSecret = process.env.LOGTO_MANAGEMENT_APP_SECRET?.trim() ?? '';
  if (!clientId || !clientSecret) {
    throw new Error('Logto Management API credentials are required.');
  }
  return {
    endpoint,
    clientId,
    clientSecret,
    apiIndicator: 'https://default.logto.app/api',
  };
}

function jwksFor(issuer: string): ReturnType<typeof createRemoteJWKSet> {
  const existing = jwksByIssuer.get(issuer);
  if (existing) return existing;
  const jwks = createRemoteJWKSet(new URL(`${issuer}/jwks`), {
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

export function deriveLogtoDisplayName(payload: JWTPayload): string {
  for (const candidate of [payload.name, payload.username, payload.given_name]) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return firstCodePoints(candidate.trim(), 50);
    }
  }
  const email = typeof payload.email === 'string' ? payload.email : '';
  return firstCodePoints(email.split('@')[0]?.trim() || 'Patient', 50);
}

function validStringClaim(payload: JWTPayload, name: keyof JWTPayload): string | null {
  const value = payload[name];
  return typeof value === 'string' && value.trim() ? value : null;
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

async function verifyIdToken(
  idToken: string,
  config: LogtoConfig,
): Promise<
  | {
      ok: true;
      identity: VerifiedIdentity & { emailVerified: boolean };
      expiresAt: number;
    }
  | { ok: false; kind: 'invalid' | 'unavailable' }
> {
  if (idToken.length > AUTH_TOKEN_MAX_CHARS) return { ok: false, kind: 'invalid' };

  try {
    const { payload, protectedHeader } = await jwtVerify(
      idToken,
      jwksFor(config.issuer),
      {
        issuer: config.issuer,
        audience: config.clientId,
        algorithms: ['ES384', 'PS256', 'RS256'],
        clockTolerance: CLOCK_TOLERANCE_SECONDS,
      },
    );
    if (!['ES384', 'PS256', 'RS256'].includes(protectedHeader.alg)) {
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
        email,
        authTimeMs: authTime * 1_000,
        displayName: deriveLogtoDisplayName(payload),
        emailVerified: payload.email_verified === true,
      },
      expiresAt,
    };
  } catch (error: unknown) {
    return { ok: false, kind: isNetworkFailure(error) ? 'unavailable' : 'invalid' };
  }
}

export function readLogtoAuthCookies(req: Request): {
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

async function verifyAccessTokenActive(
  accessToken: string | null,
  identity: VerifiedIdentity,
  config: LogtoConfig,
  requireFresh: boolean,
): Promise<'ok' | 'invalid' | 'unavailable'> {
  if (!accessToken || accessToken.length > AUTH_TOKEN_MAX_CHARS) {
    return requireFresh ? 'invalid' : 'ok';
  }

  const cacheKey = `${identity.userId}:${identity.authTimeMs}`;
  const cached = revocationCache.get(cacheKey);
  if (!requireFresh && cached && cached.expiresAtMs > Date.now()) {
    return cached.outcome;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AUTH_SERVICE_TIMEOUT_MS);
  try {
    const response = await fetch(`${config.issuer}/me`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      cache: 'no-store',
      signal: controller.signal,
    });
    if (response.status === 401 || response.status === 403) {
      revocationCache.set(cacheKey, {
        outcome: 'invalid',
        expiresAtMs: Date.now() + REVOCATION_CACHE_TTL_MS,
      });
      return 'invalid';
    }
    if (!response.ok) return 'unavailable';
    const value: unknown = await response.json().catch(() => null);
    const subject =
      value && typeof value === 'object' && typeof (value as { sub?: unknown }).sub === 'string'
        ? (value as { sub: string }).sub
        : null;
    const outcome = subject === identity.userId ? 'ok' : 'invalid';
    revocationCache.set(cacheKey, {
      outcome,
      expiresAtMs: Date.now() + REVOCATION_CACHE_TTL_MS,
    });
    return outcome;
  } catch {
    return 'unavailable';
  } finally {
    clearTimeout(timeout);
  }
}

function validTokenResponse(value: unknown): LogtoTokenSet | null {
  if (!value || typeof value !== 'object') return null;
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
  config: LogtoConfig,
  form: URLSearchParams,
): Promise<
  | { ok: true; tokens: LogtoTokenSet }
  | { ok: false; kind: 'invalid' | 'unavailable' }
> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AUTH_SERVICE_TIMEOUT_MS);
  try {
    const response = await fetch(`${config.issuer}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form,
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!response.ok) {
      return {
        ok: false,
        kind:
          response.status === 408 || response.status === 429 || response.status >= 500
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

export async function exchangeLogtoAuthorizationCode(input: {
  code: string;
  codeVerifier: string;
  redirectUri: string;
}): Promise<
  | { ok: true; tokens: LogtoTokenSet }
  | { ok: false; kind: 'invalid' | 'unavailable' }
> {
  const config = readLogtoConfig();
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

async function refreshLogtoTokens(
  refreshToken: string,
): Promise<
  | { ok: true; tokens: LogtoTokenSet }
  | { ok: false; kind: 'invalid' | 'unavailable' }
> {
  const config = readLogtoConfig();
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
    return (
      typeof payload.exp !== 'number' ||
      payload.exp - Math.floor(Date.now() / 1_000) <= SESSION_REFRESH_WINDOW_SECONDS
    );
  } catch {
    return true;
  }
}

export async function authenticateLogtoSession(
  req: Request,
  options: { allowRefresh?: boolean; requireFreshRevocationCheck?: boolean } = {},
): Promise<SessionResult> {
  const config = readLogtoConfig();
  const current = readLogtoAuthCookies(req);

  if (current.idToken && current.accessToken) {
    const verified = await verifyIdToken(current.idToken, config);
    if (verified.ok) {
      const active = await verifyAccessTokenActive(
        current.accessToken,
        verified.identity,
        config,
        options.requireFreshRevocationCheck === true,
      );
      if (
        active === 'ok' &&
        (!options.allowRefresh || !tokenNeedsRefresh(current.idToken))
      ) {
        return {
          ok: true,
          session: { identity: verified.identity, accessToken: current.accessToken },
        };
      }
      if (active === 'unavailable') return { ok: false, kind: 'unavailable' };
      if (active === 'invalid' && !options.allowRefresh) {
        return { ok: false, kind: 'invalid' };
      }
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

  const refreshed = await refreshLogtoTokens(current.refreshToken);
  if (!refreshed.ok) return refreshed;
  const tokens = {
    ...refreshed.tokens,
    refreshToken: refreshed.tokens.refreshToken ?? current.refreshToken,
  };
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

export async function verifyLogtoTokenSet(
  tokens: LogtoTokenSet,
  options: { requireFreshRevocationCheck?: boolean } = {},
): Promise<SessionResult> {
  const config = readLogtoConfig();
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

export async function verifyLogtoRequest(
  req: Request,
  options: { requireFreshRevocationCheck?: boolean } = {},
): Promise<VerifyResult> {
  const result = await authenticateLogtoSession(req, {
    allowRefresh: false,
    requireFreshRevocationCheck: options.requireFreshRevocationCheck,
  });
  return result.ok ? { ok: true, identity: result.session.identity } : result;
}

export async function revokeLogtoRefreshToken(request: Request): Promise<void> {
  const config = readLogtoConfig();
  const refreshToken = readLogtoAuthCookies(request).refreshToken;
  if (!refreshToken) return;
  try {
    await fetch(`${config.issuer}/token/revocation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: config.clientId,
        token: refreshToken,
      }),
      cache: 'no-store',
    });
  } catch {
    // Local cookies are still cleared.
  }
}

export function logtoLogoutUrl(origin: string): string {
  const config = readLogtoConfig();
  const url = new URL(`${config.issuer}/session/end`);
  url.search = new URLSearchParams({
    client_id: config.clientId,
    post_logout_redirect_uri: `${origin}/`,
  }).toString();
  return url.toString();
}

export function requestOriginForLogto(req: Request): string {
  const config = readLogtoConfig();
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
  if (!allowed) throw new Error('The request origin is not allowed for authentication.');
  return allowed;
}

async function logtoManagementAccessToken(
  config: LogtoManagementConfig,
): Promise<string> {
  if (
    managementTokenCache &&
    managementTokenCache.clientId === config.clientId &&
    managementTokenCache.expiresAtMs > Date.now() + 60_000
  ) {
    return managementTokenCache.accessToken;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AUTH_SERVICE_TIMEOUT_MS);
  try {
    const response = await fetch(`${config.endpoint}/oidc/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: config.clientId,
        client_secret: config.clientSecret,
        resource: config.apiIndicator,
        scope: 'all',
      }),
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!response.ok) throw new Error('Management token request failed.');
    const value: unknown = await response.json().catch(() => null);
    if (
      !value ||
      typeof value !== 'object' ||
      typeof (value as { access_token?: unknown }).access_token !== 'string' ||
      typeof (value as { expires_in?: unknown }).expires_in !== 'number'
    ) {
      throw new Error('Management token response was invalid.');
    }
    managementTokenCache = {
      accessToken: (value as { access_token: string }).access_token,
      expiresAtMs:
        Date.now() + (value as { expires_in: number }).expires_in * 1_000,
      clientId: config.clientId,
    };
    return managementTokenCache.accessToken;
  } finally {
    clearTimeout(timeout);
  }
}

export async function deleteLogtoUser(
  userId: string,
): Promise<'ok' | 'invalid' | 'unavailable'> {
  try {
    const config = readLogtoManagementConfig();
    const accessToken = await logtoManagementAccessToken(config);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), AUTH_SERVICE_TIMEOUT_MS);
    try {
      const response = await fetch(
        `${config.endpoint}/api/users/${encodeURIComponent(userId)}`,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${accessToken}` },
          cache: 'no-store',
          signal: controller.signal,
        },
      );
      if (response.status === 204 || response.status === 404) return 'ok';
      if (response.status === 400 || response.status === 401 || response.status === 403) {
        return 'invalid';
      }
      return 'unavailable';
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    return 'unavailable';
  }
}

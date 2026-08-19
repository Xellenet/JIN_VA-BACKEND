import { Response } from 'express';
import * as crypto from 'node:crypto';
import { VARIABLES } from '@common/constants/variables.constants';
import { Role } from '@common/types/enums';

const SESSION_COOKIE_MAX_AGE_MS =
  VARIABLES.REFRESH_TOKEN_EXPIRES_IN_DAYS * 24 * 60 * 60 * 1000;

export interface AuthSessionPayload {
  sub: number;
  role: Role;
}

/**
 * Secret used exclusively to sign the `jinva_session` cookie.
 *
 * Deliberately independent from the RS256 keypair that signs API access/refresh
 * tokens: this cookie is read (not verified against the API) by Next.js edge
 * middleware, and must NOT be usable as a Bearer token against the API even if
 * it leaked, so it cannot share a key with anything `JwtStrategy` accepts.
 *
 * Falls back to an obviously-insecure dev-only value so local development keeps
 * working without extra setup, but requires the real env var in production.
 */
function getSessionSecret(): string {
  const secret = process.env.SESSION_COOKIE_SECRET;
  if (secret) return secret;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('SESSION_COOKIE_SECRET must be set in production');
  }
  return 'dev-only-insecure-session-secret-change-me';
}

function sign(value: string): string {
  return crypto
    .createHmac('sha256', getSessionSecret())
    .update(value)
    .digest('base64url');
}

/**
 * Encodes `{ sub, role, exp }` as `base64url(json).hmacSignature`.
 * Not a JWT on purpose — a minimal, dependency-free format that's trivial to
 * verify in an Edge runtime with the Web Crypto API (no `jsonwebtoken`/`jose`
 * import needed on the frontend).
 */
export function encodeAuthSessionValue(payload: AuthSessionPayload): string {
  const exp = Date.now() + SESSION_COOKIE_MAX_AGE_MS;
  const body = Buffer.from(JSON.stringify({ ...payload, exp })).toString(
    'base64url',
  );
  return `${body}.${sign(body)}`;
}

function baseCookieOptions() {
  const isProduction = process.env.NODE_ENV === 'production';
  return {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax' as const,
    path: '/',
    ...(isProduction && process.env.COOKIE_DOMAIN
      ? { domain: process.env.COOKIE_DOMAIN }
      : {}),
  };
}

/**
 * Sets the `jinva_session` cookie — the minimal, non-sensitive, server-readable
 * auth+role signal Next.js middleware uses (S2). Always set/refreshed alongside
 * the refresh-token cookie (same lifetime), never alone.
 */
export function setAuthSessionCookie(
  res: Response,
  payload: AuthSessionPayload,
): void {
  res.cookie(
    VARIABLES.AUTH_SESSION_COOKIE_NAME,
    encodeAuthSessionValue(payload),
    {
      ...baseCookieOptions(),
      maxAge: SESSION_COOKIE_MAX_AGE_MS,
    },
  );
}

/** Clears the `jinva_session` cookie (logout). */
export function clearAuthSessionCookie(res: Response): void {
  res.cookie(VARIABLES.AUTH_SESSION_COOKIE_NAME, '', {
    ...baseCookieOptions(),
    maxAge: 0,
    expires: new Date(0),
  });
}

import { Response } from 'express';
import { VARIABLES } from '@common/constants/variables.constants';

const REFRESH_TOKEN_MAX_AGE_MS =
  VARIABLES.REFRESH_TOKEN_EXPIRES_IN_DAYS * 24 * 60 * 60 * 1000;

/**
 * Shared cookie options for the httpOnly refresh-token cookie.
 * `secure` is only forced in production so local HTTP development still works.
 * `domain` is only applied when explicitly configured — leaving it unset makes
 * the cookie host-only, which is what we want for localhost development.
 */
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
 * Sets the httpOnly refresh-token cookie on the response.
 * Call this instead of ever putting the refresh token in a JSON body.
 */
export function setRefreshTokenCookie(
  res: Response,
  refreshToken: string,
  persistent = true,
): void {
  res.cookie(VARIABLES.REFRESH_TOKEN_COOKIE_NAME, refreshToken, {
    ...baseCookieOptions(),
    // QA AUTH-31: without maxAge it is a session cookie, gone when the
    // browser closes ("Remember me" unticked).
    ...(persistent ? { maxAge: REFRESH_TOKEN_MAX_AGE_MS } : {}),
  });
}

/**
 * QA AUTH-31: marks a sign-in made with "Remember me" unticked, so a later
 * token refresh re-issues browser-session cookies rather than persistent
 * ones. Itself a session cookie, carrying no identity.
 */
const SESSION_ONLY_COOKIE_NAME = 'jinva_session_only';

export function setSessionOnlyMarker(
  res: Response,
  sessionOnly: boolean,
): void {
  res.cookie(SESSION_ONLY_COOKIE_NAME, sessionOnly ? '1' : '', {
    ...baseCookieOptions(),
    ...(sessionOnly ? {} : { maxAge: 0, expires: new Date(0) }),
  });
}

export function isSessionOnly(req: {
  cookies?: Record<string, string>;
}): boolean {
  return req.cookies?.[SESSION_ONLY_COOKIE_NAME] === '1';
}

/**
 * Clears the refresh-token cookie (logout). Uses the same attributes used to set
 * it (minus maxAge) so browsers reliably match and remove the cookie.
 */
export function clearRefreshTokenCookie(res: Response): void {
  res.cookie(VARIABLES.REFRESH_TOKEN_COOKIE_NAME, '', {
    ...baseCookieOptions(),
    maxAge: 0,
    expires: new Date(0),
  });
}

/**
 * Reads the refresh token from the incoming request's cookies.
 * Requires `cookie-parser` middleware to be registered (see `main.ts`).
 */
export function readRefreshTokenCookie(req: {
  cookies?: Record<string, string>;
}): string | undefined {
  return req.cookies?.[VARIABLES.REFRESH_TOKEN_COOKIE_NAME];
}

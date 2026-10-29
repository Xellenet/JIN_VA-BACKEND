import { Response } from 'express';
import { VARIABLES } from '@common/constants/variables.constants';

/**
 * Cookie options for the httpOnly pending-social-signup cookie. Same
 * production-only `secure`/`domain` rules as the refresh-token cookie, but
 * scoped to the auth routes, which are the only ones that read it.
 */
function baseCookieOptions() {
  const isProduction = process.env.NODE_ENV === 'production';
  return {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax' as const,
    path: VARIABLES.PENDING_SOCIAL_SIGNUP_COOKIE_PATH,
    ...(isProduction && process.env.COOKIE_DOMAIN
      ? { domain: process.env.COOKIE_DOMAIN }
      : {}),
  };
}

/** Sets the cookie carrying the pending social signup's opaque key. */
export function setPendingSignupCookie(res: Response, key: string): void {
  res.cookie(VARIABLES.PENDING_SOCIAL_SIGNUP_COOKIE_NAME, key, {
    ...baseCookieOptions(),
    maxAge: VARIABLES.PENDING_SOCIAL_SIGNUP_TTL_MS,
  });
}

/** Clears the pending-social-signup cookie, using the attributes that set it. */
export function clearPendingSignupCookie(res: Response): void {
  res.cookie(VARIABLES.PENDING_SOCIAL_SIGNUP_COOKIE_NAME, '', {
    ...baseCookieOptions(),
    maxAge: 0,
    expires: new Date(0),
  });
}

/** Reads the pending social signup's key from the request cookies. */
export function readPendingSignupCookie(req: {
  cookies?: Record<string, string>;
}): string | undefined {
  return req.cookies?.[VARIABLES.PENDING_SOCIAL_SIGNUP_COOKIE_NAME];
}

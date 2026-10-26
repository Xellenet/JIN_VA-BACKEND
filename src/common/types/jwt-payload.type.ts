import type { Role } from './enums';

/**
 * Shape of the payload signed into both the access and refresh JWTs
 * (`UserTokenService.createJWTTokens`). `JwtStrategy.validate()` receives
 * this after Passport verifies the token's signature/expiry.
 */
export interface JwtPayload {
  sub: number;
  email: string;
  role: Role;
  /**
   * Which token this is. Both are signed with the same key, so without it a
   * refresh token (days) was accepted as an access token (QA SEC-05/06/08).
   * Absent only on tokens issued before the claim existed.
   */
  typ?: JwtTokenType;
  /** Unique id on refresh tokens, so two issued in the same second differ. */
  jti?: string;
  /** Standard claims, present once the token has been verified. */
  iat?: number;
  exp?: number;
}

export type JwtTokenType = 'access' | 'refresh';

/**
 * Access tokens issued before the `typ` claim carry no type. Those live
 * minutes (JWT_ACCESS_EXPIRES_IN, default 15m); an untyped token that lives
 * longer than this is a pre-claim refresh token and must not authenticate.
 */
export const LEGACY_UNTYPED_ACCESS_MAX_LIFETIME_SECONDS = 60 * 60;

/** Whether a verified payload may authenticate a request as an access token. */
export function isAccessTokenPayload(payload: JwtPayload): boolean {
  if (payload.typ) return payload.typ === 'access';
  if (payload.iat === undefined || payload.exp === undefined) return false;
  return (
    payload.exp - payload.iat <= LEGACY_UNTYPED_ACCESS_MAX_LIFETIME_SECONDS
  );
}

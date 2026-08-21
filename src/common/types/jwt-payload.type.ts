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
}

import type { Request } from 'express';
import type { User } from '@users/entities/user.entity';

/**
 * Express request shape once `JwtAuthGuard` (Passport JWT strategy) has run.
 * `JwtStrategy.validate()` returns the full authenticated `User` entity, and
 * Passport attaches that return value verbatim as `req.user` — it is not a
 * decoded-token payload subset.
 *
 * Use this in place of `@Req() req: any` on any guarded controller method
 * that reads `req.user`, so `req.user.id`/`.role`/etc. are type-checked
 * instead of tripping `@typescript-eslint/no-unsafe-member-access`.
 */
export interface AuthenticatedRequest extends Request {
  user: User;
}

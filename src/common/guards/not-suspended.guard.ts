import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import type { AuthenticatedRequest } from '@common/types/authenticated-request.type';

/**
 * AT3: blocks a **suspended** account from transacting.
 *
 * Suspension is deliberately weaker than a ban (Open Question 4, resolved): a
 * suspended user can still sign in and read their own history — `JwtStrategy`
 * rejects only `isBanned` — but cannot create new obligations for anyone else.
 * That means no new bookings, jobs, job applications or messages.
 *
 * Enforced here, server-side, on the specific mutating routes rather than
 * globally, because a blanket block would also stop a suspended user reading
 * their own past work and would be indistinguishable from a ban.
 *
 * Compose *after* `JwtAuthGuard` so `req.user` is populated:
 * `@UseGuards(JwtAuthGuard, RolesGuard, NotSuspendedGuard)`.
 */
@Injectable()
export class NotSuspendedGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const { user } = context.switchToHttp().getRequest<AuthenticatedRequest>();

    if (user?.isSuspended) {
      throw new ForbiddenException(
        'Your account is suspended, so you cannot start new work on the platform right now. ' +
          'You can still sign in and see your history. Contact support if you think this is a mistake.',
      );
    }

    return true;
  }
}

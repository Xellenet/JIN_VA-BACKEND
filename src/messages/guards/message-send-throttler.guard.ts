import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { ThrottlerLimitDetail } from '@nestjs/throttler';
import type { ExecutionContext } from '@nestjs/common';

/**
 * RL1: per-sender rate limit on `POST /messages`.
 *
 * Two deliberate departures from the stock `ThrottlerGuard`:
 *
 * 1. **Keyed by authenticated user, not by IP.** The default tracker is the
 *    request IP, which would throttle every user behind one office/mobile NAT
 *    as a single sender and let one user evade the limit by changing networks.
 *    RL1 asks for a *per-user* limit, so the JWT subject is the tracker. The IP
 *    remains the fallback only for the theoretically-unauthenticated case; in
 *    practice `JwtAuthGuard` runs first on this route, so `req.user` is always
 *    populated.
 *
 * 2. **A specific, human-readable 429 body.** RL1 explicitly requires "a clear
 *    'you're sending messages too fast, try again shortly' error — never a raw
 *    429 with no explanation". The stock guard throws `ThrottlerException`
 *    ("ThrottlerException: Too many requests"), which is exactly the opaque
 *    response the requirement rules out. `retryAfterSeconds` is included so the
 *    UI can tell the user *how long*, rather than just "shortly".
 */
@Injectable()
export class MessageSendThrottlerGuard extends ThrottlerGuard {
  protected getTracker(req: Record<string, unknown>): Promise<string> {
    const user = req.user as { id?: number } | undefined;
    if (user?.id) return Promise.resolve(`user-${user.id}`);
    return Promise.resolve(`ip-${String(req.ip ?? 'unknown')}`);
  }

  protected throwThrottlingException(
    _context: ExecutionContext,
    throttlerLimitDetail: ThrottlerLimitDetail,
  ): Promise<void> {
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil(throttlerLimitDetail.timeToBlockExpire || 1),
    );
    throw new HttpException(
      {
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        error: 'MESSAGE_RATE_LIMIT_EXCEEDED',
        message: `You're sending messages too fast. Try again in about ${retryAfterSeconds} second${
          retryAfterSeconds === 1 ? '' : 's'
        }.`,
        retryAfterSeconds,
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}

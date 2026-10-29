import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import type { ThrottlerLimitDetail } from '@nestjs/throttler';
import type { ExecutionContext } from '@nestjs/common';
import { NamedThrottlerGuard } from '@common/throttling/named-throttler.guard';
import { THROTTLER_NAMES } from '@common/throttling/throttler-names';

/**
 * The stable code a client matches on to recognise a send-rate-limit rejection,
 * published in `api-contract.md` §3.1. Surfaced to the client as `meta.error`.
 */
export const MESSAGE_RATE_LIMIT_ERROR_CODE = 'MESSAGE_RATE_LIMIT_EXCEEDED';

/**
 * RL1: per-sender rate limit on `POST /messages`.
 *
 * Scoped to the `message-send` throttler via `NamedThrottlerGuard`, so the
 * `/auth/*` limits configured alongside it in `ThrottlingModule` are not
 * applied to this route (the stock guard would apply every configured
 * throttler to every route it protects).
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
 *
 *    The two non-`message` keys are named `errorCode` and `retryAfterSeconds`
 *    because those are the keys `AllExceptionsFilter` promotes into the error
 *    envelope's `meta` (as `meta.error` and `meta.retryAfterSeconds`). Any other
 *    key here would be dropped by that filter before the client ever saw it —
 *    which is exactly what happened to the earlier `error:` key (QA B1).
 */
@Injectable()
export class MessageSendThrottlerGuard extends NamedThrottlerGuard {
  protected readonly throttlerName = THROTTLER_NAMES.MESSAGE_SEND;

  protected getTracker(req: Record<string, unknown>): Promise<string> {
    const user = req.user as { id?: number } | undefined;
    if (user?.id) return Promise.resolve(`user-${user.id}`);
    const ip = typeof req.ip === 'string' ? req.ip : 'unknown';
    return Promise.resolve(`ip-${ip}`);
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
        errorCode: MESSAGE_RATE_LIMIT_ERROR_CODE,
        message: `You're sending messages too fast. Try again in about ${retryAfterSeconds} second${
          retryAfterSeconds === 1 ? '' : 's'
        }.`,
        retryAfterSeconds,
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}

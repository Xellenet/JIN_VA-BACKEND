import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import type { ThrottlerLimitDetail } from '@nestjs/throttler';
import { NamedThrottlerGuard } from '@common/throttling/named-throttler.guard';
import { THROTTLER_NAMES } from '@common/throttling/throttler-names';

/**
 * The stable code a client matches on to recognise a dispute-write rate-limit
 * rejection, published in this round's `api-contract.md`. Surfaced to the
 * client as `meta.error`.
 */
export const DISPUTE_RATE_LIMIT_ERROR_CODE = 'DISPUTE_RATE_LIMIT_EXCEEDED';

/**
 * B5: per-user rate limit on the two dispute writes that change a dispute's
 * state — `POST /disputes/:id/respond` and
 * `PATCH /admin/disputes/:id/resolve`.
 *
 * **This is defence in depth, not a correctness mechanism.** Both endpoints
 * were reported as races (B1: a response could revert a committed ruling; B3:
 * two rulings could move one payment twice) and both are fixed at the write,
 * with conditional `UPDATE`s and a database-level claim on the payment. What
 * unlimited attempts bought an attacker was *practicality*: a party could keep
 * a burst of `respond` calls in flight across an admin's resolve until one
 * straddled it, and a double-clicking admin could generate B3's concurrent
 * pair from one browser. A limit removes the amplifier. If this guard were
 * removed tomorrow, neither race would come back.
 *
 * Keyed on the authenticated user rather than the IP, for the reason
 * `MessageSendThrottlerGuard` documents: both routes run behind
 * `JwtAuthGuard`, and an IP bucket would treat everyone behind one office or
 * mobile NAT as a single actor while letting one actor evade the limit by
 * changing networks. `NamedThrottlerGuard.generateKey` includes the controller
 * and handler, so a party's `respond` attempts and an admin's `resolve`
 * attempts share this *configuration* but not a *counter*.
 *
 * The 429 body uses `errorCode`/`retryAfterSeconds` because those are the two
 * keys `AllExceptionsFilter` promotes into the error envelope's `meta`; any
 * other key is dropped before the client sees it (the QA B1 lesson from the
 * messaging round). A bare `ThrottlerException: Too many requests` would tell
 * a party nothing about what to do next.
 */
@Injectable()
export class DisputeWriteThrottlerGuard extends NamedThrottlerGuard {
  protected readonly throttlerName = THROTTLER_NAMES.DISPUTE_WRITE;

  protected getTracker(req: Record<string, unknown>): Promise<string> {
    const user = req.user as { id?: number } | undefined;
    if (user?.id) return Promise.resolve(`user-${user.id}`);
    const ip = typeof req.ip === 'string' && req.ip ? req.ip : 'unknown';
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
        errorCode: DISPUTE_RATE_LIMIT_ERROR_CODE,
        message:
          `Too many dispute updates in a short time. Try again in about ${retryAfterSeconds} second` +
          `${retryAfterSeconds === 1 ? '' : 's'}.`,
        retryAfterSeconds,
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}

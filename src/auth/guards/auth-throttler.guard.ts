import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import type { ThrottlerLimitDetail } from '@nestjs/throttler';
import { NamedThrottlerGuard } from '@common/throttling/named-throttler.guard';
import { THROTTLER_NAMES } from '@common/throttling/throttler-names';

/**
 * The stable code a client matches on to recognise an auth rate-limit
 * rejection, published in `docs/team/auth-settings-closeout/api-contract.md`.
 * Surfaced to the client as `meta.error`.
 *
 * One code for every throttled auth endpoint, on purpose — see the
 * enumeration note on `throwThrottlingException`.
 */
export const AUTH_RATE_LIMIT_ERROR_CODE = 'AUTH_RATE_LIMIT_EXCEEDED';

/**
 * Rate limiting for the credential-guessing and account-enumeration surface of
 * `/auth/*`.
 *
 * `POST /auth/login` had no limit of any kind, and `POST /auth/restore-account`
 * inherited the same exposure the moment it shipped: both take an
 * email+password pair and answer differently depending on whether the guess was
 * right, which is a complete offline-speed online brute-force oracle. The same
 * argument applies to the one-time-token endpoints and to the endpoints whose
 * side effect is sending mail to a caller-supplied address.
 *
 * Three deliberate properties:
 *
 * 1. **Keyed by client IP, and never by the submitted email.** These routes are
 *    unauthenticated, so the IP is the only identity available before the
 *    handler runs. Mixing the email into the key was considered and rejected:
 *    it would let an attacker keep a fresh quota per address (making a
 *    credential-stuffing list *cheaper* to walk), and a per-email bucket is
 *    itself an enumeration side channel, since the rate-limit headers would
 *    then vary with which address was submitted.
 *
 *    Because the tracker is the IP, `TRUST_PROXY_HOPS` **must** be set in any
 *    environment where the API sits behind a proxy or load balancer — see the
 *    comment in `src/main.ts`. Without it `req.ip` is the proxy's address and
 *    every user in the world shares one bucket.
 *
 * 2. **The 429 is identical for every account and every route.** The guard runs
 *    before the handler, so no lookup has happened and it is not *able* to vary
 *    by whether the email exists: same status, same code, same copy, and no DB
 *    round trip to time. The message deliberately says "attempts" rather than
 *    naming the operation, so the response can't even be used to confirm which
 *    endpoint a proxied request reached.
 *
 * 3. **A specific 429, never a bare one and never a 500.** The stock guard
 *    throws `ThrottlerException` ("ThrottlerException: Too many requests");
 *    this throws an `HttpException` whose response object uses the two keys
 *    `AllExceptionsFilter` promotes into the error envelope (`errorCode` →
 *    `meta.error`, `retryAfterSeconds` → `meta.retryAfterSeconds`). Any other
 *    key would be dropped by that filter before the client saw it — the QA B1
 *    lesson from the messaging round.
 */
@Injectable()
export abstract class AuthAbuseThrottlerGuard extends NamedThrottlerGuard {
  protected getTracker(req: Record<string, unknown>): Promise<string> {
    // `change-password` is the one throttled auth route that runs behind
    // `JwtAuthGuard`, and there the account is a sharper key than the network:
    // it bounds current-password guessing by whoever holds a stolen access
    // token without penalising everyone else on the same NAT.
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
        errorCode: AUTH_RATE_LIMIT_ERROR_CODE,
        message: `Too many attempts. Please try again in about ${retryAfterSeconds} second${
          retryAfterSeconds === 1 ? '' : 's'
        }.`,
        retryAfterSeconds,
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}

/**
 * Guards the endpoints where a caller submits a secret and the response reveals
 * whether it was correct: `login`, `restore-account`, `reset-password`,
 * `verify-email`, `change-password`.
 *
 * Tunable via `AUTH_RATE_LIMIT_PER_MINUTE` (default 10 per minute per IP, per
 * route — each route counts separately).
 */
@Injectable()
export class AuthCredentialsThrottlerGuard extends AuthAbuseThrottlerGuard {
  protected readonly throttlerName = THROTTLER_NAMES.AUTH_CREDENTIALS;
}

/**
 * Guards the unauthenticated endpoints that send mail to a caller-supplied
 * address: `register`, `forgot-password`, `resend-verification`.
 *
 * Tunable via `AUTH_EMAIL_RATE_LIMIT_PER_MINUTE` (default 5 per minute per IP,
 * per route).
 */
@Injectable()
export class AuthEmailThrottlerGuard extends AuthAbuseThrottlerGuard {
  protected readonly throttlerName = THROTTLER_NAMES.AUTH_EMAIL;
}

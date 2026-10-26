import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { ExecutionContext } from '@nestjs/common';
import type { ThrottlerLimitDetail } from '@nestjs/throttler';
import {
  DEFAULT_LOCATION_SUGGESTIONS_RATE_LIMIT,
  LOCATION_SUGGESTIONS_RATE_LIMIT_ERROR_CODE,
  LOCATION_SUGGESTIONS_THROTTLER_NAME,
} from '../locations.constants';

const ONE_MINUTE_MS = 60_000;

/**
 * Reads `LOCATION_SUGGESTIONS_RATE_LIMIT_PER_MINUTE`, falling back to the
 * default for anything unset, non-numeric or <= 0 (same rule as
 * `ThrottlingModule.readLimit`).
 */
export function readLocationSuggestionsLimit(
  raw: string | undefined = process.env
    .LOCATION_SUGGESTIONS_RATE_LIMIT_PER_MINUTE,
): number {
  const parsed = Number(raw ?? DEFAULT_LOCATION_SUGGESTIONS_RATE_LIMIT);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.floor(parsed)
    : DEFAULT_LOCATION_SUGGESTIONS_RATE_LIMIT;
}

/**
 * LOC10/PR5: per-IP limit on `GET /locations/suggestions` (default 30/min).
 *
 * It uses the app's single `ThrottlerModule` registration (storage + common
 * options from `ThrottlingModule`) but brings **its own** throttler definition
 * rather than one of the named throttlers configured there, so this module
 * stays self-contained and the shared throttling config is untouched. Like
 * `NamedThrottlerGuard`, it applies only its own throttler — none of the
 * auth/message/dispute limits leak onto this route.
 *
 * Privacy: the tracker is `req.ip` (the stock default). The throttler's
 * in-memory storage keys on a SHA-256 of controller/handler/name/IP, it is
 * never persisted, and neither this guard nor the route's exception filter
 * writes the IP (or the query) to a log.
 */
@Injectable()
export class LocationSuggestionsThrottlerGuard extends ThrottlerGuard {
  async onModuleInit(): Promise<void> {
    await super.onModuleInit();
    this.throttlers = [
      {
        name: LOCATION_SUGGESTIONS_THROTTLER_NAME,
        ttl: ONE_MINUTE_MS,
        limit: readLocationSuggestionsLimit(),
      },
    ];
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Same belt and braces as `NamedThrottlerGuard`: never fall through to the
    // stock throttler list, and never 500 on an uninitialised guard.
    if (
      !Array.isArray(this.throttlers) ||
      this.throttlers.length !== 1 ||
      this.throttlers[0].name !== LOCATION_SUGGESTIONS_THROTTLER_NAME
    ) {
      await this.onModuleInit();
    }
    return super.canActivate(context);
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
        errorCode: LOCATION_SUGGESTIONS_RATE_LIMIT_ERROR_CODE,
        message: 'Too many place lookups. Keep typing, or try again shortly.',
        retryAfterSeconds,
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}

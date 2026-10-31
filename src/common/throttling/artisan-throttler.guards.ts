import { Injectable } from '@nestjs/common';
import { UserKeyedThrottlerGuard } from './customer-throttler.guards';
import { THROTTLER_NAMES } from './throttler-names';

/**
 * The stable codes a client matches on (`meta.error`) to recognise each
 * artisan-side rate-limit rejection.
 */
export const ARTISAN_RATE_LIMIT_ERROR_CODES = {
  ARTISAN_INSIGHTS: 'ARTISAN_INSIGHTS_RATE_LIMIT_EXCEEDED',
  ARTISAN_EXPORT: 'ARTISAN_EXPORT_RATE_LIMIT_EXCEEDED',
} as const;

/**
 * Artisan overview, earnings statement, analytics, review summary and bank
 * list: 30 per 60 s per user and route.
 */
@Injectable()
export class ArtisanInsightsThrottlerGuard extends UserKeyedThrottlerGuard {
  protected readonly throttlerName = THROTTLER_NAMES.ARTISAN_INSIGHTS;
  protected readonly errorCode =
    ARTISAN_RATE_LIMIT_ERROR_CODES.ARTISAN_INSIGHTS;
}

/** Earnings CSV export: 5 per 600 s per user. */
@Injectable()
export class ArtisanExportThrottlerGuard extends UserKeyedThrottlerGuard {
  protected readonly throttlerName = THROTTLER_NAMES.ARTISAN_EXPORT;
  protected readonly errorCode = ARTISAN_RATE_LIMIT_ERROR_CODES.ARTISAN_EXPORT;
}

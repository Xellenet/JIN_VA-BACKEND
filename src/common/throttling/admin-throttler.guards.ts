import { Injectable } from '@nestjs/common';
import { UserKeyedThrottlerGuard } from './customer-throttler.guards';
import { THROTTLER_NAMES } from './throttler-names';

/** The stable code a client matches on (`meta.error`) for an admin-side 429. */
export const ADMIN_RATE_LIMIT_ERROR_CODES = {
  ADMIN_INSIGHTS: 'ADMIN_INSIGHTS_RATE_LIMIT_EXCEEDED',
} as const;

/**
 * `GET /admin/analytics/insights`: 30 per 60 s per admin. The response is
 * cached for a few minutes, so the limit only stops a script from forcing
 * rebuilds of a 27-query aggregate.
 */
@Injectable()
export class AdminInsightsThrottlerGuard extends UserKeyedThrottlerGuard {
  protected readonly throttlerName = THROTTLER_NAMES.ADMIN_INSIGHTS;
  protected readonly errorCode = ADMIN_RATE_LIMIT_ERROR_CODES.ADMIN_INSIGHTS;
}

import { Injectable } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { CustomerAnalyticsThrottlerGuard } from '@common/throttling/customer-throttler.guards';

/**
 * Customer experience v2 (B3): `GET /payments/history` has two forms.
 *
 * - With **no** query parameters it is the legacy, unpaginated list the job
 *   and pay pages already call on every load. It stays unthrottled, exactly
 *   as before, so this release cannot start returning 429s to those pages.
 * - With any parameter it is the Spending page's paginated history, and it
 *   shares the `customer-analytics` configuration (30/min per user, its own
 *   bucket because `generateKey` includes the handler).
 */
@Injectable()
export class PaymentHistoryThrottlerGuard extends CustomerAnalyticsThrottlerGuard {
  protected shouldSkip(context: ExecutionContext): Promise<boolean> {
    const req = context
      .switchToHttp()
      .getRequest<{ query?: Record<string, unknown> }>();
    return Promise.resolve(Object.keys(req?.query ?? {}).length === 0);
  }
}

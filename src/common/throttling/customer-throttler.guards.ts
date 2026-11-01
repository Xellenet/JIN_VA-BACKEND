import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import type { ThrottlerLimitDetail } from '@nestjs/throttler';
import { NamedThrottlerGuard } from './named-throttler.guard';
import { THROTTLER_NAMES } from './throttler-names';

/**
 * The stable codes a client matches on (`meta.error`) to recognise each
 * Customer Experience v2 rate-limit rejection.
 */
export const CUSTOMER_RATE_LIMIT_ERROR_CODES = {
  CUSTOMER_ANALYTICS: 'CUSTOMER_ANALYTICS_RATE_LIMIT_EXCEEDED',
  CUSTOMER_EXPORT: 'CUSTOMER_EXPORT_RATE_LIMIT_EXCEEDED',
  PAYMENT_SETTINGS_WRITE: 'PAYMENT_SETTINGS_RATE_LIMIT_EXCEEDED',
  PROFILE_MEDIA_WRITE: 'PROFILE_MEDIA_RATE_LIMIT_EXCEEDED',
  NOTIFICATION_READ: 'NOTIFICATION_READ_RATE_LIMIT_EXCEEDED',
  PAYMENT_METHOD_LOOKUP: 'PAYMENT_METHOD_LOOKUP_RATE_LIMIT_EXCEEDED',
  PAYMENT_METHODS_WRITE: 'PAYMENT_METHODS_RATE_LIMIT_EXCEEDED',
  PAYMENT_CHARGE: 'PAYMENT_CHARGE_RATE_LIMIT_EXCEEDED',
  PAYMENT_CHARGE_STATUS: 'PAYMENT_CHARGE_STATUS_RATE_LIMIT_EXCEEDED',
} as const;

/** The ready-to-display copy every one of these 429s carries. */
export const CUSTOMER_RATE_LIMIT_MESSAGE =
  'Too many requests, please wait a moment.';

/**
 * Base for the per-user named throttlers added in Customer Experience v2.
 *
 * - **Tracker:** the authenticated user (`user-{id}`), falling back to the IP
 *   (`ip-{ip}`) only when a route has no user, as `DisputeWriteThrottlerGuard`
 *   does. An office or mobile NAT is not one actor.
 * - **Buckets:** `generateKey` includes the controller and handler, so two
 *   routes on the same named throttler share the limit but not the counter.
 * - **429:** `errorCode`/`retryAfterSeconds` are the two keys
 *   `AllExceptionsFilter` promotes into `meta`. The guard also sets an
 *   unsuffixed `Retry-After` header itself, because the stock guard only sets
 *   `Retry-After-{name}` for a named throttler.
 */
@Injectable()
export abstract class UserKeyedThrottlerGuard extends NamedThrottlerGuard {
  /** The `meta.error` code for this throttler's 429. */
  protected abstract readonly errorCode: string;

  protected getTracker(req: Record<string, unknown>): Promise<string> {
    const user = req.user as { id?: number } | undefined;
    if (user?.id) return Promise.resolve(`user-${user.id}`);
    const ip = typeof req.ip === 'string' && req.ip ? req.ip : 'unknown';
    return Promise.resolve(`ip-${ip}`);
  }

  protected throwThrottlingException(
    context: ExecutionContext,
    throttlerLimitDetail: ThrottlerLimitDetail,
  ): Promise<void> {
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil(throttlerLimitDetail.timeToBlockExpire || 1),
    );
    const res = context.switchToHttp?.().getResponse<{
      header?: (name: string, value: string) => unknown;
    }>();
    if (res && typeof res.header === 'function') {
      res.header('Retry-After', String(retryAfterSeconds));
    }
    throw new HttpException(
      {
        errorCode: this.errorCode,
        message: CUSTOMER_RATE_LIMIT_MESSAGE,
        retryAfterSeconds,
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}

/** B7a, B6, B2, B3 (paginated), B3f: 30 per 60 s per user and route. */
@Injectable()
export class CustomerAnalyticsThrottlerGuard extends UserKeyedThrottlerGuard {
  protected readonly throttlerName = THROTTLER_NAMES.CUSTOMER_ANALYTICS;
  protected readonly errorCode =
    CUSTOMER_RATE_LIMIT_ERROR_CODES.CUSTOMER_ANALYTICS;
}

/** B10 CSV export: 5 per 600 s per user. */
@Injectable()
export class CustomerExportThrottlerGuard extends UserKeyedThrottlerGuard {
  protected readonly throttlerName = THROTTLER_NAMES.CUSTOMER_EXPORT;
  protected readonly errorCode =
    CUSTOMER_RATE_LIMIT_ERROR_CODES.CUSTOMER_EXPORT;
}

/** B5 `PATCH /users/me/payment-settings`: 5 per 60 s per user. */
@Injectable()
export class PaymentSettingsWriteThrottlerGuard extends UserKeyedThrottlerGuard {
  protected readonly throttlerName = THROTTLER_NAMES.PAYMENT_SETTINGS_WRITE;
  protected readonly errorCode =
    CUSTOMER_RATE_LIMIT_ERROR_CODES.PAYMENT_SETTINGS_WRITE;
}

/** B1 photo upload and removal: 10 per hour per user and route. */
@Injectable()
export class ProfileMediaWriteThrottlerGuard extends UserKeyedThrottlerGuard {
  protected readonly throttlerName = THROTTLER_NAMES.PROFILE_MEDIA_WRITE;
  protected readonly errorCode =
    CUSTOMER_RATE_LIMIT_ERROR_CODES.PROFILE_MEDIA_WRITE;
}

/** B8 `GET /notifications/:id`: 60 per 60 s per user. */
@Injectable()
export class NotificationReadThrottlerGuard extends UserKeyedThrottlerGuard {
  protected readonly throttlerName = THROTTLER_NAMES.NOTIFICATION_READ;
  protected readonly errorCode =
    CUSTOMER_RATE_LIMIT_ERROR_CODES.NOTIFICATION_READ;
}

/** Saved payment methods: name lookup and saving a number, 10 per 600 s. */
@Injectable()
export class PaymentMethodLookupThrottlerGuard extends UserKeyedThrottlerGuard {
  protected readonly throttlerName = THROTTLER_NAMES.PAYMENT_METHOD_LOOKUP;
  protected readonly errorCode =
    CUSTOMER_RATE_LIMIT_ERROR_CODES.PAYMENT_METHOD_LOOKUP;
}

/** Saved payment methods: make default and remove, 20 per 600 s. */
@Injectable()
export class PaymentMethodsWriteThrottlerGuard extends UserKeyedThrottlerGuard {
  protected readonly throttlerName = THROTTLER_NAMES.PAYMENT_METHODS_WRITE;
  protected readonly errorCode =
    CUSTOMER_RATE_LIMIT_ERROR_CODES.PAYMENT_METHODS_WRITE;
}

/** Paying with a saved method and submitting its OTP, 10 per 600 s. */
@Injectable()
export class PaymentChargeThrottlerGuard extends UserKeyedThrottlerGuard {
  protected readonly throttlerName = THROTTLER_NAMES.PAYMENT_CHARGE;
  protected readonly errorCode = CUSTOMER_RATE_LIMIT_ERROR_CODES.PAYMENT_CHARGE;
}

/** The charge status the pay page polls, 60 per 60 s. */
@Injectable()
export class PaymentChargeStatusThrottlerGuard extends UserKeyedThrottlerGuard {
  protected readonly throttlerName = THROTTLER_NAMES.PAYMENT_CHARGE_STATUS;
  protected readonly errorCode =
    CUSTOMER_RATE_LIMIT_ERROR_CODES.PAYMENT_CHARGE_STATUS;
}

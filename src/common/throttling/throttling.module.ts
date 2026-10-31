import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import type { ThrottlerOptions } from '@nestjs/throttler';
import { THROTTLER_NAMES } from './throttler-names';

/** Most limits in this module are expressed per rolling 60 seconds. */
const ONE_MINUTE_MS = 60_000;
const TEN_MINUTES_MS = 10 * ONE_MINUTE_MS;
const ONE_HOUR_MS = 60 * ONE_MINUTE_MS;

/** RL1: default when `MESSAGE_RATE_LIMIT_PER_MINUTE` is unset. */
const DEFAULT_MESSAGE_RATE_LIMIT = 25;

/**
 * Default when `AUTH_RATE_LIMIT_PER_MINUTE` is unset. 10/minute/IP is at the
 * looser end of the usual 5–10 login baseline on purpose: the tracker is the
 * client IP, so a household or office NAT shares one bucket, and a real user
 * fumbling a password twice must never be able to lock out their colleagues.
 * It still cuts an unthrottled brute-force rate down by orders of magnitude.
 */
const DEFAULT_AUTH_CREDENTIALS_RATE_LIMIT = 10;

/** Default when `AUTH_EMAIL_RATE_LIMIT_PER_MINUTE` is unset. */
const DEFAULT_AUTH_EMAIL_RATE_LIMIT = 5;

/**
 * Default when `DISPUTE_WRITE_RATE_LIMIT_PER_MINUTE` is unset, applied per
 * authenticated user and per route (`generateKey` includes the handler, so a
 * party's `respond` bucket and an admin's `resolve` bucket are separate).
 *
 * 20/minute is far above human speed for either action — a party submits one
 * response per dispute ever, and an admin rules one dispute at a time after
 * reading both sides — while cutting an automated burst down by orders of
 * magnitude. It is deliberately not tighter: the limit is defence in depth
 * behind the atomic writes on both endpoints, not the thing keeping them
 * correct, and a limit low enough to interfere with a legitimate admin working
 * through a queue (or with the e2e suite exercising the money path) would buy
 * nothing.
 */
const DEFAULT_DISPUTE_WRITE_RATE_LIMIT = 20;

/**
 * Customer Experience v2 defaults, each per authenticated user and per route
 * (`generateKey` includes the handler, so every route has its own bucket).
 */
export const CUSTOMER_THROTTLER_DEFAULTS = {
  CUSTOMER_ANALYTICS: { limit: 30, ttl: ONE_MINUTE_MS },
  CUSTOMER_EXPORT: { limit: 5, ttl: TEN_MINUTES_MS },
  PAYMENT_SETTINGS_WRITE: { limit: 5, ttl: ONE_MINUTE_MS },
  PROFILE_MEDIA_WRITE: { limit: 10, ttl: ONE_HOUR_MS },
  NOTIFICATION_READ: { limit: 60, ttl: ONE_MINUTE_MS },
} as const;

/**
 * Reads a positive-integer limit from configuration, falling back to the
 * compiled-in default for anything unset, non-numeric or <= 0 — a typo'd env
 * var must not silently become "limit 0" (which would reject every request) or
 * "limit NaN".
 */
function readLimit(
  config: ConfigService,
  envVar: string,
  fallback: number,
): number {
  const parsed = Number(config.get<string | number>(envVar, fallback));
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

/**
 * The throttler configuration, exported so the limits and windows can be
 * unit-tested without booting the module.
 */
export function buildThrottlerOptions(config: ConfigService): {
  throttlers: ThrottlerOptions[];
} {
  return {
    throttlers: [
      {
        name: THROTTLER_NAMES.MESSAGE_SEND,
        ttl: ONE_MINUTE_MS,
        limit: readLimit(
          config,
          'MESSAGE_RATE_LIMIT_PER_MINUTE',
          DEFAULT_MESSAGE_RATE_LIMIT,
        ),
      },
      {
        name: THROTTLER_NAMES.AUTH_CREDENTIALS,
        ttl: ONE_MINUTE_MS,
        limit: readLimit(
          config,
          'AUTH_RATE_LIMIT_PER_MINUTE',
          DEFAULT_AUTH_CREDENTIALS_RATE_LIMIT,
        ),
      },
      {
        name: THROTTLER_NAMES.AUTH_EMAIL,
        ttl: ONE_MINUTE_MS,
        limit: readLimit(
          config,
          'AUTH_EMAIL_RATE_LIMIT_PER_MINUTE',
          DEFAULT_AUTH_EMAIL_RATE_LIMIT,
        ),
      },
      {
        name: THROTTLER_NAMES.DISPUTE_WRITE,
        ttl: ONE_MINUTE_MS,
        limit: readLimit(
          config,
          'DISPUTE_WRITE_RATE_LIMIT_PER_MINUTE',
          DEFAULT_DISPUTE_WRITE_RATE_LIMIT,
        ),
      },
      {
        name: THROTTLER_NAMES.CUSTOMER_ANALYTICS,
        ttl: CUSTOMER_THROTTLER_DEFAULTS.CUSTOMER_ANALYTICS.ttl,
        limit: readLimit(
          config,
          'CUSTOMER_ANALYTICS_RATE_LIMIT_PER_MINUTE',
          CUSTOMER_THROTTLER_DEFAULTS.CUSTOMER_ANALYTICS.limit,
        ),
      },
      {
        name: THROTTLER_NAMES.CUSTOMER_EXPORT,
        ttl: CUSTOMER_THROTTLER_DEFAULTS.CUSTOMER_EXPORT.ttl,
        limit: readLimit(
          config,
          'CUSTOMER_EXPORT_RATE_LIMIT_PER_10_MINUTES',
          CUSTOMER_THROTTLER_DEFAULTS.CUSTOMER_EXPORT.limit,
        ),
      },
      {
        name: THROTTLER_NAMES.PAYMENT_SETTINGS_WRITE,
        ttl: CUSTOMER_THROTTLER_DEFAULTS.PAYMENT_SETTINGS_WRITE.ttl,
        limit: readLimit(
          config,
          'PAYMENT_SETTINGS_WRITE_RATE_LIMIT_PER_MINUTE',
          CUSTOMER_THROTTLER_DEFAULTS.PAYMENT_SETTINGS_WRITE.limit,
        ),
      },
      {
        name: THROTTLER_NAMES.PROFILE_MEDIA_WRITE,
        ttl: CUSTOMER_THROTTLER_DEFAULTS.PROFILE_MEDIA_WRITE.ttl,
        limit: readLimit(
          config,
          'PROFILE_MEDIA_WRITE_RATE_LIMIT_PER_HOUR',
          CUSTOMER_THROTTLER_DEFAULTS.PROFILE_MEDIA_WRITE.limit,
        ),
      },
      {
        name: THROTTLER_NAMES.NOTIFICATION_READ,
        ttl: CUSTOMER_THROTTLER_DEFAULTS.NOTIFICATION_READ.ttl,
        limit: readLimit(
          config,
          'NOTIFICATION_READ_RATE_LIMIT_PER_MINUTE',
          CUSTOMER_THROTTLER_DEFAULTS.NOTIFICATION_READ.limit,
        ),
      },
    ],
  };
}

/**
 * The single `ThrottlerModule` root registration for the whole application.
 *
 * It lives here, imported by each feature module that needs it, rather than
 * being registered inside one of those feature modules: `ThrottlerModule` is
 * `@Global()`, so a second `forRoot`/`forRootAsync` call elsewhere would put a
 * competing `THROTTLER_OPTIONS` provider in the global scope and whichever one
 * a guard resolved would be a coin toss. One registration, several named
 * throttlers, is the supported way to have per-concern limits.
 *
 * Deliberately **not** registered as an `APP_GUARD`: nothing is throttled by
 * default. Rate limiting is opt-in per route via `@UseGuards(...)`, so adding a
 * throttler here can never quietly change the behaviour of an unrelated
 * endpoint.
 *
 * Storage is the default in-memory store, which means the limits are
 * **per process**. Running N API instances behind a load balancer effectively
 * multiplies every limit by N; if the deployment ever scales out, this is the
 * place to swap in a shared (e.g. Redis) storage provider.
 */
@Module({
  imports: [
    ThrottlerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: buildThrottlerOptions,
    }),
  ],
  exports: [ThrottlerModule],
})
export class ThrottlingModule {}

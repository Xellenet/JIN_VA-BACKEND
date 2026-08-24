import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { AdminAnalyticsService } from './admin-analytics.service';
import { AnalyticsRange } from '@common/types/enums';

/** The four ranges `GET /admin/analytics` accepts (PRD §5.13). */
const ADMIN_RANGES: AnalyticsRange[] = [
  AnalyticsRange.LAST_7_DAYS,
  AnalyticsRange.LAST_30_DAYS,
  AnalyticsRange.LAST_90_DAYS,
  AnalyticsRange.LAST_YEAR,
];

type Rollup = Awaited<ReturnType<AdminAnalyticsService['build']>>;

/**
 * AN1: the platform-wide rollups follow the **existing** cached/scheduled
 * -refresh precedent rather than being recomputed on every admin page load.
 *
 * Modelled directly on `PlatformRatingCacheService`: computed once at startup,
 * refreshed on a cron, held in a plain in-memory map whose TTL is the cron
 * interval rather than a literal TTL check. The reasoning is the same as that
 * service documents — these are aggregates over every user, booking, job,
 * payment and review on the platform, and a few minutes of staleness has no
 * bearing on a business-reporting screen.
 *
 * Chosen cadence: every 10 minutes. Each payload carries `generatedAt` and
 * `cached`, so the screen can tell an admin how fresh the number is instead of
 * implying it is live.
 *
 * A cold start (or a range whose refresh hasn't landed yet) computes on demand
 * and stores the result, so the endpoint is never blocked on the cron and
 * never returns a stale-by-default empty payload.
 */
@Injectable()
export class PlatformAnalyticsCacheService implements OnModuleInit {
  private readonly logger = new Logger(PlatformAnalyticsCacheService.name);
  private readonly cache = new Map<AnalyticsRange, Rollup>();

  constructor(private readonly adminAnalytics: AdminAnalyticsService) {}

  async onModuleInit(): Promise<void> {
    await this.refresh();
  }

  @Cron(CronExpression.EVERY_10_MINUTES)
  async refresh(): Promise<void> {
    for (const range of ADMIN_RANGES) {
      try {
        this.cache.set(range, await this.adminAnalytics.build(range));
      } catch (err) {
        // A failed refresh must never take the endpoint down — the previous
        // (older) entry stays served and the next tick tries again.
        this.logger.error(
          `Platform analytics refresh failed for range ${range}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    this.logger.log(
      `Platform analytics rollups refreshed (${this.cache.size}/${ADMIN_RANGES.length} ranges cached).`,
    );
  }

  /**
   * Serves the cached rollup, computing on demand if this range hasn't been
   * built yet. `cached: false` marks an on-demand (live) computation so the
   * freshness line can say "Live" rather than a misleading "Updated just now".
   */
  async get(range: AnalyticsRange): Promise<Rollup & { cached: boolean }> {
    const hit = this.cache.get(range);
    if (hit) return { ...hit, cached: true };

    const fresh = await this.adminAnalytics.build(range);
    this.cache.set(range, fresh);
    return { ...fresh, cached: false };
  }
}

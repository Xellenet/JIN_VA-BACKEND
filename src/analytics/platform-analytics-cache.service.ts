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

  /**
   * DC2.4/DC2.5: refreshes every admin range, and reports honestly.
   *
   * Two behaviours this deliberately gets right, both of which it previously
   * got wrong:
   *
   *  - **A degraded rollup never displaces a complete one.** `build()` now
   *    returns partial results (see its docblock), so a tick can succeed while
   *    still having lost a section. Overwriting a complete cached rollup with
   *    a partial one would make an admin's screen *lose* figures it had a
   *    minute ago. The held entry keeps being served with its own honest
   *    `generatedAt`, and the next tick retries. A degraded rollup is only
   *    stored when there is nothing better for that range — a partial answer
   *    beats a 500.
   *
   *  - **The summary line is not a success report.** It used to log
   *    `"rollups refreshed (0/4 ranges cached)"` at `log` level, so a total
   *    outage read as routine information. It now states cached / degraded /
   *    failed counts and names the affected ranges, at `error` level when a
   *    range failed outright and `warn` when one came back degraded.
   */
  @Cron(CronExpression.EVERY_10_MINUTES)
  async refresh(): Promise<void> {
    const degradedRanges: string[] = [];
    const failedRanges: string[] = [];
    const heldRanges: string[] = [];

    for (const range of ADMIN_RANGES) {
      try {
        const rollup = await this.adminAnalytics.build(range);

        if (rollup.degraded.length > 0) {
          degradedRanges.push(`${range}(${rollup.degraded.join(',')})`);

          const held = this.cache.get(range);
          if (held && held.degraded.length === 0) {
            heldRanges.push(range);
            continue;
          }
        }

        this.cache.set(range, rollup);
      } catch (err) {
        // A failed refresh must never take the endpoint down — the previous
        // (older) entry stays served and the next tick tries again.
        failedRanges.push(range);
        this.logger.error(
          `Platform analytics refresh failed for range ${range}: ${
            err instanceof Error ? err.message : String(err)
          }`,
          err instanceof Error ? err.stack : undefined,
        );
      }
    }

    const cached = ADMIN_RANGES.filter((r) => this.cache.has(r)).length;
    const summary =
      `Platform analytics refresh: ranges=${ADMIN_RANGES.length} ` +
      `cached=${cached} degraded=${degradedRanges.length} failed=${failedRanges.length}` +
      (degradedRanges.length
        ? ` degradedRanges=${degradedRanges.join(' ')}`
        : '') +
      (failedRanges.length ? ` failedRanges=${failedRanges.join(',')}` : '') +
      (heldRanges.length
        ? ` keptPreviousGoodRollupFor=${heldRanges.join(',')}`
        : '');

    if (failedRanges.length) this.logger.error(summary);
    else if (degradedRanges.length) this.logger.warn(summary);
    else this.logger.log(summary);
  }

  /**
   * Serves the cached rollup, computing on demand if this range hasn't been
   * built yet. `cached: false` marks an on-demand (live) computation so the
   * freshness line can say "Live" rather than a misleading "Updated just now".
   *
   * A cached rollup is preferred even when the on-demand build would be
   * fresher, which is the point of the cache; but a *degraded* cached entry is
   * still served rather than recomputed, because the section that failed is
   * named in `degraded` and the caller can tell. The cron is what heals it.
   */
  async get(range: AnalyticsRange): Promise<Rollup & { cached: boolean }> {
    const hit = this.cache.get(range);
    if (hit) return { ...hit, cached: true };

    const fresh = await this.adminAnalytics.build(range);
    this.cache.set(range, fresh);
    return { ...fresh, cached: false };
  }
}

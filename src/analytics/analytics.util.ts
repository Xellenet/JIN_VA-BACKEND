import { AnalyticsBucket, AnalyticsRange } from '@common/types/enums';

/**
 * AN2 (Open Question 12, resolved): the range → bucket-granularity mapping,
 * defined once so every series on a screen is bucketed identically.
 *
 * | range | window            | bucket  |
 * |-------|-------------------|---------|
 * | 7d    | last 7 days       | daily   |
 * | 30d   | last 30 days      | daily   |
 * | 90d   | last 90 days      | weekly  |
 * | 1y    | last 365 days     | monthly |
 * | all   | everything        | monthly |
 *
 * Admin accepts `7d | 30d | 90d | 1y` (PRD §5.13); artisan accepts
 * `7d | 30d | 90d | all` (PRD §5.12). The asymmetry is the PRD's, and each
 * endpoint's DTO enforces its own four values so a mismatched range is a 400
 * rather than a silently wrong window.
 */
export interface AnalyticsWindow {
  range: AnalyticsRange;
  /** Inclusive lower bound. `null` only for `all`, which has no lower bound. */
  from: Date | null;
  /** Inclusive upper bound — always "now" at request time. */
  to: Date;
  bucket: AnalyticsBucket;
  /**
   * AN3: the immediately preceding equivalent period, for honest
   * trend comparison. `null` for `all` (nothing precedes everything), which is
   * why a trend must be omitted rather than invented for that range.
   */
  previous: { from: Date; to: Date } | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

const RANGE_DAYS: Record<string, number> = {
  [AnalyticsRange.LAST_7_DAYS]: 7,
  [AnalyticsRange.LAST_30_DAYS]: 30,
  [AnalyticsRange.LAST_90_DAYS]: 90,
  [AnalyticsRange.LAST_YEAR]: 365,
};

const RANGE_BUCKETS: Record<string, AnalyticsBucket> = {
  [AnalyticsRange.LAST_7_DAYS]: AnalyticsBucket.DAY,
  [AnalyticsRange.LAST_30_DAYS]: AnalyticsBucket.DAY,
  [AnalyticsRange.LAST_90_DAYS]: AnalyticsBucket.WEEK,
  [AnalyticsRange.LAST_YEAR]: AnalyticsBucket.MONTH,
  [AnalyticsRange.ALL_TIME]: AnalyticsBucket.MONTH,
};

export function resolveWindow(
  range: AnalyticsRange,
  now: Date = new Date(),
): AnalyticsWindow {
  const to = now;
  const bucket = RANGE_BUCKETS[range] ?? AnalyticsBucket.DAY;

  if (range === AnalyticsRange.ALL_TIME) {
    return { range, from: null, to, bucket, previous: null };
  }

  const days = RANGE_DAYS[range] ?? 30;
  const from = new Date(to.getTime() - days * DAY_MS);
  return {
    range,
    from,
    to,
    bucket,
    previous: {
      from: new Date(from.getTime() - days * DAY_MS),
      to: from,
    },
  };
}

/**
 * Postgres `DATE_TRUNC` unit for a bucket. Interpolated into raw SQL, so it is
 * mapped through this allow-list rather than passed through from the request —
 * the value is enum-validated at the DTO boundary and mapped again here, so no
 * request value ever reaches a query string directly.
 */
export function truncUnit(bucket: AnalyticsBucket): 'day' | 'week' | 'month' {
  switch (bucket) {
    case AnalyticsBucket.WEEK:
      return 'week';
    case AnalyticsBucket.MONTH:
      return 'month';
    default:
      return 'day';
  }
}

/**
 * Postgres returns `COUNT`/`AVG`/`SUM` as **text**, and every existing
 * aggregate call site in this codebase wraps them in `Number()`. Analytics
 * must too: leaking strings where the frontend expects numbers makes charts
 * render subtly wrong rather than failing loudly.
 */
export function num(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/** Rounds money to 2dp; a float sum of `decimal` columns can drift. */
export function money(value: unknown): number {
  return Number(num(value).toFixed(2));
}

/** Rounds a percentage to 1dp. Returns 0 rather than NaN when total is 0. */
export function percent(part: number, total: number): number {
  if (!total) return 0;
  return Number(((part / total) * 100).toFixed(1));
}

/**
 * ISO date key for a bucket row, so the frontend gets a stable x-axis value.
 *
 * `DATE_TRUNC` comes back as a `Date` through the pg driver, but a raw string
 * is possible depending on driver configuration — both are handled, and
 * anything else yields an empty key rather than `[object Object]`.
 */
export function bucketKey(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return new Date(value).toISOString();
  return '';
}

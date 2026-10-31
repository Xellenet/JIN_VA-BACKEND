/**
 * Customer experience v2: the spending periods a customer can pick (B2, B3,
 * B10). Deliberately local to the customer feature: `AnalyticsRange` and the
 * artisan/admin DTOs are not touched (R3).
 *
 * All calendar maths is in `Africa/Accra`, which is UTC+0 with no daylight
 * saving, so a UTC calendar day **is** an Accra calendar day. The functions
 * below therefore use UTC date arithmetic; SQL still names the zone
 * explicitly (`AT TIME ZONE 'Africa/Accra'`) so the rule is visible there.
 */
export const CUSTOMER_SPEND_RANGES = ['30d', '90d', '12m', 'all'] as const;
export type CustomerSpendRange = (typeof CUSTOMER_SPEND_RANGES)[number];
export const DEFAULT_CUSTOMER_SPEND_RANGE: CustomerSpendRange = '12m';

export type CustomerBucket = 'day' | 'week' | 'month';

export interface CustomerWindow {
  range: CustomerSpendRange;
  bucket: CustomerBucket;
  /** Inclusive start, or `null` for `all`. */
  from: Date | null;
  /** The moment the window was resolved ("now"). */
  to: Date;
  /**
   * Every bucket start (`YYYY-MM-DD`), oldest first. Empty for `all`: those
   * buckets depend on the first payment, see `monthBucketsBetween`.
   */
  buckets: string[];
  /** The period of the same length immediately before `from`; `null` for `all`. */
  previous: { from: Date; to: Date } | null;
}

const DAY_MS = 86_400_000;

/** Midnight (Accra = UTC) of the calendar day `d` falls on. */
export function startOfDay(d: Date): Date {
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
  );
}

/** The 1st of the month `monthsBack` months before `d`'s month. */
export function startOfMonth(d: Date, monthsBack = 0): Date {
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - monthsBack, 1),
  );
}

/** ISO week start (Monday) of the day `d` falls on. */
export function startOfIsoWeek(d: Date): Date {
  const day = startOfDay(d);
  const offset = (day.getUTCDay() + 6) % 7; // Monday = 0
  return new Date(day.getTime() - offset * DAY_MS);
}

/** `YYYY-MM-DD` of a UTC (= Accra) date. */
export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** `YYYY-MM` of a UTC (= Accra) date. */
export function isoMonth(d: Date): string {
  return d.toISOString().slice(0, 7);
}

/** Month bucket starts from `first`'s month to `last`'s month, inclusive. */
export function monthBucketsBetween(first: Date, last: Date): string[] {
  const out: string[] = [];
  let cursor = startOfMonth(first);
  const end = startOfMonth(last).getTime();
  while (cursor.getTime() <= end) {
    out.push(isoDate(cursor));
    cursor = new Date(
      Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1),
    );
  }
  return out;
}

/**
 * Resolves a range into its window, bucket size, bucket list and previous
 * period (B2 window table in the implementation plan). Pure: `now` is passed
 * in so tests control the clock.
 */
export function resolveCustomerWindow(
  range: CustomerSpendRange,
  now: Date = new Date(),
): CustomerWindow {
  const today = startOfDay(now);
  switch (range) {
    case '30d': {
      const from = new Date(today.getTime() - 29 * DAY_MS);
      const buckets = Array.from({ length: 30 }, (_, i) =>
        isoDate(new Date(from.getTime() + i * DAY_MS)),
      );
      return {
        range,
        bucket: 'day',
        from,
        to: now,
        buckets,
        previous: { from: new Date(from.getTime() - 30 * DAY_MS), to: from },
      };
    }
    case '90d': {
      const from = new Date(today.getTime() - 89 * DAY_MS);
      const buckets: string[] = [];
      for (
        let w = startOfIsoWeek(from);
        w.getTime() <= today.getTime();
        w = new Date(w.getTime() + 7 * DAY_MS)
      ) {
        buckets.push(isoDate(w));
      }
      return {
        range,
        bucket: 'week',
        from,
        to: now,
        buckets,
        previous: { from: new Date(from.getTime() - 90 * DAY_MS), to: from },
      };
    }
    case '12m': {
      const from = startOfMonth(now, 11);
      return {
        range,
        bucket: 'month',
        from,
        to: now,
        buckets: monthBucketsBetween(from, now),
        previous: { from: startOfMonth(now, 23), to: from },
      };
    }
    case 'all':
    default:
      return {
        range: 'all',
        bucket: 'month',
        from: null,
        to: now,
        buckets: [],
        previous: null,
      };
  }
}

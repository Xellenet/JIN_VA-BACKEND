import { num } from './analytics.util';

/**
 * Admin insights (`GET /admin/analytics/insights`): the small pure helpers
 * every section's maths goes through, kept free of Nest and TypeORM so the
 * edge cases (tiny samples, empty tables, division by zero) are unit-tested
 * directly in `insights.util.spec.ts`.
 *
 * Two conventions differ from `analytics.util.ts` on purpose, and only for the
 * new endpoint (the existing `GET /admin/analytics` keeps its own helpers and
 * its exact response):
 *  - a rate whose denominator is 0 is `null` ("can't be said"), never `0`, so
 *    the screen shows "Not enough data yet" instead of a misleading 0%;
 *  - money is a **string with 2 decimals** (`"1250.00"`), the convention of
 *    the newer customer and artisan endpoints, so no float ever reaches the
 *    client.
 */

/** Below this many observations a median or p90 is not shown. */
export const MIN_SAMPLE = 5;

/** A median/p90 of a duration, in hours, with its sample size. */
export interface DurationStat {
  /** Number of observations the figure is computed from. */
  n: number;
  /** `null` when `n < MIN_SAMPLE`. */
  medianHours: number | null;
  /** `null` when `n < MIN_SAMPLE`. */
  p90Hours: number | null;
}

/** Rounds to `dp` decimals without returning `-0`. */
export function round(value: number, dp = 2): number {
  const f = 10 ** dp;
  const r = Math.round(value * f) / f;
  return Object.is(r, -0) ? 0 : r;
}

/**
 * Builds a {@link DurationStat} from a `percentile_cont` row. Below
 * {@link MIN_SAMPLE} the figures are withheld: a "median" of two jobs is an
 * anecdote, and a p90 of four is just the slowest one.
 */
export function durationStat(row: {
  n?: unknown;
  median?: unknown;
  p90?: unknown;
}): DurationStat {
  const n = num(row.n);
  if (n < MIN_SAMPLE || row.median == null || row.p90 == null) {
    return { n, medianHours: null, p90Hours: null };
  }
  return {
    n,
    medianHours: round(num(row.median)),
    p90Hours: round(num(row.p90)),
  };
}

/**
 * `part / total` as a percentage with 1 decimal, or `null` when the total is
 * 0 (or negative, which only a data error could produce).
 */
export function rate(part: number, total: number): number | null {
  if (!(total > 0)) return null;
  return round((part / total) * 100, 1);
}

/** `part / total` per 100 (e.g. disputes per 100 completed jobs). */
export function per100(part: number, total: number): number | null {
  return rate(part, total);
}

/** `part / total` as a plain ratio with 2 decimals, `null` when total is 0. */
export function ratio(part: number, total: number): number | null {
  if (!(total > 0)) return null;
  return round(part / total, 2);
}

/** Money as a 2-decimal string (`"0.00"` for null/NaN). */
export function moneyStr(value: unknown): string {
  return num(value).toFixed(2);
}

/** Money divided by a count, as a 2-decimal string; `null` when count is 0. */
export function averageMoney(total: unknown, count: number): string | null {
  if (!(count > 0)) return null;
  return (num(total) / count).toFixed(2);
}

/**
 * Same result as Postgres `percentile_cont(p) WITHIN GROUP (ORDER BY x)`:
 * linear interpolation between the two nearest ranks of the sorted values.
 * Used by the tests to cross-check the SQL figures on the same data (PGlite
 * supports `percentile_cont`, so no runtime fallback is needed).
 */
export function percentileCont(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * p;
  const lower = Math.floor(pos);
  const upper = Math.ceil(pos);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (pos - lower);
}

/** One step of the hiring funnel. */
export interface FunnelStep {
  key: string;
  count: number;
  /** % of the previous step that reached this one; `null` for the first step or a 0 base. */
  conversionFromPrevious: number | null;
}

/** Adds step-to-step conversion to an ordered list of counts. */
export function funnelSteps(steps: Array<[string, number]>): FunnelStep[] {
  return steps.map(([key, count], i) => ({
    key,
    count,
    conversionFromPrevious: i === 0 ? null : rate(count, steps[i - 1][1]),
  }));
}

/** Supply flag for a service (see {@link supplyFlag}). */
export type SupplyFlag = 'no_artisans' | 'few_artisans' | null;

/**
 * Demand per active artisan at or above which a service is flagged as short
 * of artisans. Three open requests per artisan in the window means clients
 * are likely waiting.
 */
export const FEW_ARTISANS_RATIO = 3;

/**
 * - `no_artisans`: jobs were posted but no visible artisan offers it.
 * - `few_artisans`: `jobs / artisans >= FEW_ARTISANS_RATIO`.
 * - `null`: no demand, or enough supply.
 */
export function supplyFlag(jobs: number, artisans: number): SupplyFlag {
  if (jobs <= 0) return null;
  if (artisans <= 0) return 'no_artisans';
  return jobs / artisans >= FEW_ARTISANS_RATIO ? 'few_artisans' : null;
}

/** First day (UTC) of the month `monthsBack` months before `d`'s month. */
export function monthStartUtc(d: Date, monthsBack = 0): Date {
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - monthsBack, 1),
  );
}

/** `YYYY-MM` for a UTC month start. */
export function monthKey(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** How many sign-up cohorts (months) the retention table shows. */
export const COHORT_MONTHS = 6;

export interface CohortRow {
  /** `YYYY-MM` of sign-up. */
  cohort: string;
  /** Clients who signed up that month. */
  size: number;
  /**
   * `months[k]`: % of the cohort that posted or paid for a job in the k-th
   * month after signing up (k = 0 is the sign-up month). `null` for a month
   * that hasn't started yet, and for every month of an empty cohort.
   */
  months: Array<number | null>;
}

/**
 * Assembles the cohort table from the SQL rows: `sizes` per cohort month and
 * `active` distinct clients per (cohort, offset). Every one of the last
 * {@link COHORT_MONTHS} months appears, even with no sign-ups.
 */
export function buildCohorts(
  to: Date,
  sizes: Array<{ cohort: string; n: number }>,
  active: Array<{ cohort: string; offset: number; n: number }>,
): CohortRow[] {
  const sizeBy = new Map(sizes.map((s) => [s.cohort, s.n]));
  const activeBy = new Map(active.map((a) => [`${a.cohort}:${a.offset}`, a.n]));
  const rows: CohortRow[] = [];
  for (let back = COHORT_MONTHS - 1; back >= 0; back--) {
    const cohort = monthKey(monthStartUtc(to, back));
    const size = sizeBy.get(cohort) ?? 0;
    const months: Array<number | null> = [];
    for (let k = 0; k < COHORT_MONTHS; k++) {
      // The (back)-th month back has `back` later months that have started.
      months.push(
        k > back ? null : rate(activeBy.get(`${cohort}:${k}`) ?? 0, size),
      );
    }
    rows.push({ cohort, size, months });
  }
  return rows;
}

/** How many areas the "by area" list names before folding the rest into "Other". */
export const TOP_AREAS = 10;

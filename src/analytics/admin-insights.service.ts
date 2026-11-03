import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { AnalyticsRange } from '@common/types/enums';
import { bucketKey, num, resolveWindow, truncUnit } from './analytics.util';
import {
  COHORT_MONTHS,
  MIN_SAMPLE,
  TOP_AREAS,
  averageMoney,
  buildCohorts,
  durationStat,
  funnelSteps,
  monthStartUtc,
  moneyStr,
  per100,
  rate,
  ratio,
  round,
  supplyFlag,
  type DurationStat,
} from './insights.util';

/**
 * The section names that can appear in `degraded`. Each is a top-level key
 * of the response, so a client maps a name straight to the block it must
 * render as unavailable.
 */
export const INSIGHT_SECTIONS = [
  'funnel',
  'speed',
  'marketplace',
  'economics',
  'payments',
  'trust',
  'artisans',
  'retention',
  'reviews',
] as const;
export type InsightSection = (typeof INSIGHT_SECTIONS)[number];

/** "Active artisan" look-back, deliberately not range-scoped. */
const ACTIVE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Postgres returns COUNT/SUM as text; every row field goes through `num`. */
type Row = Record<string, unknown>;

/** A text column, or `fallback` for NULL (or anything that isn't text). */
function text(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') {
    return value.toString();
  }
  return fallback;
}

/**
 * The window every query is given. `from`/`to` are the range; `now` is the
 * moment "current" snapshots are taken at (always `to`). Snapshot figures
 * (backlogs, holds, activation) only count rows that already existed at `to`
 * (`created_at <= to`), which in production is simply "now" and lets the e2e
 * suite place its fixtures in a closed period no other suite touches.
 */
interface Win {
  from: Date;
  to: Date;
  bucket: 'day' | 'week' | 'month';
}

/** Selected for a set of durations `h` (hours): sample size, median, p90. */
const STATS = `COUNT(*) AS n,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY h) AS median,
  percentile_cont(0.9) WITHIN GROUP (ORDER BY h) AS p90`;

/** Hours between two timestamps. */
const hours = (end: string, start: string) =>
  `EXTRACT(EPOCH FROM (${end} - ${start})) / 3600.0`;

/** Jobs a client posted (not created from a confirmed booking). */
const POSTED = `j.deleted_at IS NULL AND j.booking_id IS NULL`;

/** A job had an artisan hired: an accepted artisan, or a recorded move to PENDING. */
const HIRED = `(j.accepted_artisan_id IS NOT NULL OR EXISTS (
  SELECT 1 FROM job_status_history hh WHERE hh.job_id = j.id AND hh.to_status = 'PENDING'))`;

/**
 * Admin platform insights: nine sections built only from what the database
 * already stores. Read-only, aggregates only, no personal data.
 *
 * Every section runs its own (few) queries, and all sections start at once,
 * so one request issues a fixed number of queries (27) in parallel; the pg
 * pool caps how many run at the same moment. Each section is isolated with
 * `Promise.allSettled`, as in {@link AdminAnalyticsService.build}: a failed
 * section is `null` and named in `degraded`, never a zero.
 *
 * Wrapped by `PlatformAnalyticsCacheService.memo` (short TTL, one build in
 * flight per range), so an admin clicking between tabs or ranges does not
 * re-run it.
 */
@Injectable()
export class AdminInsightsService {
  private readonly logger = new Logger(AdminInsightsService.name);

  constructor(@InjectDataSource() private readonly db: DataSource) {}

  async build(range: AnalyticsRange, now: Date = new Date()) {
    const rw = resolveWindow(range, now);
    // Admin ranges always have a lower bound; `all` is rejected by the DTO.
    const w: Win = {
      from: rw.from ?? new Date(0),
      to: rw.to,
      bucket: truncUnit(rw.bucket),
    };

    const tasks: Record<InsightSection, () => Promise<unknown>> = {
      funnel: () => this.funnel(w),
      speed: () => this.speed(w),
      marketplace: () => this.marketplace(w),
      economics: () => this.economics(w),
      payments: () => this.payments(w),
      trust: () => this.trust(w),
      artisans: () => this.artisans(w),
      retention: () => this.retention(w),
      reviews: () => this.reviews(w),
    };

    const settled = await Promise.allSettled(
      INSIGHT_SECTIONS.map((s) => tasks[s]()),
    );

    const degraded: InsightSection[] = [];
    const out = {} as Record<InsightSection, unknown>;
    settled.forEach((result, i) => {
      const section = INSIGHT_SECTIONS[i];
      if (result.status === 'fulfilled') {
        out[section] = result.value;
        return;
      }
      out[section] = null;
      degraded.push(section);
      const reason: unknown = result.reason;
      this.logger.error(
        `Platform insights section "${section}" failed for range ${range}: ${
          reason instanceof Error ? reason.message : String(reason)
        }`,
        reason instanceof Error ? reason.stack : undefined,
      );
    });

    return {
      range: rw.range,
      bucket: rw.bucket,
      from: w.from.toISOString(),
      to: w.to.toISOString(),
      generatedAt: new Date().toISOString(),
      /** Medians and p90s with fewer observations than this are `null`. */
      minSample: MIN_SAMPLE,
      funnel: out.funnel as Awaited<
        ReturnType<AdminInsightsService['funnel']>
      > | null,
      speed: out.speed as Awaited<
        ReturnType<AdminInsightsService['speed']>
      > | null,
      marketplace: out.marketplace as Awaited<
        ReturnType<AdminInsightsService['marketplace']>
      > | null,
      economics: out.economics as Awaited<
        ReturnType<AdminInsightsService['economics']>
      > | null,
      payments: out.payments as Awaited<
        ReturnType<AdminInsightsService['payments']>
      > | null,
      trust: out.trust as Awaited<
        ReturnType<AdminInsightsService['trust']>
      > | null,
      artisans: out.artisans as Awaited<
        ReturnType<AdminInsightsService['artisans']>
      > | null,
      retention: out.retention as Awaited<
        ReturnType<AdminInsightsService['retention']>
      > | null,
      reviews: out.reviews as Awaited<
        ReturnType<AdminInsightsService['reviews']>
      > | null,
      degraded,
    };
  }

  /**
   * Always a promise, even if the driver throws synchronously: a section
   * starts several of these inside one `Promise.all`, and a synchronous throw
   * part-way through building that array would leave the earlier queries'
   * rejections unhandled.
   */
  private async q(sql: string, params: unknown[]): Promise<Row[]> {
    return this.db.query<Row[]>(sql, params);
  }

  private async one(sql: string, params: unknown[]): Promise<Row> {
    const rows = await this.q(sql, params);
    return rows[0] ?? {};
  }

  // ─── 1. Funnel ──────────────────────────────────────────────────────────────

  /** 1 query. Cohort: jobs clients posted inside the range. */
  private async funnel(w: Win) {
    const r = await this.one(
      `WITH posted AS (
         SELECT j.id, j.status,
           EXISTS (SELECT 1 FROM job_applications a WHERE a.job_id = j.id) AS has_app,
           ${HIRED} AS hired,
           (j.status IN ('IN_PROGRESS', 'COMPLETED') OR EXISTS (
             SELECT 1 FROM job_status_history h
              WHERE h.job_id = j.id AND h.to_status = 'IN_PROGRESS')) AS started
           FROM jobs j
          WHERE ${POSTED} AND j.created_at >= $1 AND j.created_at <= $2
       )
       SELECT COUNT(*) AS posted,
         COUNT(*) FILTER (WHERE has_app) AS applied,
         COUNT(*) FILTER (WHERE hired) AS hired,
         COUNT(*) FILTER (WHERE started) AS started,
         COUNT(*) FILTER (WHERE status = 'COMPLETED') AS completed,
         COUNT(*) FILTER (WHERE status = 'EXPIRED' AND NOT hired) AS expired_without_hire,
         COUNT(*) FILTER (WHERE status = 'CANCELLED') AS cancelled,
         COUNT(*) FILTER (WHERE status = 'CANCELLED' AND NOT hired) AS cancelled_before_hire,
         COUNT(*) FILTER (WHERE status IN ('OPEN', 'PENDING', 'IN_PROGRESS')) AS in_flight,
         (SELECT COUNT(*) FROM jobs b
           WHERE b.deleted_at IS NULL AND b.booking_id IS NOT NULL
             AND b.created_at >= $1 AND b.created_at <= $2) AS from_bookings
         FROM posted`,
      [w.from, w.to],
    );
    const posted = num(r.posted);
    const completed = num(r.completed);
    return {
      steps: funnelSteps([
        ['posted', posted],
        ['applied', num(r.applied)],
        ['hired', num(r.hired)],
        ['started', num(r.started)],
        ['completed', completed],
      ]),
      /** Completed as a % of posted. */
      overallConversion: rate(completed, posted),
      expiredWithoutHire: num(r.expired_without_hire),
      cancelled: num(r.cancelled),
      cancelledBeforeHire: num(r.cancelled_before_hire),
      inFlight: num(r.in_flight),
      /** Jobs created by confirming a booking: not in the funnel (no applications). */
      fromBookings: num(r.from_bookings),
    };
  }

  // ─── 2. Speed ───────────────────────────────────────────────────────────────

  /**
   * 1 query (seven UNION ALL arms, grouped). Each duration counts the events
   * that *finished* inside the range: a hire made in the range, a payout
   * released in it, and so on.
   */
  private async speed(w: Win) {
    const rows = await this.q(
      `SELECT metric, ${STATS} FROM (
         SELECT 'firstApplication' AS metric, ${hours('fa.first_at', 'j.created_at')} AS h
           FROM jobs j
           JOIN (SELECT a.job_id, MIN(a.created_at) AS first_at FROM job_applications a
                  GROUP BY a.job_id HAVING MIN(a.created_at) >= $1 AND MIN(a.created_at) <= $2) fa
             ON fa.job_id = j.id
          WHERE ${POSTED}
         UNION ALL
         SELECT 'hire', ${hours('hp.at', 'j.created_at')}
           FROM jobs j
           JOIN (SELECT h.job_id, MIN(h.created_at) AS at FROM job_status_history h
                  WHERE h.to_status = 'PENDING' GROUP BY h.job_id
                 HAVING MIN(h.created_at) >= $1 AND MIN(h.created_at) <= $2) hp
             ON hp.job_id = j.id
          WHERE ${POSTED}
         UNION ALL
         SELECT 'hireToCompletion', ${hours('hc.at', 'hp.at')}
           FROM (SELECT h.job_id, MIN(h.created_at) AS at FROM job_status_history h
                  WHERE h.to_status = 'COMPLETED' GROUP BY h.job_id
                 HAVING MIN(h.created_at) >= $1 AND MIN(h.created_at) <= $2) hc
           JOIN (SELECT h.job_id, MIN(h.created_at) AS at FROM job_status_history h
                  WHERE h.to_status = 'PENDING' GROUP BY h.job_id) hp ON hp.job_id = hc.job_id
           JOIN jobs j ON j.id = hc.job_id AND j.deleted_at IS NULL
         UNION ALL
         SELECT 'bookingResponse', ${hours('j.created_at', 'b.created_at')}
           FROM bookings b JOIN jobs j ON j.booking_id = b.id
          WHERE j.created_at >= $1 AND j.created_at <= $2
         UNION ALL
         SELECT 'payout', ${hours('p.released_at', 'p.paid_at')}
           FROM payments p
          WHERE p.paid_at IS NOT NULL AND p.released_at >= $1 AND p.released_at <= $2
         UNION ALL
         SELECT 'disputeResolution', ${hours('d.resolved_at', 'd.created_at')}
           FROM disputes d WHERE d.resolved_at >= $1 AND d.resolved_at <= $2
         UNION ALL
         SELECT 'verificationReview', ${hours('v.reviewed_at', 'v.created_at')}
           FROM artisan_verifications v WHERE v.reviewed_at >= $1 AND v.reviewed_at <= $2
       ) d
       WHERE h >= 0
       GROUP BY metric`,
      [w.from, w.to],
    );
    const by = new Map(rows.map((r) => [text(r.metric), r]));
    const stat = (k: string): DurationStat => durationStat(by.get(k) ?? {});
    return {
      firstApplication: stat('firstApplication'),
      hire: stat('hire'),
      hireToCompletion: stat('hireToCompletion'),
      /** Confirmations only: a decline stores no response time. */
      bookingResponse: stat('bookingResponse'),
      payout: stat('payout'),
      disputeResolution: stat('disputeResolution'),
      verificationReview: stat('verificationReview'),
    };
  }

  // ─── 3. Supply and demand ───────────────────────────────────────────────────

  /** 3 queries: demand per service, visible supply per service, jobs by area. */
  private async marketplace(w: Win) {
    const [demand, supply, areas] = await Promise.all([
      this.q(
        `SELECT s.id, s.name, s.is_active,
           COUNT(j.id) AS jobs,
           COUNT(j.id) FILTER (WHERE ${HIRED}) AS hired
           FROM jobs j JOIN services s ON s.id = j.service_id
          WHERE j.deleted_at IS NULL AND j.created_at >= $1 AND j.created_at <= $2
          GROUP BY s.id, s.name, s.is_active`,
        [w.from, w.to],
      ),
      // ArtisansService.buildSearchQb's visibility rule, as of `to`.
      this.q(
        `SELECT s.id, s.name, s.is_active, COUNT(DISTINCT ap.id) AS artisans
           FROM artisan_profile_services aps
           JOIN services s ON s.id = aps.service_id
           JOIN artisan_profiles ap ON ap.id = aps.artisan_profile_id
           JOIN users u ON u.id = ap.user_id
          WHERE u.deleted_at IS NULL AND u.is_suspended = false AND u.is_banned = false
            AND ap.is_profile_complete = true AND u.created_at <= $1
          GROUP BY s.id, s.name, s.is_active`,
        [w.to],
      ),
      this.q(
        `WITH k AS (
           SELECT NULLIF(LOWER(BTRIM(REGEXP_REPLACE(j.location, '\\s+', ' ', 'g'))), '') AS area
             FROM jobs j
            WHERE j.deleted_at IS NULL AND j.created_at >= $1 AND j.created_at <= $2
         ), c AS (
           SELECT area, COUNT(*) AS n FROM k WHERE area IS NOT NULL GROUP BY area
         ), r AS (
           SELECT area, n, ROW_NUMBER() OVER (ORDER BY n DESC, area ASC) AS rn FROM c
         )
         SELECT CASE WHEN rn <= ${TOP_AREAS} THEN area END AS area,
                SUM(n) AS jobs, COUNT(*) AS areas, MIN(rn) AS rk
           FROM r GROUP BY 1 ORDER BY MIN(rn)`,
        [w.from, w.to],
      ),
    ]);

    type Svc = {
      serviceId: number;
      serviceName: string;
      isActive: boolean;
      jobs: number;
      hired: number;
      artisans: number;
    };
    const svc = new Map<number, Svc>();
    const touch = (r: Row): Svc => {
      const id = num(r.id);
      let s = svc.get(id);
      if (!s) {
        s = {
          serviceId: id,
          serviceName: text(r.name),
          isActive: r.is_active !== false,
          jobs: 0,
          hired: 0,
          artisans: 0,
        };
        svc.set(id, s);
      }
      return s;
    };
    for (const r of demand) {
      const s = touch(r);
      s.jobs = num(r.jobs);
      s.hired = num(r.hired);
    }
    for (const r of supply) touch(r).artisans = num(r.artisans);

    const byService = [...svc.values()]
      .map((s) => ({
        ...s,
        /** Jobs posted per visible artisan offering it; `null` with no artisans. */
        demandPerArtisan: ratio(s.jobs, s.artisans),
        flag: supplyFlag(s.jobs, s.artisans),
      }))
      .sort(
        (a, b) =>
          b.jobs - a.jobs ||
          b.artisans - a.artisans ||
          a.serviceName.localeCompare(b.serviceName),
      );

    let otherJobs = 0;
    let otherAreas = 0;
    const top: Array<{ area: string; jobs: number }> = [];
    for (const r of areas) {
      if (r.area == null) {
        otherJobs = num(r.jobs);
        otherAreas = num(r.areas);
      } else top.push({ area: text(r.area), jobs: num(r.jobs) });
    }
    const totalAreaJobs = top.reduce((t, a) => t + a.jobs, 0) + otherJobs;

    return {
      byService,
      byArea: {
        /** Normalised job location text (trimmed, lower-case, single spaces). */
        top: top.map((a) => ({ ...a, share: rate(a.jobs, totalAreaJobs) })),
        other: {
          jobs: otherJobs,
          areas: otherAreas,
          share: rate(otherJobs, totalAreaJobs),
        },
        totalJobs: totalAreaJobs,
      },
    };
  }

  // ─── 4. Unit economics ──────────────────────────────────────────────────────

  /** 4 queries: payment totals, revenue per service, cancellations by actor, terminal jobs. */
  private async economics(w: Win) {
    const [totals, perService, cancelActors, terminal] = await Promise.all([
      this.one(
        `SELECT COALESCE(SUM(p.amount), 0) AS gross,
                COALESCE(SUM(p.platform_fee), 0) AS net,
                COALESCE(SUM(p.refunded_amount), 0) AS refunded,
                COUNT(*) AS paid,
                COUNT(*) FILTER (WHERE p.refunded_amount > 0) AS refunded_count
           FROM payments p
          WHERE p.paid_at IS NOT NULL AND p.paid_at >= $1 AND p.paid_at <= $2`,
        [w.from, w.to],
      ),
      this.q(
        `SELECT s.id, s.name,
                COALESCE(SUM(p.amount), 0) AS gross,
                COALESCE(SUM(p.platform_fee), 0) AS net,
                COUNT(*) AS paid
           FROM payments p
           JOIN jobs j ON j.id = p.job_id
           JOIN services s ON s.id = j.service_id
          WHERE p.paid_at IS NOT NULL AND p.paid_at >= $1 AND p.paid_at <= $2
          GROUP BY s.id, s.name
          ORDER BY SUM(p.amount) DESC, s.name ASC`,
        [w.from, w.to],
      ),
      // Who cancelled: the actor on the job's latest CANCELLED history row.
      this.q(
        `SELECT actor, COUNT(*) AS n FROM (
           SELECT COALESCE((
             SELECT CASE
                      WHEN h.changed_by = 'SYSTEM' THEN 'system'
                      WHEN u.role = 'CUSTOMER' THEN 'client'
                      WHEN u.role = 'ARTISAN' THEN 'artisan'
                      WHEN u.role = 'ADMIN' THEN 'admin'
                      ELSE 'unknown'
                    END
               FROM job_status_history h
               LEFT JOIN users u ON u.id::text = h.changed_by
              WHERE h.job_id = j.id AND h.to_status = 'CANCELLED'
              ORDER BY h.created_at DESC, h.id DESC
              LIMIT 1), 'unrecorded') AS actor
             FROM jobs j
            WHERE j.deleted_at IS NULL AND j.status = 'CANCELLED'
              AND j.created_at >= $1 AND j.created_at <= $2
         ) x GROUP BY actor`,
        [w.from, w.to],
      ),
      this.one(
        `SELECT COUNT(*) FILTER (WHERE j.status IN ('COMPLETED', 'CANCELLED', 'EXPIRED')) AS terminal,
                COUNT(*) FILTER (WHERE j.status = 'CANCELLED') AS cancelled
           FROM jobs j
          WHERE j.deleted_at IS NULL AND j.created_at >= $1 AND j.created_at <= $2`,
        [w.from, w.to],
      ),
    ]);

    const gross = num(totals.gross);
    const net = num(totals.net);
    const refunded = num(totals.refunded);
    const paid = num(totals.paid);
    const refundedCount = num(totals.refunded_count);
    const cancelled = num(terminal.cancelled);
    const terminalJobs = num(terminal.terminal);

    const actors = {
      client: 0,
      artisan: 0,
      admin: 0,
      system: 0,
      unknown: 0,
      unrecorded: 0,
    };
    for (const r of cancelActors) {
      const k = text(r.actor) as keyof typeof actors;
      if (k in actors) actors[k] += num(r.n);
      else actors.unknown += num(r.n);
    }

    return {
      grossRevenue: moneyStr(gross),
      netRevenue: moneyStr(net),
      paidPayments: paid,
      /** Gross ÷ paid payments. */
      averageJobValue: averageMoney(gross, paid),
      /** Net (platform fees) ÷ gross, %. */
      takeRate: rate(net, gross),
      refundedAmount: moneyStr(refunded),
      /** Refunded amount ÷ gross, %. */
      refundRateByAmount: rate(refunded, gross),
      refundedPayments: refundedCount,
      /** Payments with any refund ÷ paid payments, %. */
      refundRateByCount: rate(refundedCount, paid),
      revenueByService: perService.map((r) => ({
        serviceId: num(r.id),
        serviceName: text(r.name),
        gross: moneyStr(r.gross),
        net: moneyStr(r.net),
        paidPayments: num(r.paid),
        share: rate(num(r.gross), gross),
      })),
      cancellation: {
        cancelled,
        terminalJobs,
        /** Cancelled ÷ jobs that reached COMPLETED, CANCELLED or EXPIRED, %. */
        rate: rate(cancelled, terminalJobs),
        byActor: actors,
      },
    };
  }

  // ─── 5. Payments health ─────────────────────────────────────────────────────

  /** 5 queries: attempts, holds/failures, duplicates, saved methods, adoption. */
  private async payments(w: Win) {
    const [attempts, holds, duplicates, saved, adoption] = await Promise.all([
      this.q(
        `SELECT c.status, c.method_type, COUNT(*) AS n
           FROM payment_charges c
          WHERE c.created_at >= $1 AND c.created_at <= $2
          GROUP BY c.status, c.method_type`,
        [w.from, w.to],
      ),
      this.q(
        `SELECT p.status, p.payout_hold_reason AS reason, COUNT(*) AS n,
                COALESCE(SUM(p.artisan_amount), 0) AS amount
           FROM payments p
          WHERE p.status IN ('PENDING_TRANSFER', 'TRANSFER_FAILED') AND p.created_at <= $1
          GROUP BY p.status, p.payout_hold_reason`,
        [w.to],
      ),
      this.q(
        `SELECT c.refund_status, COUNT(*) AS n,
                COALESCE(SUM(p.amount), 0) AS amount,
                COALESCE(SUM(c.refund_amount), 0) AS refunded
           FROM payment_charges c JOIN payments p ON p.id = c.payment_id
          WHERE c.status = 'duplicate' AND c.created_at >= $1 AND c.created_at <= $2
          GROUP BY c.refund_status`,
        [w.from, w.to],
      ),
      this.q(
        `SELECT m.type, m.network, COUNT(*) AS n
           FROM customer_payment_methods m JOIN users u ON u.id = m.user_id
          WHERE u.deleted_at IS NULL AND m.created_at <= $1
          GROUP BY m.type, m.network`,
        [w.to],
      ),
      this.one(
        `SELECT COUNT(*) AS customers,
                COUNT(*) FILTER (WHERE EXISTS (
                  SELECT 1 FROM customer_payment_methods m
                   WHERE m.user_id = u.id AND m.created_at <= $1)) AS with_method
           FROM users u
          WHERE u.role = 'CUSTOMER' AND u.deleted_at IS NULL AND u.created_at <= $1`,
        [w.to],
      ),
    ]);

    const outcomes = {
      succeeded: 0,
      failed: 0,
      expired: 0,
      cancelled: 0,
      duplicate: 0,
      inProgress: 0,
    };
    const methods = new Map<string, { attempts: number; succeeded: number }>();
    for (const r of attempts) {
      const n = num(r.n);
      const status = text(r.status);
      if (status === 'succeeded') outcomes.succeeded += n;
      else if (status === 'failed') outcomes.failed += n;
      else if (status === 'expired') outcomes.expired += n;
      else if (status === 'cancelled') outcomes.cancelled += n;
      else if (status === 'duplicate') outcomes.duplicate += n;
      else outcomes.inProgress += n;
      const key = text(r.method_type, 'unknown');
      const m = methods.get(key) ?? { attempts: 0, succeeded: 0 };
      m.attempts += n;
      if (status === 'succeeded' || status === 'duplicate') m.succeeded += n;
      methods.set(key, m);
    }
    const settledAttempts =
      outcomes.succeeded +
      outcomes.failed +
      outcomes.expired +
      outcomes.cancelled;
    const totalAttempts =
      settledAttempts + outcomes.duplicate + outcomes.inProgress;

    const onHold: Array<{ reason: string; count: number; amount: string }> = [];
    const transferFailed = { count: 0, amount: '0.00' };
    for (const r of holds) {
      if (r.status === 'TRANSFER_FAILED') {
        transferFailed.count += num(r.n);
        transferFailed.amount = moneyStr(
          num(transferFailed.amount) + num(r.amount),
        );
      } else {
        onHold.push({
          // An older hold with no reason means "no payout method at all".
          reason: text(r.reason, 'no_payout_method'),
          count: num(r.n),
          amount: moneyStr(r.amount),
        });
      }
    }
    onHold.sort(
      (a, b) => b.count - a.count || a.reason.localeCompare(b.reason),
    );

    const dupRows = duplicates
      .map((r) => ({
        refundStatus: text(r.refund_status, 'not_started'),
        count: num(r.n),
        amount: moneyStr(r.amount),
        refundedAmount: moneyStr(r.refunded),
      }))
      .sort(
        (a, b) =>
          b.count - a.count || a.refundStatus.localeCompare(b.refundStatus),
      );

    const savedByType = { mobile_money: 0, card: 0 };
    const momoNetworks = new Map<string, number>();
    for (const r of saved) {
      const n = num(r.n);
      if (r.type === 'card') savedByType.card += n;
      else if (r.type === 'mobile_money') {
        savedByType.mobile_money += n;
        const net = text(r.network, 'unknown');
        momoNetworks.set(net, (momoNetworks.get(net) ?? 0) + n);
      }
    }
    const momoTotal = savedByType.mobile_money;
    const customers = num(adoption.customers);
    const withMethod = num(adoption.with_method);

    return {
      attempts: {
        total: totalAttempts,
        ...outcomes,
        /** Succeeded ÷ (succeeded + failed + expired + cancelled), %. */
        successRate: rate(outcomes.succeeded, settledAttempts),
      },
      methodMix: [...methods.entries()]
        .map(([method, m]) => ({
          method,
          attempts: m.attempts,
          succeeded: m.succeeded,
          share: rate(m.attempts, totalAttempts),
        }))
        .sort(
          (a, b) => b.attempts - a.attempts || a.method.localeCompare(b.method),
        ),
      /** Payouts parked at PENDING_TRANSFER now, by reason. Not range-scoped. */
      payoutsOnHold: onHold,
      /** Payouts at TRANSFER_FAILED now. Not range-scoped (no failure date is stored). */
      transferFailed,
      duplicateRefunds: {
        count: dupRows.reduce((t, r) => t + r.count, 0),
        amount: moneyStr(dupRows.reduce((t, r) => t + num(r.amount), 0)),
        byRefundStatus: dupRows,
      },
      savedMethods: {
        mobileMoney: savedByType.mobile_money,
        card: savedByType.card,
        momoNetworks: [...momoNetworks.entries()]
          .map(([network, count]) => ({
            network,
            count,
            share: rate(count, momoTotal),
          }))
          .sort(
            (a, b) => b.count - a.count || a.network.localeCompare(b.network),
          ),
        customers,
        customersWithMethod: withMethod,
        /** Clients with at least one saved method ÷ all clients, %. Not range-scoped. */
        adoptionRate: rate(withMethod, customers),
      },
    };
  }

  // ─── 6. Trust and safety ────────────────────────────────────────────────────

  /** 5 queries: scalars, disputes by category, by outcome, moderation, security events. */
  private async trust(w: Win) {
    const [s, byCategory, byOutcome, moderation, security] = await Promise.all([
      this.one(
        `SELECT
           (SELECT COUNT(*) FROM disputes d
             WHERE d.created_at >= $1 AND d.created_at <= $2) AS disputes,
           (SELECT COUNT(*) FROM jobs j
             WHERE j.deleted_at IS NULL AND j.status = 'COMPLETED'
               AND j.created_at >= $1 AND j.created_at <= $2) AS completed_jobs,
           (SELECT COUNT(*) FROM artisan_verifications v
             WHERE v.status = 'APPROVED' AND v.reviewed_at >= $1 AND v.reviewed_at <= $2) AS approved,
           (SELECT COUNT(*) FROM artisan_verifications v
             WHERE v.status = 'REJECTED' AND v.reviewed_at >= $1 AND v.reviewed_at <= $2) AS rejected,
           (SELECT COUNT(*) FROM artisan_verifications v
             WHERE v.status IN ('PENDING', 'UNDER_REVIEW') AND v.created_at <= $2) AS backlog,
           (SELECT EXTRACT(EPOCH FROM ($2::timestamptz - MIN(v.created_at)::timestamptz)) / 3600.0
              FROM artisan_verifications v
             WHERE v.status IN ('PENDING', 'UNDER_REVIEW') AND v.created_at <= $2) AS oldest_pending_hours,
           (SELECT COUNT(*) FROM users u
             WHERE u.deleted_at IS NULL AND u.is_suspended = true AND u.created_at <= $2) AS suspended_now,
           (SELECT COUNT(*) FROM admin_actions a
             WHERE a.action = 'USER_SUSPEND' AND a.created_at >= $1 AND a.created_at <= $2) AS suspended_in_range,
           (SELECT COUNT(*) FROM admin_actions a
             WHERE a.action = 'USER_BAN' AND a.created_at >= $1 AND a.created_at <= $2) AS banned_in_range`,
        [w.from, w.to],
      ),
      this.q(
        `SELECT d.category, COUNT(*) AS n FROM disputes d
          WHERE d.created_at >= $1 AND d.created_at <= $2 GROUP BY d.category`,
        [w.from, w.to],
      ),
      this.q(
        `SELECT d.outcome, COUNT(*) AS n FROM disputes d
          WHERE d.resolved_at >= $1 AND d.resolved_at <= $2 GROUP BY d.outcome`,
        [w.from, w.to],
      ),
      this.q(
        `SELECT m.action, COUNT(*) AS n FROM review_moderation_actions m
          WHERE m.created_at >= $1 AND m.created_at <= $2 GROUP BY m.action`,
        [w.from, w.to],
      ),
      // Counts per event type only: never the user, IP or user agent.
      this.q(
        `SELECT e.event, COUNT(*) AS n FROM account_security_events e
          WHERE e.created_at >= $1 AND e.created_at <= $2 GROUP BY e.event`,
        [w.from, w.to],
      ),
    ]);

    const disputes = num(s.disputes);
    const completedJobs = num(s.completed_jobs);
    const approved = num(s.approved);
    const rejected = num(s.rejected);
    const counted = (rows: Row[], key: string, fallback: string) =>
      rows
        .map((r) => ({
          key: text(r[key], fallback),
          count: num(r.n),
        }))
        .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));

    return {
      disputes: {
        filed: disputes,
        completedJobs,
        /** Disputes filed ÷ jobs completed (both in range) × 100. */
        per100CompletedJobs: per100(disputes, completedJobs),
        byCategory: counted(byCategory, 'category', 'UNCATEGORISED'),
        /** Disputes resolved in the range, by the verdict recorded. */
        byOutcome: counted(byOutcome, 'outcome', 'NONE_RECORDED'),
      },
      verifications: {
        approved,
        rejected,
        approvalRate: rate(approved, approved + rejected),
        rejectionRate: rate(rejected, approved + rejected),
        /** PENDING or UNDER_REVIEW now. Not range-scoped. */
        pendingBacklog: num(s.backlog),
        oldestPendingHours:
          s.oldest_pending_hours == null
            ? null
            : round(Math.max(0, num(s.oldest_pending_hours)), 1),
      },
      suspensions: {
        /** Accounts suspended now. Not range-scoped. */
        current: num(s.suspended_now),
        /** Suspensions recorded in the admin audit log in the range. */
        newInRange: num(s.suspended_in_range),
        bansInRange: num(s.banned_in_range),
      },
      moderationActions: counted(moderation, 'action', 'UNKNOWN'),
      securityEvents: counted(security, 'event', 'unknown'),
    };
  }

  // ─── 7. Artisan health ──────────────────────────────────────────────────────

  /** 3 queries: activation checklist + 30-day activity, earnings quartiles, booking responses. */
  private async artisans(w: Win) {
    const activeFrom = new Date(w.to.getTime() - ACTIVE_DAYS * DAY_MS);
    const [checklist, earnings, bookings] = await Promise.all([
      this.one(
        `WITH a AS (
           SELECT
             COALESCE(ap.is_profile_complete, false) AS complete,
             COALESCE(ap.is_verified, false) AS verified,
             EXISTS (SELECT 1 FROM artisan_profile_services s
                      WHERE s.artisan_profile_id = ap.id) AS has_service,
             EXISTS (SELECT 1 FROM artisan_availability av
                      WHERE av.artisan_profile_id = ap.id AND av.is_active = true) AS has_hours,
             (ap.paystack_recipient_code IS NOT NULL) AS has_payout,
             (COALESCE(ap.is_profile_complete, false)
               AND u.is_suspended = false AND u.is_banned = false) AS visible,
             (EXISTS (SELECT 1 FROM job_applications ja
                       WHERE ja.artisan_id = u.id AND ja.created_at >= $2 AND ja.created_at <= $1)
              OR EXISTS (SELECT 1 FROM jobs j JOIN job_status_history h ON h.job_id = j.id
                          WHERE j.accepted_artisan_id = u.id
                            AND h.created_at >= $2 AND h.created_at <= $1)
              OR EXISTS (SELECT 1 FROM bookings b
                          WHERE b.artisan_profile_id = ap.id
                            AND b.created_at >= $2 AND b.created_at <= $1)) AS active
             FROM users u LEFT JOIN artisan_profiles ap ON ap.user_id = u.id
            WHERE u.role = 'ARTISAN' AND u.deleted_at IS NULL AND u.created_at <= $1
         )
         SELECT COUNT(*) AS total,
           COUNT(*) FILTER (WHERE complete) AS complete,
           COUNT(*) FILTER (WHERE verified) AS verified,
           COUNT(*) FILTER (WHERE has_service) AS has_service,
           COUNT(*) FILTER (WHERE has_hours) AS has_hours,
           COUNT(*) FILTER (WHERE has_payout) AS has_payout,
           COUNT(*) FILTER (WHERE visible) AS visible,
           COUNT(*) FILTER (WHERE complete AND verified AND has_service AND has_hours
                              AND has_payout AND visible) AS fully,
           COUNT(*) FILTER (WHERE active) AS active
           FROM a`,
        [w.to, activeFrom],
      ),
      this.one(
        `SELECT COUNT(*) AS n,
           percentile_cont(0.25) WITHIN GROUP (ORDER BY e) AS q1,
           percentile_cont(0.5) WITHIN GROUP (ORDER BY e) AS median,
           percentile_cont(0.75) WITHIN GROUP (ORDER BY e) AS q3,
           MIN(e) AS min, MAX(e) AS max
           FROM (SELECT p.artisan_profile_id, SUM(p.artisan_amount) AS e
                   FROM payments p
                  WHERE p.status = 'RELEASED' AND p.released_at >= $1 AND p.released_at <= $2
                  GROUP BY p.artisan_profile_id) x`,
        [w.from, w.to],
      ),
      this.one(
        `SELECT COUNT(*) AS total,
           COUNT(*) FILTER (WHERE b.status IN ('CONFIRMED', 'DECLINED', 'COMPLETED', 'NO_SHOW')
             OR (b.status = 'CANCELLED' AND EXISTS (SELECT 1 FROM jobs j WHERE j.booking_id = b.id))) AS responded,
           COUNT(*) FILTER (WHERE b.status = 'EXPIRED') AS expired,
           COUNT(*) FILTER (WHERE b.status = 'PENDING') AS pending,
           COUNT(*) FILTER (WHERE b.status = 'CANCELLED'
             AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.booking_id = b.id)) AS withdrawn
           FROM bookings b
          WHERE b.created_at >= $1 AND b.created_at <= $2`,
        [w.from, w.to],
      ),
    ]);

    const total = num(checklist.total);
    const fully = num(checklist.fully);
    const n = num(earnings.n);
    const enough = n >= MIN_SAMPLE;
    const responded = num(bookings.responded);
    const expired = num(bookings.expired);

    return {
      activation: {
        /** Artisan accounts (not deleted) as of the end of the range. */
        total,
        profileComplete: num(checklist.complete),
        verified: num(checklist.verified),
        hasService: num(checklist.has_service),
        hasWorkingHours: num(checklist.has_hours),
        hasPayoutMethod: num(checklist.has_payout),
        visibleInSearch: num(checklist.visible),
        fullyActivated: fully,
        fullyActivatedRate: rate(fully, total),
      },
      /** Last 30 days to the end of the range — not the selected range. */
      activeLast30Days: num(checklist.active),
      activeLast30DaysRate: rate(num(checklist.active), total),
      earnings: {
        /** Artisans with at least one payout released in the range. */
        n,
        q1: enough ? moneyStr(earnings.q1) : null,
        median: enough ? moneyStr(earnings.median) : null,
        q3: enough ? moneyStr(earnings.q3) : null,
        min: enough ? moneyStr(earnings.min) : null,
        max: enough ? moneyStr(earnings.max) : null,
      },
      bookingResponse: {
        requests: num(bookings.total),
        responded,
        expired,
        pending: num(bookings.pending),
        /** Cancelled by the client before the artisan answered. */
        withdrawn: num(bookings.withdrawn),
        /** Responded ÷ (responded + expired), %. */
        responseRate: rate(responded, responded + expired),
      },
    };
  }

  // ─── 8. Retention ───────────────────────────────────────────────────────────

  /** 2 queries: repeat clients/pairs in range, sign-up cohorts (last 6 months). */
  private async retention(w: Win) {
    const cohortFrom = monthStartUtc(w.to, COHORT_MONTHS - 1);
    const [repeat, cohortRows] = await Promise.all([
      this.one(
        `WITH p AS (
           SELECT p.customer_id, p.artisan_profile_id, p.job_id FROM payments p
            WHERE p.paid_at IS NOT NULL AND p.paid_at >= $1 AND p.paid_at <= $2
         ), c AS (
           SELECT customer_id, COUNT(DISTINCT job_id) AS n FROM p GROUP BY customer_id
         ), pr AS (
           SELECT customer_id, artisan_profile_id, COUNT(DISTINCT job_id) AS n
             FROM p GROUP BY customer_id, artisan_profile_id
         )
         SELECT (SELECT COUNT(*) FROM c) AS clients,
                (SELECT COUNT(*) FROM c WHERE n >= 2) AS repeat_clients,
                (SELECT COUNT(*) FROM pr) AS pairs,
                (SELECT COUNT(*) FROM pr WHERE n >= 2) AS repeat_pairs`,
        [w.from, w.to],
      ),
      this.q(
        `WITH cohort AS (
           SELECT u.id, DATE_TRUNC('month', u.created_at) AS m FROM users u
            WHERE u.role = 'CUSTOMER' AND u.deleted_at IS NULL
              AND u.created_at >= $1 AND u.created_at <= $2
         ), act AS (
           SELECT j.customer_id AS uid, DATE_TRUNC('month', j.created_at) AS m FROM jobs j
            WHERE j.deleted_at IS NULL AND j.created_at >= $1 AND j.created_at <= $2
           UNION
           SELECT p.customer_id, DATE_TRUNC('month', p.paid_at::timestamp) FROM payments p
            WHERE p.paid_at >= $1 AND p.paid_at <= $2
         )
         SELECT TO_CHAR(c.m, 'YYYY-MM') AS cohort, -1 AS off, COUNT(*) AS n
           FROM cohort c GROUP BY c.m
         UNION ALL
         SELECT TO_CHAR(c.m, 'YYYY-MM'),
                ((EXTRACT(YEAR FROM a.m) * 12 + EXTRACT(MONTH FROM a.m))
                  - (EXTRACT(YEAR FROM c.m) * 12 + EXTRACT(MONTH FROM c.m)))::int,
                COUNT(DISTINCT c.id)
           FROM cohort c JOIN act a ON a.uid = c.id AND a.m >= c.m
          GROUP BY 1, 2`,
        [cohortFrom, w.to],
      ),
    ]);

    const clients = num(repeat.clients);
    const repeatClients = num(repeat.repeat_clients);
    const pairs = num(repeat.pairs);
    const repeatPairs = num(repeat.repeat_pairs);
    const sizes: Array<{ cohort: string; n: number }> = [];
    const active: Array<{ cohort: string; offset: number; n: number }> = [];
    for (const r of cohortRows) {
      const off = num(r.off);
      if (off < 0) sizes.push({ cohort: text(r.cohort), n: num(r.n) });
      else active.push({ cohort: text(r.cohort), offset: off, n: num(r.n) });
    }

    return {
      /** Clients with a paid job in the range. */
      payingClients: clients,
      repeatClients,
      /** Clients with ≥ 2 paid jobs ÷ clients with ≥ 1, %. */
      repeatClientRate: rate(repeatClients, clients),
      pairs,
      repeatPairs,
      /** Client–artisan pairs with ≥ 2 paid jobs together ÷ all pairs, %. */
      repeatPairRate: rate(repeatPairs, pairs),
      /** Last 6 calendar months of client sign-ups — not the selected range. */
      cohorts: buildCohorts(w.to, sizes, active),
    };
  }

  // ─── 9. Reviews ─────────────────────────────────────────────────────────────

  /** 3 queries: star distribution, average per bucket, review rate. */
  private async reviews(w: Win) {
    const [dist, trend, reviewRate] = await Promise.all([
      this.q(
        `SELECT LEAST(5, GREATEST(1, ROUND(r.rating)))::int AS star, COUNT(*) AS n,
                SUM(r.rating) AS total
           FROM reviews r WHERE r.created_at >= $1 AND r.created_at <= $2
          GROUP BY 1`,
        [w.from, w.to],
      ),
      this.q(
        `SELECT DATE_TRUNC('${w.bucket}', r.created_at) AS bucket,
                AVG(r.rating) AS average, COUNT(*) AS n
           FROM reviews r WHERE r.created_at >= $1 AND r.created_at <= $2
          GROUP BY 1 ORDER BY 1`,
        [w.from, w.to],
      ),
      this.one(
        `SELECT COUNT(*) AS completed,
                COUNT(*) FILTER (WHERE EXISTS (
                  SELECT 1 FROM reviews r WHERE r.job_id = j.id)) AS reviewed
           FROM jobs j
          WHERE j.deleted_at IS NULL AND j.status = 'COMPLETED'
            AND j.created_at >= $1 AND j.created_at <= $2`,
        [w.from, w.to],
      ),
    ]);

    const distribution = [1, 2, 3, 4, 5].map((star) => ({ star, count: 0 }));
    let count = 0;
    let sum = 0;
    for (const r of dist) {
      const star = num(r.star);
      const n = num(r.n);
      if (star >= 1 && star <= 5) distribution[star - 1].count += n;
      count += n;
      sum += num(r.total);
    }
    const completed = num(reviewRate.completed);
    const reviewed = num(reviewRate.reviewed);

    return {
      count,
      averageRating: count > 0 ? round(sum / count, 2) : null,
      distribution,
      trend: trend.map((r) => ({
        bucket: bucketKey(r.bucket),
        averageRating: num(r.n) > 0 ? round(num(r.average), 2) : null,
        count: num(r.n),
      })),
      completedJobs: completed,
      reviewedJobs: reviewed,
      /** Completed jobs (created in range) with a review ÷ completed jobs, %. */
      reviewRate: rate(reviewed, completed),
    };
  }
}

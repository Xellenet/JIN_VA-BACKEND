import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ObjectLiteral, Repository, SelectQueryBuilder } from 'typeorm';
import { User } from '@users/entities/user.entity';
import { ArtisanProfile } from '@users/entities/artisan-profile.entity';
import { Job } from '@jobs/entities/job.entity';
import { Booking } from '../bookings/entities/booking.entity';
import { Payment } from '../payments/entities/payment.entity';
import { DisputesService } from '../disputes/disputes.service';
import { AnalyticsRange, Role, Status } from '@common/types/enums';
import {
  AnalyticsWindow,
  bucketKey,
  money,
  num,
  percent,
  resolveWindow,
  truncUnit,
} from './analytics.util';

/**
 * AP4: the statuses that count as "completed" and the denominator for the
 * completion rate, defined in exactly one place and documented verbatim in
 * `api-contract.md` so QA can verify the number by hand.
 *
 * Numerator:   jobs with status `COMPLETED`.
 * Denominator: jobs that have reached a **terminal** state — `COMPLETED`,
 *              `CANCELLED` or `EXPIRED`.
 *
 * Jobs still in flight (`OPEN`, `PENDING`, `IN_PROGRESS`) are excluded from
 * both. Including them would drag the rate down purely because work is
 * ongoing, which would make PRD §11's ">85%" target unmeasurable rather than
 * merely hard.
 */
const COMPLETED_STATUSES: Status[] = [Status.COMPLETED];
const TERMINAL_STATUSES: Status[] = [
  Status.COMPLETED,
  Status.CANCELLED,
  Status.EXPIRED,
];

/** AP2: an artisan needs at least one real review to be ranked "top by rating". */
const TOP_ARTISAN_MIN_REVIEWS = 1;
const TOP_ARTISAN_LIMIT = 5;
const TOP_CATEGORY_LIMIT = 6;

/** One bucket of a time series. Exported so the controller's inferred return type is nameable. */
export interface SeriesPoint {
  bucket: string;
  [key: string]: string | number;
}

/**
 * DC2.4: the section names that can appear in a rollup's `degraded` list.
 *
 * They are the response's own paths, so a consumer can map a name straight to
 * the field it must render as unavailable. Documented verbatim in
 * `api-contract.md`.
 */
export const ANALYTICS_SECTIONS = [
  'kpis',
  'previous',
  'series.userGrowth',
  'series.bookingVolume',
  'series.revenue',
  'topServiceCategories',
  'topArtisans',
  'disputes',
] as const;

export type AnalyticsSection = (typeof ANALYTICS_SECTIONS)[number];

/**
 * AN1/AP1–AP4: the platform-wide analytics rollup behind
 * `GET /admin/analytics`.
 *
 * Reuses the four aggregate patterns already established in this codebase
 * rather than inventing a fifth:
 *  - parallel scalar counts (`AdminService.getStats`),
 *  - `groupBy` + `getRawMany` for every time series,
 *  - `AVG`/`COUNT` with `COALESCE` for the derived rates,
 *  - and the cron-refreshed cache (`PlatformRatingCacheService`), applied by
 *    {@link PlatformAnalyticsCacheService} which wraps this service.
 *
 * Two load-bearing gotchas, both already documented elsewhere in the repo:
 *  - `@RelationId()` virtual properties (`Job.serviceId`, `Job.customerId`,
 *    `Job.acceptedArtisanId`, `Booking.customerId`, `Booking.serviceId`)
 *    **cannot** appear in raw select/groupBy strings. Every grouping below
 *    joins the relation and groups on the joined alias, or uses the raw
 *    snake_case column.
 *  - Postgres returns `COUNT`/`AVG`/`SUM` as text. Every aggregate is wrapped
 *    in `Number()` via the `num`/`money` helpers, or the frontend gets strings
 *    where it expects numbers and charts render subtly wrong.
 */
@Injectable()
export class AdminAnalyticsService {
  private readonly logger = new Logger(AdminAnalyticsService.name);

  constructor(
    @InjectRepository(User)
    private readonly usersRepo: Repository<User>,
    @InjectRepository(ArtisanProfile)
    private readonly profileRepo: Repository<ArtisanProfile>,
    @InjectRepository(Job)
    private readonly jobsRepo: Repository<Job>,
    @InjectRepository(Booking)
    private readonly bookingsRepo: Repository<Booking>,
    @InjectRepository(Payment)
    private readonly paymentsRepo: Repository<Payment>,
    /** DR6/AP3: reuses the dispute resolution-time aggregate, not a second copy. */
    private readonly disputesService: DisputesService,
  ) {}

  /**
   * DC2.4: one failing sub-query costs one figure, not the whole endpoint.
   *
   * This used to be a single `Promise.all`, which meant any one of the eight
   * sub-queries rejecting rejected the entire rollup — KPIs, every series,
   * categories and the dispute SLA included. A syntax error in one raw
   * subquery therefore took `GET /admin/analytics` down completely, and the
   * 10-minute refresh cron failed the same way with no fallback.
   *
   * `Promise.allSettled` isolates each section. The hard guardrail on the
   * partial result is that a **failed section is `null`, never `0` and never
   * `[]`** — an admin must be able to tell "we could not compute revenue"
   * apart from "revenue was GH₵ 0.00". Every failed section is additionally
   * named in `degraded` and logged at error level with the range and the
   * section name, so the outage is loud rather than a plausible-looking zero.
   *
   * See `docs/team/admin-disputes-closeout/api-contract.md` — a `null` section
   * means "unavailable, render it as unavailable".
   */
  async build(range: AnalyticsRange) {
    const w = resolveWindow(range);

    const settled = await Promise.allSettled([
      this.scalarKpis(w.from, w.to),
      // AN3: the immediately preceding equivalent period, so a trend chip is
      // a real comparison or absent — never an invented percentage.
      w.previous
        ? this.scalarKpis(w.previous.from, w.previous.to)
        : Promise.resolve(null),
      this.userGrowthSeries(w),
      this.bookingVolumeSeries(w),
      this.revenueSeries(w),
      this.topServiceCategories(w),
      this.topArtisans(),
      this.disputesService.getResolutionMetrics(w.from ?? undefined, w.to),
    ] as const);

    const degraded: AnalyticsSection[] = [];
    const unwrap = <T>(
      result: PromiseSettledResult<T>,
      section: AnalyticsSection,
    ): T | null => {
      if (result.status === 'fulfilled') return result.value;
      degraded.push(section);
      const reason: unknown = result.reason;
      this.logger.error(
        `Platform analytics section "${section}" failed for range ${range}: ${
          reason instanceof Error ? reason.message : String(reason)
        }`,
        reason instanceof Error ? reason.stack : undefined,
      );
      return null;
    };

    const kpis = unwrap(settled[0], 'kpis');
    const previousKpis = unwrap(settled[1], 'previous');
    const userGrowth = unwrap(settled[2], 'series.userGrowth');
    const bookingVolume = unwrap(settled[3], 'series.bookingVolume');
    const revenue = unwrap(settled[4], 'series.revenue');
    const topCategories = unwrap(settled[5], 'topServiceCategories');
    const topArtisans = unwrap(settled[6], 'topArtisans');
    const disputes = unwrap(settled[7], 'disputes');

    return {
      range: w.range,
      bucket: w.bucket,
      from: w.from?.toISOString() ?? null,
      to: w.to.toISOString(),
      generatedAt: new Date().toISOString(),
      kpis,
      /**
       * `null` for a range with nothing before it — omit the trend, don't fake
       * it. Also `null` when the comparison period failed to compute, in which
       * case `previous` is listed in `degraded`; the two cases are told apart
       * by that list, never by the value.
       */
      previous: previousKpis,
      series: {
        userGrowth,
        bookingVolume,
        revenue,
      },
      topServiceCategories: topCategories,
      topArtisans,
      disputes,
      /**
       * DC2.4: the sections that could not be computed. Empty on a healthy
       * rollup. A named section's value is `null` and must be rendered as
       * unavailable — never as a zero, an empty list or a flat line.
       */
      degraded: degraded,
    };
  }

  // ─── Scalar KPIs (parallel-count pattern) ────────────────────────────────────

  /**
   * AP1/AP2/AP4. Every figure here is scoped to `[from, to]` **except** the
   * three explicitly labelled all-time platform totals and `bookingsThisMonth`,
   * which PRD §5.13 names as a calendar-month KPI rather than a range one.
   */
  private async scalarKpis(from: Date | null, to: Date) {
    const startOfMonth = new Date(
      Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), 1),
    );

    const [
      newUsers,
      newClients,
      newArtisans,
      totalUsers,
      totalClients,
      totalArtisans,
      bookings,
      bookingsThisMonth,
      revenueTotals,
      completion,
      activeJobs,
    ] = await Promise.all([
      this.countInWindow(this.usersRepo.createQueryBuilder('u'), 'u', from, to),
      this.countInWindow(
        this.usersRepo
          .createQueryBuilder('u')
          .where('u.role = :role', { role: Role.CUSTOMER }),
        'u',
        from,
        to,
      ),
      this.countInWindow(
        this.usersRepo
          .createQueryBuilder('u')
          .where('u.role = :role', { role: Role.ARTISAN }),
        'u',
        from,
        to,
      ),
      this.usersRepo.count(),
      this.usersRepo.count({ where: { role: Role.CUSTOMER } }),
      this.usersRepo.count({ where: { role: Role.ARTISAN } }),
      this.countInWindow(
        this.bookingsRepo.createQueryBuilder('b'),
        'b',
        from,
        to,
      ),
      this.countInWindow(
        this.bookingsRepo.createQueryBuilder('b'),
        'b',
        startOfMonth,
        to,
      ),
      this.revenueTotals(from, to),
      this.completionRate(from, to),
      this.jobsRepo.count({ where: { status: Status.IN_PROGRESS } }),
    ]);

    return {
      /** New sign-ups inside the selected range. */
      newUsers,
      newClients,
      newArtisans,
      /** All-time platform totals — deliberately not range-scoped. */
      totalUsers,
      totalClients,
      totalArtisans,
      /** Bookings created inside the selected range. */
      bookings,
      /** PRD §5.13: calendar-month KPI, not range-scoped. */
      bookingsThisMonth,
      /** AP1: gross (total transacted) and net (the platform's fee take). */
      grossRevenue: revenueTotals.gross,
      netRevenue: revenueTotals.net,
      refundedAmount: revenueTotals.refunded,
      artisanPayouts: revenueTotals.artisanPayouts,
      paidPayments: revenueTotals.count,
      /** AP4: see COMPLETED_STATUSES / TERMINAL_STATUSES above. */
      completionRate: completion.rate,
      completedJobs: completion.completed,
      terminalJobs: completion.terminal,
      /** Jobs currently IN_PROGRESS — a live figure, not range-scoped. */
      activeJobs,
    };
  }

  private async countInWindow<T extends ObjectLiteral>(
    qb: SelectQueryBuilder<T>,
    alias: string,
    from: Date | null,
    to: Date,
  ): Promise<number> {
    if (from) qb.andWhere(`${alias}.created_at >= :from`, { from });
    qb.andWhere(`${alias}.created_at <= :to`, { to });
    return qb.getCount();
  }

  /**
   * AP1: gross vs net revenue.
   *
   * Population: payments the customer actually paid for — `paid_at IS NOT
   * NULL`, bucketed/filtered on `paid_at` (the moment money was collected),
   * not `created_at` (the moment the record was written, which can be days
   * earlier). `gross` is what was transacted, `net` is the platform's fee
   * take, and `refunded` is returned as its own figure so gross-minus-refunds
   * is derivable without either number being quietly adjusted.
   */
  private async revenueTotals(from: Date | null, to: Date) {
    const qb = this.paymentsRepo
      .createQueryBuilder('p')
      .select('COALESCE(SUM(p.amount), 0)', 'gross')
      .addSelect('COALESCE(SUM(p.platform_fee), 0)', 'net')
      .addSelect('COALESCE(SUM(p.artisan_amount), 0)', 'artisanPayouts')
      .addSelect('COALESCE(SUM(p.refunded_amount), 0)', 'refunded')
      .addSelect('COUNT(p.id)', 'count')
      .where('p.paid_at IS NOT NULL')
      .andWhere('p.paid_at <= :to', { to });
    if (from) qb.andWhere('p.paid_at >= :from', { from });

    const row = await qb.getRawOne<{
      gross: string;
      net: string;
      artisanPayouts: string;
      refunded: string;
      count: string;
    }>();

    return {
      gross: money(row?.gross),
      net: money(row?.net),
      artisanPayouts: money(row?.artisanPayouts),
      refunded: money(row?.refunded),
      count: num(row?.count),
    };
  }

  /**
   * AP4: completion rate, over jobs **created** in the range that have reached
   * a terminal state. Returns 0 (not NaN, not a division by zero) when no job
   * in the range has finished yet.
   */
  private async completionRate(from: Date | null, to: Date) {
    const qb = this.jobsRepo
      .createQueryBuilder('j')
      .select(
        `COUNT(*) FILTER (WHERE j.status IN (:...completed))`,
        'completed',
      )
      .addSelect(
        `COUNT(*) FILTER (WHERE j.status IN (:...terminal))`,
        'terminal',
      )
      .setParameters({
        completed: COMPLETED_STATUSES,
        terminal: TERMINAL_STATUSES,
      })
      .where('j.created_at <= :to', { to });
    if (from) qb.andWhere('j.created_at >= :from', { from });

    const row = await qb.getRawOne<{ completed: string; terminal: string }>();
    const completed = num(row?.completed);
    const terminal = num(row?.terminal);
    return { completed, terminal, rate: percent(completed, terminal) };
  }

  // ─── Time series (groupBy + getRawMany pattern) ──────────────────────────────

  /** AP1: new clients and new artisans per bucket. */
  private async userGrowthSeries(w: AnalyticsWindow): Promise<SeriesPoint[]> {
    const unit = truncUnit(w.bucket);
    const qb = this.usersRepo
      .createQueryBuilder('u')
      .select(`DATE_TRUNC('${unit}', u.created_at)`, 'bucket')
      .addSelect(`COUNT(*) FILTER (WHERE u.role = :customer)`, 'clients')
      .addSelect(`COUNT(*) FILTER (WHERE u.role = :artisan)`, 'artisans')
      .addSelect('COUNT(*)', 'total')
      .setParameters({ customer: Role.CUSTOMER, artisan: Role.ARTISAN })
      .where('u.created_at <= :to', { to: w.to })
      .groupBy('bucket')
      .orderBy('bucket', 'ASC');
    if (w.from) qb.andWhere('u.created_at >= :from', { from: w.from });

    const rows = await qb.getRawMany<{
      bucket: Date;
      clients: string;
      artisans: string;
      total: string;
    }>();

    return rows.map((r) => ({
      bucket: bucketKey(r.bucket),
      clients: num(r.clients),
      artisans: num(r.artisans),
      total: num(r.total),
    }));
  }

  /** AP1: booking volume per bucket, split by whether it completed. */
  private async bookingVolumeSeries(
    w: AnalyticsWindow,
  ): Promise<SeriesPoint[]> {
    const unit = truncUnit(w.bucket);
    const qb = this.bookingsRepo
      .createQueryBuilder('b')
      .select(`DATE_TRUNC('${unit}', b.created_at)`, 'bucket')
      .addSelect('COUNT(*)', 'bookings')
      .addSelect(`COUNT(*) FILTER (WHERE b.status = 'COMPLETED')`, 'completed')
      .addSelect(`COUNT(*) FILTER (WHERE b.status = 'CANCELLED')`, 'cancelled')
      .where('b.created_at <= :to', { to: w.to })
      .groupBy('bucket')
      .orderBy('bucket', 'ASC');
    if (w.from) qb.andWhere('b.created_at >= :from', { from: w.from });

    const rows = await qb.getRawMany<{
      bucket: Date;
      bookings: string;
      completed: string;
      cancelled: string;
    }>();

    return rows.map((r) => ({
      bucket: bucketKey(r.bucket),
      bookings: num(r.bookings),
      completed: num(r.completed),
      cancelled: num(r.cancelled),
    }));
  }

  /**
   * AP1: gross and net revenue as two distinguishable series (PRD §5.13 asks
   * for both, and no screen showed either honestly).
   */
  private async revenueSeries(w: AnalyticsWindow): Promise<SeriesPoint[]> {
    const unit = truncUnit(w.bucket);
    const qb = this.paymentsRepo
      .createQueryBuilder('p')
      .select(`DATE_TRUNC('${unit}', p.paid_at)`, 'bucket')
      .addSelect('COALESCE(SUM(p.amount), 0)', 'gross')
      .addSelect('COALESCE(SUM(p.platform_fee), 0)', 'net')
      .addSelect('COALESCE(SUM(p.refunded_amount), 0)', 'refunded')
      .where('p.paid_at IS NOT NULL')
      .andWhere('p.paid_at <= :to', { to: w.to })
      .groupBy('bucket')
      .orderBy('bucket', 'ASC');
    if (w.from) qb.andWhere('p.paid_at >= :from', { from: w.from });

    const rows = await qb.getRawMany<{
      bucket: Date;
      gross: string;
      net: string;
      refunded: string;
    }>();

    return rows.map((r) => ({
      bucket: bucketKey(r.bucket),
      gross: money(r.gross),
      net: money(r.net),
      refunded: money(r.refunded),
    }));
  }

  /**
   * AP1: real job volume per service category, replacing the hardcoded
   * six-category list with its invented percentage bars.
   *
   * `Job.serviceId` is a `@RelationId` and cannot be used in a raw groupBy —
   * the relation is joined and grouped on the joined alias instead.
   */
  private async topServiceCategories(w: AnalyticsWindow) {
    const qb = this.jobsRepo
      .createQueryBuilder('j')
      .innerJoin('j.service', 'service')
      .select('service.id', 'serviceId')
      .addSelect('service.name', 'serviceName')
      .addSelect('COUNT(j.id)', 'jobs')
      .addSelect(
        `COUNT(*) FILTER (WHERE j.status = '${Status.COMPLETED}')`,
        'completed',
      )
      .where('j.created_at <= :to', { to: w.to })
      .groupBy('service.id')
      .addGroupBy('service.name')
      .orderBy('COUNT(j.id)', 'DESC')
      .limit(TOP_CATEGORY_LIMIT);
    if (w.from) qb.andWhere('j.created_at >= :from', { from: w.from });

    const rows = await qb.getRawMany<{
      serviceId: string;
      serviceName: string;
      jobs: string;
      completed: string;
    }>();

    const total = rows.reduce((sum, r) => sum + num(r.jobs), 0);
    return rows.map((r) => ({
      serviceId: num(r.serviceId),
      serviceName: r.serviceName,
      jobs: num(r.jobs),
      completedJobs: num(r.completed),
      /** Share of the top-category total, so the bars are a real proportion. */
      share: percent(num(r.jobs), total),
    }));
  }

  /**
   * AP2: top artisans ranked by the **existing** Bayesian weighted score the
   * reviews round built (`ArtisanProfile.weightedRating`), which exists
   * precisely so artisans are ranked fairly against each other. The plain
   * average and the real review count are returned alongside it because those
   * are what gets *displayed*. No new ranking formula is derived here.
   *
   * Deliberately **all-time, not range-scoped**: `weightedRating` is a stored
   * aggregate over an artisan's whole review history, and there is no honest
   * way to re-derive it for a 7-day window without re-implementing the
   * formula. Documented as all-time in `api-contract.md` so the screen can
   * label it rather than imply it moves with the range selector.
   *
   * ─── DC2.2: why this join alias is `au` and not `user` ──────────────────
   *
   * This query used to alias the joined user as `user`, which is a Postgres
   * **reserved word**, and referenced `user.id` inside the raw correlated
   * subquery below. TypeORM rewrites `alias.property` into
   * `"alias"."column"` across the finished SQL, but its property matcher is
   * `[^ =(),]+` — a class that does not exclude newlines. The subquery had
   * `user.id` immediately followed by a line break, so the matcher swallowed
   * the newline, looked up the key `id\n`, found nothing, and shipped
   * `user.id` **unquoted**. Postgres then failed the whole statement with
   * `42601 syntax error at or near "."`, which took the entire
   * `GET /admin/analytics` rollup down for every range.
   *
   * Three things keep that from recurring, and none of them relies on
   * TypeORM's rewriting firing inside a raw string:
   *  1. the alias is `au` — short, lower-case and not a reserved word, so
   *     even an unquoted, unrewritten `au.id` is valid SQL (Postgres folds
   *     unquoted identifiers to lower case, which matches the emitted
   *     `"au"` alias). Renaming kills the trap class rather than patching
   *     this one instance;
   *  2. the raw subquery spells the correlation out as `"au"."id"` —
   *     already-quoted identifiers are invisible to the rewriter's regex, so
   *     the fragment is correct whether or not the rewrite runs;
   *  3. the status is a **bound parameter**, not interpolated.
   *
   * `test/analytics-admin-disputes.e2e-spec.ts` executes this SQL against a
   * real database, which is the only kind of test that can catch a syntax
   * error here.
   */
  private async topArtisans() {
    const rows = await this.profileRepo
      .createQueryBuilder('ap')
      .innerJoin('ap.user', 'au')
      .select('ap.id', 'artisanProfileId')
      .addSelect('au.id', 'userId')
      .addSelect('au.firstname', 'firstname')
      .addSelect('au.lastname', 'lastname')
      .addSelect('ap.business_name', 'businessName')
      .addSelect('ap.average_rating', 'averageRating')
      .addSelect('ap.weighted_rating', 'weightedRating')
      .addSelect('ap.total_reviews', 'totalReviews')
      .addSelect('ap.is_verified', 'isVerified')
      .addSelect(
        `(SELECT COUNT(*) FROM jobs j WHERE j.accepted_artisan_id = "au"."id" AND j.status = :completedStatus AND j.deleted_at IS NULL)`,
        'completedJobs',
      )
      .setParameter('completedStatus', Status.COMPLETED)
      .where('au.deletedAt IS NULL')
      .andWhere('au.isBanned = false')
      .andWhere('ap.total_reviews >= :minReviews', {
        minReviews: TOP_ARTISAN_MIN_REVIEWS,
      })
      .orderBy('ap.weighted_rating', 'DESC')
      .addOrderBy('ap.total_reviews', 'DESC')
      .limit(TOP_ARTISAN_LIMIT)
      .getRawMany<{
        artisanProfileId: string;
        userId: string;
        firstname: string;
        lastname: string;
        businessName: string | null;
        averageRating: string;
        weightedRating: string;
        totalReviews: string;
        isVerified: boolean;
        completedJobs: string;
      }>();

    return rows.map((r) => ({
      artisanProfileId: num(r.artisanProfileId),
      userId: num(r.userId),
      name: `${r.firstname} ${r.lastname}`,
      businessName: r.businessName,
      /** Displayed: the honest plain average. */
      averageRating: Number(num(r.averageRating).toFixed(2)),
      /** Used for the ordering only — not a customer-facing number. */
      weightedRating: Number(num(r.weightedRating).toFixed(2)),
      totalReviews: num(r.totalReviews),
      completedJobs: num(r.completedJobs),
      isVerified: Boolean(r.isVerified),
    }));
  }
}

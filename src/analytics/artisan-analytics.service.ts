import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ArtisanProfile } from '@users/entities/artisan-profile.entity';
import { Job } from '@jobs/entities/job.entity';
import { Booking } from '../bookings/entities/booking.entity';
import { Payment } from '../payments/entities/payment.entity';
import { Review } from '../reviews/entities/review.entity';
import {
  AnalyticsRange,
  BookingStatus,
  PaymentStatus,
  Status,
} from '@common/types/enums';
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
 * AA1: statuses whose `artisan_amount` counts as money the artisan has
 * actually **been paid**. Only `RELEASED` — the transfer is confirmed.
 */
const EARNED_STATUSES: PaymentStatus[] = [PaymentStatus.RELEASED];

/**
 * AA1: statuses whose `artisan_amount` is earmarked for the artisan but not
 * yet in their account. Reported separately so "total earnings" never
 * overstates what they have.
 */
const PENDING_STATUSES: PaymentStatus[] = [
  PaymentStatus.HELD,
  PaymentStatus.PENDING_TRANSFER,
  PaymentStatus.TRANSFER_FAILED,
];

/**
 * AA3: which bookings count towards the repeat-client rate.
 *
 * Excludes `DECLINED` (the artisan refused it) and `EXPIRED` (it lapsed with
 * no response) — in neither case did the client actually engage this artisan,
 * so counting them would inflate the denominator with non-relationships.
 */
const REPEAT_CLIENT_STATUSES: BookingStatus[] = [
  BookingStatus.PENDING,
  BookingStatus.CONFIRMED,
  BookingStatus.COMPLETED,
  BookingStatus.CANCELLED,
  BookingStatus.NO_SHOW,
];

const TOP_SERVICES_LIMIT = 5;

/**
 * AN1/AA1–AA6: `GET /analytics/artisan`, scoped strictly to the authenticated
 * artisan's own data.
 *
 * The scoping is structural rather than a filter that could be forgotten:
 * every query starts from the `ArtisanProfile` resolved from the JWT's user
 * id, and no method accepts an artisan id from the request. There is no
 * parameter an artisan could substitute to read another artisan's numbers, and
 * no platform-wide figure is returned from this service at all.
 *
 * Computed live rather than cached: each payload is one artisan's own rows,
 * which is a small enough working set that the cron-refresh precedent
 * (`PlatformRatingCacheService`) would add staleness without buying anything.
 * The expensive platform-wide rollups are the ones that follow that precedent
 * — see `PlatformAnalyticsCacheService`.
 */
@Injectable()
export class ArtisanAnalyticsService {
  constructor(
    @InjectRepository(ArtisanProfile)
    private readonly profileRepo: Repository<ArtisanProfile>,
    @InjectRepository(Job)
    private readonly jobsRepo: Repository<Job>,
    @InjectRepository(Booking)
    private readonly bookingsRepo: Repository<Booking>,
    @InjectRepository(Payment)
    private readonly paymentsRepo: Repository<Payment>,
    @InjectRepository(Review)
    private readonly reviewsRepo: Repository<Review>,
  ) {}

  async build(artisanUserId: number, range: AnalyticsRange) {
    const profile = await this.profileRepo.findOne({
      where: { user: { id: artisanUserId } },
    });
    if (!profile) throw new NotFoundException('Artisan profile not found.');

    const w = resolveWindow(range);

    const [
      earnings,
      earningsSeries,
      jobCounts,
      repeatClients,
      ratingTrend,
      topServices,
      overview,
    ] = await Promise.all([
      this.earningsTotals(profile.id, w),
      this.earningsSeries(profile.id, w),
      this.jobCounts(artisanUserId, w),
      this.repeatClientRate(profile.id, w),
      this.ratingTrend(profile.id, w),
      this.topServices(profile.id, w),
      this.overview(profile, artisanUserId),
    ]);

    return {
      range: w.range,
      bucket: w.bucket,
      from: w.from?.toISOString() ?? null,
      to: w.to.toISOString(),
      generatedAt: new Date().toISOString(),
      earnings,
      jobCounts,
      repeatClients,
      ratingTrend,
      topServices,
      overview,
      series: { earnings: earningsSeries },
    };
  }

  /**
   * AA1: total earnings — all time, this month, last month — plus what is
   * earmarked but not yet transferred.
   *
   * "Earnings" means `artisan_amount` on payments that actually reached
   * `RELEASED`, bucketed on `released_at`. Money still `HELD` is reported
   * separately as `pending` rather than folded into the total, so the headline
   * figure is what the artisan has, not what they are owed.
   */
  private async earningsTotals(artisanProfileId: number, w: AnalyticsWindow) {
    const now = w.to;
    const startOfThisMonth = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
    );
    const startOfLastMonth = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1),
    );

    const sumReleased = async (from?: Date, to?: Date) => {
      const qb = this.paymentsRepo
        .createQueryBuilder('p')
        .select('COALESCE(SUM(p.artisan_amount), 0)', 'total')
        .addSelect('COUNT(p.id)', 'count')
        .where('p.artisan_profile_id = :artisanProfileId', { artisanProfileId })
        .andWhere('p.status IN (:...statuses)', { statuses: EARNED_STATUSES });
      if (from) qb.andWhere('p.released_at >= :from', { from });
      if (to) qb.andWhere('p.released_at < :to', { to });
      const row = await qb.getRawOne<{ total: string; count: string }>();
      return { total: money(row?.total), count: num(row?.count) };
    };

    const pendingQb = this.paymentsRepo
      .createQueryBuilder('p')
      .select('COALESCE(SUM(p.artisan_amount), 0)', 'total')
      .addSelect('COUNT(p.id)', 'count')
      .where('p.artisan_profile_id = :artisanProfileId', { artisanProfileId })
      .andWhere('p.status IN (:...statuses)', { statuses: PENDING_STATUSES });

    const [allTime, thisMonth, lastMonth, inRange, pendingRow] =
      await Promise.all([
        sumReleased(),
        sumReleased(startOfThisMonth, undefined),
        sumReleased(startOfLastMonth, startOfThisMonth),
        sumReleased(w.from ?? undefined, undefined),
        pendingQb.getRawOne<{ total: string; count: string }>(),
      ]);

    return {
      allTime: allTime.total,
      thisMonth: thisMonth.total,
      lastMonth: lastMonth.total,
      /** Scoped to the selected range, so it matches the earnings chart. */
      inRange: inRange.total,
      payoutsInRange: inRange.count,
      /** Earmarked but not yet transferred (HELD / PENDING_TRANSFER / TRANSFER_FAILED). */
      pending: money(pendingRow?.total),
      pendingPayments: num(pendingRow?.count),
      currency: 'GHS',
    };
  }

  /** AA1: the earnings line chart — released payout totals per bucket. */
  private async earningsSeries(artisanProfileId: number, w: AnalyticsWindow) {
    const unit = truncUnit(w.bucket);
    const qb = this.paymentsRepo
      .createQueryBuilder('p')
      .select(`DATE_TRUNC('${unit}', p.released_at)`, 'bucket')
      .addSelect('COALESCE(SUM(p.artisan_amount), 0)', 'earnings')
      .addSelect('COUNT(p.id)', 'payouts')
      .where('p.artisan_profile_id = :artisanProfileId', { artisanProfileId })
      .andWhere('p.status IN (:...statuses)', { statuses: EARNED_STATUSES })
      .andWhere('p.released_at IS NOT NULL')
      .andWhere('p.released_at <= :to', { to: w.to })
      .groupBy('bucket')
      .orderBy('bucket', 'ASC');
    if (w.from) qb.andWhere('p.released_at >= :from', { from: w.from });

    const rows = await qb.getRawMany<{
      bucket: Date;
      earnings: string;
      payouts: string;
    }>();

    return rows.map((r) => ({
      bucket: bucketKey(r.bucket),
      earnings: money(r.earnings),
      payouts: num(r.payouts),
    }));
  }

  /**
   * AA2: the completed / cancelled / in-progress breakdown PRD §5.12 requires
   * and the screen had no section for at all. Range-scoped on job creation.
   *
   * `Job.acceptedArtisanId` is a `@RelationId`, so the raw `accepted_artisan_id`
   * column is used rather than the virtual property.
   */
  private async jobCounts(artisanUserId: number, w: AnalyticsWindow) {
    const qb = this.jobsRepo
      .createQueryBuilder('j')
      .select(
        `COUNT(*) FILTER (WHERE j.status = '${Status.COMPLETED}')`,
        'completed',
      )
      .addSelect(
        `COUNT(*) FILTER (WHERE j.status = '${Status.CANCELLED}')`,
        'cancelled',
      )
      .addSelect(
        `COUNT(*) FILTER (WHERE j.status = '${Status.IN_PROGRESS}')`,
        'inProgress',
      )
      .addSelect(
        `COUNT(*) FILTER (WHERE j.status = '${Status.PENDING}')`,
        'pending',
      )
      .addSelect('COUNT(*)', 'total')
      .where('j.accepted_artisan_id = :artisanUserId', { artisanUserId })
      .andWhere('j.created_at <= :to', { to: w.to });
    if (w.from) qb.andWhere('j.created_at >= :from', { from: w.from });

    const row = await qb.getRawOne<{
      completed: string;
      cancelled: string;
      inProgress: string;
      pending: string;
      total: string;
    }>();

    return {
      completed: num(row?.completed),
      cancelled: num(row?.cancelled),
      inProgress: num(row?.inProgress),
      pending: num(row?.pending),
      total: num(row?.total),
    };
  }

  /**
   * AA3: repeat-client rate — PRD §5.12's "percentage of clients who booked
   * more than once".
   *
   * Exact definition (documented in `api-contract.md` so QA can verify by
   * hand):
   *  - Population: bookings for **this artisan** created inside the selected
   *    range whose status is not `DECLINED` and not `EXPIRED` (in neither case
   *    did the client actually engage this artisan).
   *  - Denominator: distinct customers with **≥1** such booking.
   *  - Numerator:   distinct customers with **≥2** such bookings.
   *  - Rate = numerator / denominator × 100, to 1dp. `0` when the denominator
   *    is 0 — never a division by zero, never a fabricated figure.
   *
   * `Booking.customerId` is a `@RelationId`, so the raw `customer_id` column
   * is grouped on.
   */
  private async repeatClientRate(artisanProfileId: number, w: AnalyticsWindow) {
    const inner = this.bookingsRepo
      .createQueryBuilder('b')
      .select('b.customer_id', 'customerId')
      .addSelect('COUNT(*)', 'bookings')
      .where('b.artisan_profile_id = :artisanProfileId', { artisanProfileId })
      .andWhere('b.status IN (:...statuses)', {
        statuses: REPEAT_CLIENT_STATUSES,
      })
      .andWhere('b.created_at <= :to', { to: w.to })
      .groupBy('b.customer_id');
    if (w.from) inner.andWhere('b.created_at >= :from', { from: w.from });

    const rows = await inner.getRawMany<{
      customerId: string;
      bookings: string;
    }>();

    const totalClients = rows.length;
    const repeatClients = rows.filter((r) => num(r.bookings) > 1).length;

    return {
      totalClients,
      repeatClients,
      rate: percent(repeatClients, totalClients),
      definition:
        'Distinct clients with 2+ bookings for this artisan in the selected range, over distinct clients with 1+ such booking. Declined and expired bookings are excluded.',
    };
  }

  /**
   * AA4: average rating over time, computed from the artisan's **raw reviews**
   * (each review's rating and creation date). No rating-snapshot table is
   * added — that was explicitly out of scope.
   *
   * `reviewCount` is returned per bucket so the screen can render an honest
   * sparse state instead of implying a trend from two points.
   */
  private async ratingTrend(artisanProfileId: number, w: AnalyticsWindow) {
    const unit = truncUnit(w.bucket);
    const qb = this.reviewsRepo
      .createQueryBuilder('review')
      .select(`DATE_TRUNC('${unit}', review.created_at)`, 'bucket')
      .addSelect('COALESCE(AVG(review.rating), 0)', 'averageRating')
      .addSelect('COUNT(review.id)', 'reviewCount')
      .where('review.artisan_profile_id = :artisanProfileId', {
        artisanProfileId,
      })
      .andWhere('review.created_at <= :to', { to: w.to })
      .groupBy('bucket')
      .orderBy('bucket', 'ASC');
    if (w.from) qb.andWhere('review.created_at >= :from', { from: w.from });

    const rows = await qb.getRawMany<{
      bucket: Date;
      averageRating: string;
      reviewCount: string;
    }>();

    const points = rows.map((r) => ({
      bucket: bucketKey(r.bucket),
      averageRating: Number(num(r.averageRating).toFixed(2)),
      reviewCount: num(r.reviewCount),
    }));

    return {
      points,
      /** AA4: fewer than two buckets is not a trend — say so, don't draw one. */
      hasEnoughDataForTrend: points.length >= 2,
      reviewsInRange: points.reduce((sum, p) => sum + p.reviewCount, 0),
    };
  }

  /**
   * AA5: booking volume per service for this artisan, replacing the hardcoded
   * five-service list with its invented percentage bars.
   *
   * `Booking.serviceId` is a `@RelationId`, so the relation is joined and
   * grouped on the joined alias.
   */
  private async topServices(artisanProfileId: number, w: AnalyticsWindow) {
    const qb = this.bookingsRepo
      .createQueryBuilder('b')
      .innerJoin('b.service', 'service')
      .select('service.id', 'serviceId')
      .addSelect('service.name', 'serviceName')
      .addSelect('COUNT(b.id)', 'bookings')
      .addSelect(
        `COUNT(*) FILTER (WHERE b.status = '${BookingStatus.COMPLETED}')`,
        'completed',
      )
      .where('b.artisan_profile_id = :artisanProfileId', { artisanProfileId })
      .andWhere('b.created_at <= :to', { to: w.to })
      .groupBy('service.id')
      .addGroupBy('service.name')
      .orderBy('COUNT(b.id)', 'DESC')
      .limit(TOP_SERVICES_LIMIT);
    if (w.from) qb.andWhere('b.created_at >= :from', { from: w.from });

    const rows = await qb.getRawMany<{
      serviceId: string;
      serviceName: string;
      bookings: string;
      completed: string;
    }>();

    const total = rows.reduce((sum, r) => sum + num(r.bookings), 0);
    return rows.map((r) => ({
      serviceId: num(r.serviceId),
      serviceName: r.serviceName,
      bookings: num(r.bookings),
      completedBookings: num(r.completed),
      share: percent(num(r.bookings), total),
    }));
  }

  /**
   * AA6: the all-time counts the artisan Overview stat cards need.
   *
   * They currently fetch the jobs list and filter client-side, which
   * under-counts the moment that list paginates past the fetched page. These
   * are database counts, so they can't.
   */
  private async overview(profile: ArtisanProfile, artisanUserId: number) {
    const [completedAllTime, inProgressAllTime] = await Promise.all([
      this.jobsRepo
        .createQueryBuilder('j')
        .where('j.accepted_artisan_id = :artisanUserId', { artisanUserId })
        .andWhere('j.status = :status', { status: Status.COMPLETED })
        .getCount(),
      this.jobsRepo
        .createQueryBuilder('j')
        .where('j.accepted_artisan_id = :artisanUserId', { artisanUserId })
        .andWhere('j.status = :status', { status: Status.IN_PROGRESS })
        .getCount(),
    ]);

    return {
      completedJobsAllTime: completedAllTime,
      inProgressJobs: inProgressAllTime,
      /** The honest plain average — never the Bayesian ranking score. */
      averageRating: Number(num(profile.averageRating).toFixed(2)),
      totalReviews: num(profile.totalReviews),
      isVerified: profile.isVerified,
    };
  }
}

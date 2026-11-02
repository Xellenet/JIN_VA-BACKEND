import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, SelectQueryBuilder } from 'typeorm';
import { Job } from '@jobs/entities/job.entity';
import { JobApplication } from '@jobs/entities/job-application.entity';
import { Booking } from '../bookings/entities/booking.entity';
import { Payment } from '../payments/entities/payment.entity';
import { ArtisanProfile } from '@users/entities/artisan-profile.entity';
import { Dispute } from '../disputes/entities/dispute.entity';
import {
  ApplicationStatus,
  BookingStatus,
  DisputeStatus,
  Status,
} from '@common/types/enums';
import { VARIABLES } from '@common/constants/variables.constants';
import {
  calendarDate,
  hhmm,
} from '../customer-insights/customer-overview.service';
import {
  ARTISAN_CURRENCY,
  clientName,
  EarningBalances,
  queryBalances,
  resolveArtisanProfileId,
} from './earnings.util';

export interface StageCounts {
  toStart: number;
  inProgress: number;
  awaitingClient: number;
  done: number;
  closed: number;
  total: number;
  applied: number;
}

export interface PendingRequest {
  bookingId: number;
  clientName: string;
  service: { id: number; name: string } | null;
  scheduledDate: string;
  startTime: string | null;
  endTime: string | null;
  location: string | null;
  notes: string | null;
  createdAt: string;
  respondBy: string;
}

export interface OverviewBooking {
  bookingId: number;
  status: BookingStatus;
  clientName: string;
  service: { id: number; name: string } | null;
  scheduledDate: string;
  startTime: string | null;
  endTime: string | null;
  location: string | null;
  notes: string | null;
  artisanNotes: string | null;
  jobId: number | null;
}

export interface OverviewEarnings extends EarningBalances {
  currency: string;
  hasPayoutMethod: boolean;
}

export type ArtisanOverviewSection =
  | 'stageCounts'
  | 'pendingRequests'
  | 'bookings'
  | 'earnings'
  | 'disputes';

export interface ArtisanOverview {
  stageCounts: StageCounts | null;
  pendingRequests: { total: number; items: PendingRequest[] } | null;
  nextBooking: OverviewBooking | null;
  todayBookings: OverviewBooking[] | null;
  earnings: OverviewEarnings | null;
  disputesNeedingResponse: number | null;
  failedSections: ArtisanOverviewSection[];
}

/** Raw booking row (pending requests and confirmed bookings). */
export interface BookingRow {
  id: number | string;
  status: BookingStatus;
  scheduledDate: string | Date;
  startTime: string | null;
  endTime: string | null;
  notes: string | null;
  artisanNotes: string | null;
  createdAt: Date | string;
  serviceId: number | string | null;
  serviceName: string | null;
  jobId: number | string | null;
  jobLocation: string | null;
  clientFirstname: string | null;
  clientLastname: string | null;
  clientGone: boolean | null;
}

export const PENDING_REQUESTS_LIMIT = 10;
export const TODAY_BOOKINGS_LIMIT = 20;

const ACTIVE_DISPUTE_STATUSES = [
  DisputeStatus.OPEN,
  DisputeStatus.UNDER_REVIEW,
];

function service(row: BookingRow): { id: number; name: string } | null {
  return row.serviceId != null
    ? { id: Number(row.serviceId), name: row.serviceName ?? 'Other' }
    : null;
}

export function mapPendingRequest(row: BookingRow): PendingRequest {
  const created = new Date(row.createdAt);
  return {
    bookingId: Number(row.id),
    clientName: clientName(row),
    service: service(row),
    scheduledDate: calendarDate(row.scheduledDate),
    startTime: hhmm(row.startTime),
    endTime: hhmm(row.endTime),
    location: row.jobLocation ?? null,
    notes: row.notes ?? null,
    createdAt: created.toISOString(),
    respondBy: new Date(
      created.getTime() + VARIABLES.BOOKING_EXPIRY_HOURS * 3_600_000,
    ).toISOString(),
  };
}

export function mapOverviewBooking(row: BookingRow): OverviewBooking {
  return {
    bookingId: Number(row.id),
    status: row.status,
    clientName: clientName(row),
    service: service(row),
    scheduledDate: calendarDate(row.scheduledDate),
    startTime: hhmm(row.startTime),
    endTime: hhmm(row.endTime),
    location: row.jobLocation ?? null,
    notes: row.notes ?? null,
    artisanNotes: row.artisanNotes ?? null,
    jobId: row.jobId == null ? null : Number(row.jobId),
  };
}

/**
 * Artisan fixes (B1): "what needs me now" for the artisan Overview.
 *
 * Five independent sections, each in its own try/catch so one failing query
 * costs only that card (`failedSections`). Every query is bound to the
 * artisan's own user id or profile id, both resolved from the JWT. Not
 * cached: an Accept or Decline must show on the very next fetch.
 */
@Injectable()
export class ArtisanOverviewService {
  private readonly logger = new Logger(ArtisanOverviewService.name);

  constructor(
    @InjectRepository(Job) private readonly jobs: Repository<Job>,
    @InjectRepository(JobApplication)
    private readonly applications: Repository<JobApplication>,
    @InjectRepository(Booking) private readonly bookings: Repository<Booking>,
    @InjectRepository(Payment) private readonly payments: Repository<Payment>,
    @InjectRepository(ArtisanProfile)
    private readonly profiles: Repository<ArtisanProfile>,
    @InjectRepository(Dispute) private readonly disputes: Repository<Dispute>,
  ) {}

  async getOverview(
    me: number,
    now: Date = new Date(),
  ): Promise<ArtisanOverview> {
    const profileId = await resolveArtisanProfileId(this.profiles, me);

    const failed: ArtisanOverviewSection[] = [];
    const guard = async <T>(
      section: ArtisanOverviewSection,
      build: () => Promise<T>,
    ): Promise<T | null> => {
      try {
        return await build();
      } catch (err) {
        failed.push(section);
        // No user id or SQL parameters in the log line.
        this.logger.error(
          `Artisan overview section "${section}" failed: ${(err as Error)?.name ?? 'Error'}`,
        );
        return null;
      }
    };

    const [stageCounts, pendingRequests, bookings, earnings, disputes] =
      await Promise.all([
        guard('stageCounts', () => this.buildStageCounts(me)),
        guard('pendingRequests', () => this.buildPendingRequests(profileId)),
        guard('bookings', () => this.buildBookings(profileId, now)),
        guard('earnings', () => this.buildEarnings(profileId, now)),
        guard('disputes', () => this.countDisputesNeedingResponse(me)),
      ]);

    const order: ArtisanOverviewSection[] = [
      'stageCounts',
      'pendingRequests',
      'bookings',
      'earnings',
      'disputes',
    ];
    return {
      stageCounts,
      pendingRequests,
      nextBooking: bookings?.next ?? null,
      todayBookings: bookings?.today ?? null,
      earnings,
      disputesNeedingResponse: disputes,
      failedSections: order.filter((s) => failed.includes(s)),
    };
  }

  async buildStageCounts(me: number): Promise<StageCounts> {
    const [row, applied] = await Promise.all([
      this.jobs
        .createQueryBuilder('j')
        .select(
          `COUNT(*) FILTER (WHERE j.status = '${Status.PENDING}')`,
          'toStart',
        )
        .addSelect(
          `COUNT(*) FILTER (WHERE j.status = '${Status.IN_PROGRESS}' AND j.completion_requested_at IS NULL)`,
          'inProgress',
        )
        .addSelect(
          `COUNT(*) FILTER (WHERE j.status = '${Status.IN_PROGRESS}' AND j.completion_requested_at IS NOT NULL)`,
          'awaitingClient',
        )
        .addSelect(
          `COUNT(*) FILTER (WHERE j.status = '${Status.COMPLETED}')`,
          'done',
        )
        .addSelect(
          `COUNT(*) FILTER (WHERE j.status IN ('${Status.CANCELLED}', '${Status.EXPIRED}'))`,
          'closed',
        )
        .addSelect('COUNT(*)', 'total')
        .where('j.accepted_artisan_id = :me', { me })
        .andWhere('j.deleted_at IS NULL')
        .getRawOne<Record<string, string | number | null>>(),
      this.applications
        .createQueryBuilder('a')
        .innerJoin(Job, 'j', 'j.id = a.job_id')
        .where('a.artisan_id = :me', { me })
        .andWhere('a.status = :pendingApp', {
          pendingApp: ApplicationStatus.PENDING,
        })
        .andWhere('j.status = :open', { open: Status.OPEN })
        .andWhere('j.deleted_at IS NULL')
        .getCount(),
    ]);
    const n = (k: string) => Number(row?.[k] ?? 0);
    return {
      toStart: n('toStart'),
      inProgress: n('inProgress'),
      awaitingClient: n('awaitingClient'),
      done: n('done'),
      closed: n('closed'),
      total: n('total'),
      applied,
    };
  }

  /** The artisan's bookings, joined to service, client and linked job. */
  private bookingQb(profileId: number): SelectQueryBuilder<Booking> {
    return this.bookings
      .createQueryBuilder('b')
      .leftJoin('services', 's', 's.id = b.service_id')
      .leftJoin('users', 'c', 'c.id = b.customer_id')
      .leftJoin('jobs', 'j', 'j.booking_id = b.id AND j.deleted_at IS NULL')
      .select('b.id', 'id')
      .addSelect('b.status', 'status')
      .addSelect('b.scheduled_date', 'scheduledDate')
      .addSelect('b.start_time', 'startTime')
      .addSelect('b.end_time', 'endTime')
      .addSelect('b.notes', 'notes')
      .addSelect('b.artisan_notes', 'artisanNotes')
      .addSelect('b.created_at', 'createdAt')
      .addSelect('s.id', 'serviceId')
      .addSelect('s.name', 'serviceName')
      .addSelect('j.id', 'jobId')
      .addSelect('j.location', 'jobLocation')
      .addSelect('c.firstname', 'clientFirstname')
      .addSelect('c.lastname', 'clientLastname')
      .addSelect(
        '(c.id IS NULL OR c.deleted_at IS NOT NULL OR c.purged_at IS NOT NULL)',
        'clientGone',
      )
      .where('b.artisan_profile_id = :profileId', { profileId });
  }

  async buildPendingRequests(
    profileId: number,
  ): Promise<{ total: number; items: PendingRequest[] }> {
    const [total, rows] = await Promise.all([
      this.bookings
        .createQueryBuilder('b')
        .where('b.artisan_profile_id = :profileId', { profileId })
        .andWhere('b.status = :pending', { pending: BookingStatus.PENDING })
        .getCount(),
      this.bookingQb(profileId)
        .andWhere('b.status = :pending', { pending: BookingStatus.PENDING })
        .orderBy('b.created_at', 'ASC')
        .addOrderBy('b.id', 'ASC')
        .limit(PENDING_REQUESTS_LIMIT)
        .getRawMany<BookingRow>(),
    ]);
    return { total, items: rows.map(mapPendingRequest) };
  }

  /**
   * The next CONFIRMED booking whose end is still ahead (Accra wall clock),
   * and today's CONFIRMED bookings.
   */
  async buildBookings(
    profileId: number,
    now: Date,
  ): Promise<{ next: OverviewBooking | null; today: OverviewBooking[] }> {
    const nowLocal = now.toISOString().slice(0, 19).replace('T', ' ');
    const today = now.toISOString().slice(0, 10);
    const [next, todays] = await Promise.all([
      this.bookingQb(profileId)
        .andWhere('b.status = :confirmed', {
          confirmed: BookingStatus.CONFIRMED,
        })
        .andWhere(
          "(b.scheduled_date + COALESCE(b.end_time, time '23:59:59')) > CAST(:nowLocal AS timestamp)",
          { nowLocal },
        )
        .orderBy('b.scheduled_date', 'ASC')
        .addOrderBy('b.start_time', 'ASC', 'NULLS LAST')
        .addOrderBy('b.id', 'ASC')
        .limit(1)
        .getRawOne<BookingRow>(),
      this.bookingQb(profileId)
        .andWhere('b.status = :confirmed', {
          confirmed: BookingStatus.CONFIRMED,
        })
        .andWhere('b.scheduled_date = :today', { today })
        .orderBy('b.start_time', 'ASC', 'NULLS LAST')
        .addOrderBy('b.id', 'ASC')
        .limit(TODAY_BOOKINGS_LIMIT)
        .getRawMany<BookingRow>(),
    ]);
    return {
      next: next ? mapOverviewBooking(next) : null,
      today: todays.map(mapOverviewBooking),
    };
  }

  async buildEarnings(profileId: number, now: Date): Promise<OverviewEarnings> {
    const [balances, payout] = await Promise.all([
      queryBalances(this.payments, profileId, now),
      this.profiles
        .createQueryBuilder('ap')
        .select('(ap.paystack_recipient_code IS NOT NULL)', 'has')
        .where('ap.id = :profileId', { profileId })
        .getRawOne<{ has: boolean | null }>(),
    ]);
    return {
      currency: ARTISAN_CURRENCY,
      ...balances,
      hasPayoutMethod: !!payout?.has,
    };
  }

  /**
   * Disputes on my bookings that someone else raised, still OPEN or
   * UNDER_REVIEW, with no response yet: the same rule as `canRespond`.
   */
  async countDisputesNeedingResponse(me: number): Promise<number> {
    return this.disputes
      .createQueryBuilder('d')
      .innerJoin('bookings', 'b', 'b.id = d.booking_id')
      .innerJoin('artisan_profiles', 'ap', 'ap.id = b.artisan_profile_id')
      .where('ap.user_id = :me', { me })
      .andWhere('d.raised_by_id <> :me')
      .andWhere('d.response IS NULL')
      .andWhere('d.status IN (:...active)', {
        active: ACTIVE_DISPUTE_STATUSES,
      })
      .getCount();
  }
}

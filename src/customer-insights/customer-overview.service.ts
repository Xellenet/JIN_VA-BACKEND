import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Job } from '@jobs/entities/job.entity';
import { JobApplication } from '@jobs/entities/job-application.entity';
import { Booking } from '../bookings/entities/booking.entity';
import { Conversation } from '@messages/entities/conversation.entity';
import { Payment } from '../payments/entities/payment.entity';
import {
  ApplicationStatus,
  BookingStatus,
  PaymentStatus,
  Status,
} from '@common/types/enums';
import { TtlCache } from './customer-cache';
import { isoMonth, startOfMonth } from './customer-range';
import { CUSTOMER_CURRENCY, centsToMoney, SpendService } from './spend.util';

export interface ActionItem {
  count: number;
  jobId: number | null;
  jobTitle: string | null;
}

export interface OverviewActionItems {
  completionsToConfirm: ActionItem;
  paymentsDue: ActionItem;
  applicationsToReview: ActionItem;
  unreadMessages: number;
}

export interface OverviewNextBooking {
  id: number;
  scheduledDate: string;
  startTime: string | null;
  endTime: string | null;
  status: 'PENDING' | 'CONFIRMED';
  service: { id: number; name: string } | null;
  artisan: { id: number | null; displayName: string; avatar: string | null };
}

export interface OverviewSpend {
  currency: string;
  hasPaymentsEver: boolean;
  thisMonth: string;
  lastMonth: string;
  held: string;
  last6Months: Array<{ month: string; netSpent: string }>;
}

export type OverviewSection = 'actionItems' | 'nextBooking' | 'spend';

export interface CustomerOverview {
  actionItems: OverviewActionItems | null;
  nextBooking: OverviewNextBooking | null;
  spend: OverviewSpend | null;
  failedSections: OverviewSection[];
}

/** Raw aggregate behind one action item. */
interface ActionRow {
  count: string | number | null;
  jobs: string | number | null;
  jobId: string | number | null;
  jobTitle: string | null;
}

/** Raw next-booking row. */
export interface NextBookingRow {
  id: number | string;
  scheduledDate: string | Date;
  startTime: string | null;
  endTime: string | null;
  status: 'PENDING' | 'CONFIRMED';
  serviceId: number | string | null;
  serviceName: string | null;
  artisanProfileId: number | string | null;
  businessName: string | null;
  firstname: string | null;
  lastname: string | null;
  avatar: string | null;
  artisanGone: boolean | null;
}

export const FORMER_ARTISAN = 'Former artisan';

/** `HH:mm:ss` (Postgres `time`) → `HH:mm`; null stays null. */
export function hhmm(value: string | null | undefined): string | null {
  if (!value) return null;
  return String(value).slice(0, 5);
}

/** A Postgres `date` (string or Date) → `YYYY-MM-DD`. */
export function calendarDate(value: string | Date): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

/** The other party, never more than `{id, displayName, avatar}` (SEC-7). */
export function artisanRef(row: {
  artisanProfileId: number | string | null;
  businessName: string | null;
  firstname: string | null;
  lastname: string | null;
  avatar: string | null;
  artisanGone: boolean | null;
}): { id: number | null; displayName: string; avatar: string | null } {
  if (row.artisanGone || row.artisanProfileId === null) {
    return { id: null, displayName: FORMER_ARTISAN, avatar: null };
  }
  const name =
    row.businessName?.trim() ||
    `${row.firstname ?? ''} ${row.lastname ?? ''}`.trim() ||
    'Artisan';
  return {
    id: Number(row.artisanProfileId),
    displayName: name,
    avatar: row.avatar ?? null,
  };
}

function toActionItem(row: ActionRow | undefined): ActionItem {
  const count = Number(row?.count ?? 0);
  const single = count > 0 && Number(row?.jobs ?? 0) === 1;
  return {
    count,
    jobId: single && row?.jobId != null ? Number(row.jobId) : null,
    jobTitle: single ? (row?.jobTitle ?? null) : null,
  };
}

/**
 * Customer experience v2 (B6): the Overview rail. Three independent sections,
 * each built in its own try/catch so one failing query costs only that card
 * (`failedSections`), never the whole response (BU-2.9).
 *
 * Every query is scoped to the caller with a bound `:me`; the spend figures
 * come from `SpendService`, the same helper the Spending report uses.
 */
@Injectable()
export class CustomerOverviewService {
  private readonly logger = new Logger(CustomerOverviewService.name);
  private readonly cache = new TtlCache<CustomerOverview>(30_000);

  constructor(
    @InjectRepository(Job) private readonly jobs: Repository<Job>,
    @InjectRepository(JobApplication)
    private readonly applications: Repository<JobApplication>,
    @InjectRepository(Payment) private readonly payments: Repository<Payment>,
    @InjectRepository(Booking) private readonly bookings: Repository<Booking>,
    @InjectRepository(Conversation)
    private readonly conversations: Repository<Conversation>,
    private readonly spend: SpendService,
  ) {}

  async getOverview(
    me: number,
    now: Date = new Date(),
  ): Promise<CustomerOverview> {
    const key = `customer-overview:${me}`;
    const cached = this.cache.get(key);
    if (cached) return cached;

    const failedSections: OverviewSection[] = [];
    const guard = async <T>(
      section: OverviewSection,
      build: () => Promise<T>,
    ): Promise<T | null> => {
      try {
        return await build();
      } catch (err) {
        failedSections.push(section);
        // No user id, email or SQL parameters in the log line (BU-2.9).
        this.logger.error(
          `Overview section "${section}" failed: ${(err as Error)?.name ?? 'Error'}`,
        );
        return null;
      }
    };

    const [actionItems, nextBooking, spend] = await Promise.all([
      guard('actionItems', () => this.buildActionItems(me)),
      guard('nextBooking', () => this.buildNextBooking(me, now)),
      guard('spend', () => this.buildSpend(me, now)),
    ]);

    const order: OverviewSection[] = ['actionItems', 'nextBooking', 'spend'];
    const result: CustomerOverview = {
      actionItems,
      nextBooking,
      spend,
      failedSections: order.filter((s) => failedSections.includes(s)),
    };
    // A partial answer is never cached, so "Try again" really retries.
    if (result.failedSections.length === 0) this.cache.set(key, result);
    return result;
  }

  async buildActionItems(me: number): Promise<OverviewActionItems> {
    const [completions, paymentsDue, applications, unreadMessages] =
      await Promise.all([
        this.completionsToConfirm(me),
        this.paymentsDue(me),
        this.applicationsToReview(me),
        this.unreadConversations(me),
      ]);
    return {
      completionsToConfirm: toActionItem(completions),
      paymentsDue: toActionItem(paymentsDue),
      applicationsToReview: toActionItem(applications),
      unreadMessages,
    };
  }

  /** IN_PROGRESS jobs whose artisan asked the customer to confirm. */
  private completionsToConfirm(me: number): Promise<ActionRow | undefined> {
    return this.jobs
      .createQueryBuilder('j')
      .select('COUNT(*)', 'count')
      .addSelect('COUNT(DISTINCT j.id)', 'jobs')
      .addSelect('MIN(j.id)', 'jobId')
      .addSelect('MIN(j.title)', 'jobTitle')
      .where('j.customer_id = :me', { me })
      .andWhere('j.status = :inProgress', { inProgress: Status.IN_PROGRESS })
      .andWhere('j.completion_requested_at IS NOT NULL')
      .andWhere('j.deleted_at IS NULL')
      .getRawOne<ActionRow>();
  }

  /** PENDING payments on jobs that are under way (PENDING or IN_PROGRESS). */
  private paymentsDue(me: number): Promise<ActionRow | undefined> {
    return this.payments
      .createQueryBuilder('p')
      .innerJoin(Job, 'j', 'j.id = p.job_id')
      .select('COUNT(*)', 'count')
      .addSelect('COUNT(DISTINCT j.id)', 'jobs')
      .addSelect('MIN(j.id)', 'jobId')
      .addSelect('MIN(j.title)', 'jobTitle')
      .where('p.customer_id = :me', { me })
      .andWhere('j.customer_id = :me')
      .andWhere('p.status = :pendingPayment', {
        pendingPayment: PaymentStatus.PENDING,
      })
      .andWhere('j.status IN (:...activeJobStatuses)', {
        activeJobStatuses: [Status.PENDING, Status.IN_PROGRESS],
      })
      .andWhere('j.deleted_at IS NULL')
      .getRawOne<ActionRow>();
  }

  /** PENDING applications on the caller's OPEN jobs. */
  private applicationsToReview(me: number): Promise<ActionRow | undefined> {
    return this.applications
      .createQueryBuilder('a')
      .innerJoin(Job, 'j', 'j.id = a.job_id')
      .select('COUNT(*)', 'count')
      .addSelect('COUNT(DISTINCT j.id)', 'jobs')
      .addSelect('MIN(j.id)', 'jobId')
      .addSelect('MIN(j.title)', 'jobTitle')
      .where('j.customer_id = :me', { me })
      .andWhere('j.status = :open', { open: Status.OPEN })
      .andWhere('j.deleted_at IS NULL')
      .andWhere('a.status = :pendingApp', {
        pendingApp: ApplicationStatus.PENDING,
      })
      .getRawOne<ActionRow>();
  }

  /**
   * Conversations with at least one message from the other participant not
   * yet read: the same rule as `MessagesService` and the header envelope.
   */
  private async unreadConversations(me: number): Promise<number> {
    const row = await this.conversations
      .createQueryBuilder('c')
      .select('COUNT(*)', 'count')
      .where('(c.participant_a_id = :me OR c.participant_b_id = :me)', { me })
      .andWhere(
        'EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.sender_id <> :me AND m.is_read = false)',
      )
      .getRawOne<{ count: string }>();
    return Number(row?.count ?? 0);
  }

  /**
   * The earliest PENDING or CONFIRMED booking whose end is still ahead
   * (Accra wall clock). A booking with no end time counts until the end of
   * its day.
   */
  async buildNextBooking(
    me: number,
    now: Date,
  ): Promise<OverviewNextBooking | null> {
    const nowLocal = now.toISOString().slice(0, 19).replace('T', ' ');
    const row = await this.bookings
      .createQueryBuilder('b')
      .leftJoin('services', 's', 's.id = b.service_id')
      .leftJoin('artisan_profiles', 'ap', 'ap.id = b.artisan_profile_id')
      .leftJoin('users', 'u', 'u.id = ap.user_id')
      .select('b.id', 'id')
      .addSelect('b.scheduled_date', 'scheduledDate')
      .addSelect('b.start_time', 'startTime')
      .addSelect('b.end_time', 'endTime')
      .addSelect('b.status', 'status')
      .addSelect('s.id', 'serviceId')
      .addSelect('s.name', 'serviceName')
      .addSelect('ap.id', 'artisanProfileId')
      .addSelect('ap.business_name', 'businessName')
      .addSelect('u.firstname', 'firstname')
      .addSelect('u.lastname', 'lastname')
      .addSelect('u.profile_picture', 'avatar')
      .addSelect(
        '(u.id IS NULL OR u.deleted_at IS NOT NULL OR u.purged_at IS NOT NULL)',
        'artisanGone',
      )
      .where('b.customer_id = :me', { me })
      .andWhere('b.status IN (:...upcoming)', {
        upcoming: [BookingStatus.PENDING, BookingStatus.CONFIRMED],
      })
      .andWhere(
        "(b.scheduled_date + COALESCE(b.end_time, time '23:59:59')) > CAST(:nowLocal AS timestamp)",
        { nowLocal },
      )
      .orderBy('b.scheduled_date', 'ASC')
      .addOrderBy('b.start_time', 'ASC', 'NULLS LAST')
      .addOrderBy('b.id', 'ASC')
      .limit(1)
      .getRawOne<NextBookingRow>();
    return row ? CustomerOverviewService.mapNextBooking(row) : null;
  }

  static mapNextBooking(row: NextBookingRow): OverviewNextBooking {
    return {
      id: Number(row.id),
      scheduledDate: calendarDate(row.scheduledDate),
      startTime: hhmm(row.startTime),
      endTime: hhmm(row.endTime),
      status: row.status,
      service:
        row.serviceId != null
          ? { id: Number(row.serviceId), name: row.serviceName ?? 'Other' }
          : null,
      artisan: artisanRef(row),
    };
  }

  async buildSpend(me: number, now: Date): Promise<OverviewSpend> {
    const from = startOfMonth(now, 5);
    const [byMonth, heldCents, hasPaymentsEver] = await Promise.all([
      this.spend.netByBucket(me, 'month', from, now),
      this.spend.heldCents(me),
      this.spend.hasPaymentsEver(me),
    ]);
    const last6Months = Array.from({ length: 6 }, (_, i) => {
      const monthStart = startOfMonth(now, 5 - i);
      const key = `${isoMonth(monthStart)}-01`;
      return {
        month: isoMonth(monthStart),
        netSpent: centsToMoney(byMonth.get(key)?.cents ?? 0),
      };
    });
    return {
      currency: CUSTOMER_CURRENCY,
      hasPaymentsEver,
      thisMonth: last6Months[5].netSpent,
      lastMonth: last6Months[4].netSpent,
      held: centsToMoney(heldCents),
      last6Months,
    };
  }
}

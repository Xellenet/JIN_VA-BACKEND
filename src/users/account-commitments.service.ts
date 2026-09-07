import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, Repository } from 'typeorm';
import { Booking } from '../bookings/entities/booking.entity';
import { Job } from '@jobs/entities/job.entity';
import { Payment } from '../payments/entities/payment.entity';
import { Dispute } from '../disputes/entities/dispute.entity';
import {
  BookingStatus,
  DisputeStatus,
  PaymentStatus,
  Status,
} from '@common/types/enums';
import { ERROR_MESSAGES } from '@common/constants/error-messages.constants';

/**
 * C1.1: booking states that still bind both parties to each other. Everything
 * else (`COMPLETED`, `CANCELLED`, `DECLINED`, `EXPIRED`, `NO_SHOW`) is
 * terminal and never blocks deletion.
 */
const LIVE_BOOKING_STATUSES = [
  BookingStatus.PENDING,
  BookingStatus.CONFIRMED,
] as const;

/**
 * C1.1: job states that still represent work owed. `OPEN` only ever applies to
 * the customer who posted it (an open job has no accepted artisan yet), so one
 * query over "customer or accepted artisan" covers both roles exactly.
 */
const LIVE_JOB_STATUSES = [
  Status.OPEN,
  Status.PENDING,
  Status.IN_PROGRESS,
] as const;

/**
 * C1.1: money in flight. `TRANSFER_FAILED` is included deliberately — it is
 * retryable, which makes it live, not finished. Terminal states (`RELEASED`,
 * `REFUNDED`, `CANCELLED`, `FAILED`) never block.
 */
const IN_FLIGHT_PAYMENT_STATUSES = [
  PaymentStatus.PENDING,
  PaymentStatus.HELD,
  PaymentStatus.PENDING_TRANSFER,
  PaymentStatus.TRANSFER_FAILED,
] as const;

/**
 * C1.1: a dispute still awaiting an outcome. `RESOLVED` and `CLOSED` are both
 * terminal admin verdicts (see `DisputeStatus`), so neither blocks.
 */
const OPEN_DISPUTE_STATUSES = [
  DisputeStatus.OPEN,
  DisputeStatus.UNDER_REVIEW,
] as const;

/** One reason deletion is being refused, with the count behind it. */
export interface DeletionBlocker {
  /** Stable machine-readable kind, for logs and tests. */
  kind: 'bookings' | 'jobs' | 'payments' | 'disputes';
  count: number;
  /** Already-phrased clause, joined into the 409 message. */
  clause: string;
}

/**
 * C1.1: answers one question — "does this account still owe anybody
 * anything?" — for `UsersService.deleteMe()`.
 *
 * It exists as its own provider rather than as more methods on `UsersService`
 * because the answer spans four other modules' tables (bookings, jobs,
 * payments, disputes) and `UsersService` should not grow four unrelated
 * repositories to ask it. Only the entities are pulled in, never the owning
 * modules, so this adds no module-level coupling.
 *
 * Every check counts rather than fetches: the refusal message names *what* is
 * outstanding and how many, never an amount (C1.1's money-adjacency note), so
 * no row bodies are needed and no currency ever has to be formatted here.
 */
@Injectable()
export class AccountCommitmentsService {
  private readonly logger = new Logger(AccountCommitmentsService.name);

  constructor(
    @InjectRepository(Booking)
    private readonly bookingsRepository: Repository<Booking>,
    @InjectRepository(Job)
    private readonly jobsRepository: Repository<Job>,
    @InjectRepository(Payment)
    private readonly paymentsRepository: Repository<Payment>,
    @InjectRepository(Dispute)
    private readonly disputesRepository: Repository<Dispute>,
  ) {}

  /**
   * Refuses account deletion with a 409 naming everything outstanding, or
   * returns quietly when nothing is.
   *
   * @param userId - The account being deleted.
   * @throws {ConflictException} When any live commitment exists.
   */
  async assertDeletable(userId: number): Promise<void> {
    const blockers = await this.findDeletionBlockers(userId);
    if (blockers.length === 0) return;

    this.logger.warn(
      `Refused account deletion for user ${userId}: ` +
        blockers.map((b) => `${b.kind}=${b.count}`).join(' '),
    );

    throw new ConflictException({
      message: ERROR_MESSAGES.USER.DELETION_BLOCKED(
        blockers.map((b) => b.clause),
      ),
      errorCode: 'ACCOUNT_HAS_LIVE_COMMITMENTS',
    });
  }

  /**
   * Every live commitment on the account, in a fixed order so the refusal
   * message reads the same way every time. All four counts are gathered
   * together rather than short-circuiting on the first hit — a user resolving
   * their obligations should see the whole list once, not discover the next
   * blocker on each retry.
   */
  async findDeletionBlockers(userId: number): Promise<DeletionBlocker[]> {
    const [bookings, jobs, payments, disputes] = await Promise.all([
      this.countLiveBookings(userId),
      this.countLiveJobs(userId),
      this.countInFlightPayments(userId),
      this.countOpenDisputes(userId),
    ]);

    const blockers: DeletionBlocker[] = [];

    if (bookings > 0) {
      blockers.push({
        kind: 'bookings',
        count: bookings,
        clause: `you have ${plural(bookings, 'booking')} that ${isAre(bookings)} still pending or confirmed`,
      });
    }
    if (jobs > 0) {
      blockers.push({
        kind: 'jobs',
        count: jobs,
        clause: `you have ${plural(jobs, 'job')} that ${isAre(jobs)} still open or in progress`,
      });
    }
    if (payments > 0) {
      blockers.push({
        kind: 'payments',
        count: payments,
        clause:
          `you have ${plural(payments, 'payment')} still being processed ` +
          `(open Earnings to see and resolve ${payments === 1 ? 'it' : 'them'})`,
      });
    }
    if (disputes > 0) {
      blockers.push({
        kind: 'disputes',
        count: disputes,
        clause: `you have ${plural(disputes, 'dispute')} awaiting resolution`,
      });
    }

    return blockers;
  }

  /**
   * Bookings where the user is either the customer or the booked artisan.
   *
   * `Booking.customerId` / `artisanProfileId` are `@RelationId` projections
   * rather than real columns, so the raw snake_case column names are used here
   * — the same approach `DisputesService.participantQb` documents.
   */
  private countLiveBookings(userId: number): Promise<number> {
    return this.bookingsRepository
      .createQueryBuilder('b')
      .leftJoin('b.artisanProfile', 'artisanProfile')
      .where('b.status IN (:...statuses)', {
        statuses: [...LIVE_BOOKING_STATUSES],
      })
      .andWhere(
        new Brackets((qb) =>
          qb
            .where('b.customer_id = :userId', { userId })
            .orWhere('artisanProfile.user_id = :userId', { userId }),
        ),
      )
      .getCount();
  }

  /** Jobs the user posted, or was accepted onto as the artisan. */
  private countLiveJobs(userId: number): Promise<number> {
    return this.jobsRepository
      .createQueryBuilder('j')
      .where('j.status IN (:...statuses)', {
        statuses: [...LIVE_JOB_STATUSES],
      })
      .andWhere(
        new Brackets((qb) =>
          qb
            .where('j.customer_id = :userId', { userId })
            .orWhere('j.accepted_artisan_id = :userId', { userId }),
        ),
      )
      .getCount();
  }

  /** Payments the user is either paying or being paid. */
  private countInFlightPayments(userId: number): Promise<number> {
    return this.paymentsRepository
      .createQueryBuilder('p')
      .leftJoin('p.artisanProfile', 'artisanProfile')
      .where('p.status IN (:...statuses)', {
        statuses: [...IN_FLIGHT_PAYMENT_STATUSES],
      })
      .andWhere(
        new Brackets((qb) =>
          qb
            .where('p.customer_id = :userId', { userId })
            .orWhere('artisanProfile.user_id = :userId', { userId }),
        ),
      )
      .getCount();
  }

  /**
   * Disputes the user is a party to — as the raiser, the booking's customer,
   * or the booking's artisan. Mirrors `DisputesService.participantQb`'s
   * definition of "participant" exactly, so a dispute that blocks deletion is
   * always one the user can actually see and act on.
   */
  private countOpenDisputes(userId: number): Promise<number> {
    return this.disputesRepository
      .createQueryBuilder('d')
      .leftJoin('d.booking', 'booking')
      .leftJoin('booking.artisanProfile', 'artisanProfile')
      .where('d.status IN (:...statuses)', {
        statuses: [...OPEN_DISPUTE_STATUSES],
      })
      .andWhere(
        new Brackets((qb) =>
          qb
            .where('d.raised_by_id = :userId', { userId })
            .orWhere('booking.customer_id = :userId', { userId })
            .orWhere('artisanProfile.user_id = :userId', { userId }),
        ),
      )
      .getCount();
  }
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function isAre(count: number): string {
  return count === 1 ? 'is' : 'are';
}

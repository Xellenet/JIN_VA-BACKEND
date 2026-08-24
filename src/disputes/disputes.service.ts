import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { plainToInstance } from 'class-transformer';
import { Repository } from 'typeorm';
import { Dispute } from './entities/dispute.entity';
import { Booking } from '../bookings/entities/booking.entity';
import { Job } from '@jobs/entities/job.entity';
import { Payment } from '../payments/entities/payment.entity';
import { User } from '@users/entities/user.entity';
import { CreateDisputeDto } from './dto/create-dispute.dto';
import { GetDisputesQueryDto } from './dto/get-disputes-query.dto';
import { ResolveDisputeDto, CloseDisputeDto } from './dto/resolve-dispute.dto';
import { DisputeResponseDto } from './dto/dispute-response.dto';
import { BookingStatus, DisputeStatus, Role } from '@common/types/enums';
import { APP_EVENTS } from '@common/events/app.events';
import type {
  DisputeFiledPayload,
  DisputeOutcomePayload,
} from '@common/events/app.events';
import { MessagesService } from '@messages/messages.service';

/** Relations needed to resolve both parties of a dispute's underlying booking. */
const PARTICIPANT_RELATIONS = [
  'booking',
  'booking.customer',
  'booking.artisanProfile',
  'booking.artisanProfile.user',
  'raisedBy',
];

@Injectable()
export class DisputesService {
  private readonly logger = new Logger(DisputesService.name);

  constructor(
    @InjectRepository(Dispute)
    private readonly repo: Repository<Dispute>,
    @InjectRepository(Booking)
    private readonly bookingRepo: Repository<Booking>,
    @InjectRepository(Job)
    private readonly jobRepo: Repository<Job>,
    @InjectRepository(Payment)
    private readonly paymentRepo: Repository<Payment>,
    /**
     * PD4: this module emitted nothing before this round, so PRD §5.13's
     * "both parties notified automatically" was simply not happening.
     */
    private readonly eventEmitter: EventEmitter2,
    /**
     * AD1: resolves the dispute's two parties to their message thread. Owned
     * by MessagesService because it is message-thread logic; this service only
     * supplies the dispute → booking → participants resolution and the AD2
     * authorization gate.
     */
    private readonly messagesService: MessagesService,
  ) {}

  // ─── User-facing ────────────────────────────────────────────────────────────

  async raise(userId: number, dto: CreateDisputeDto) {
    const booking = await this.bookingRepo.findOne({
      where: { id: dto.bookingId },
      relations: ['customer', 'artisanProfile', 'artisanProfile.user'],
    });
    if (!booking) throw new NotFoundException('Booking not found.');

    const isCustomer = booking.customer.id === userId;
    const isArtisan = booking.artisanProfile.user.id === userId;

    if (!isCustomer && !isArtisan) {
      throw new ForbiddenException(
        'You are not a participant of this booking.',
      );
    }

    const disputeableStatuses: BookingStatus[] = [
      BookingStatus.COMPLETED,
      BookingStatus.CANCELLED,
    ];
    if (!disputeableStatuses.includes(booking.status)) {
      throw new BadRequestException(
        `Disputes can only be raised on COMPLETED or CANCELLED bookings (current: ${booking.status}).`,
      );
    }

    const existing = await this.repo.findOne({
      where: { bookingId: dto.bookingId, raisedById: userId },
    });
    if (existing) {
      throw new BadRequestException(
        'You have already raised a dispute for this booking.',
      );
    }

    const dispute = await this.repo.save(
      this.repo.create({
        booking,
        bookingId: dto.bookingId,
        raisedBy: { id: userId } as User,
        raisedById: userId,
        reason: dto.reason,
        status: DisputeStatus.OPEN,
      }),
    );

    // PR3: puts a real trigger behind the admin "Dispute Filed" toggle.
    const raiser = isCustomer ? booking.customer : booking.artisanProfile.user;
    this.eventEmitter.emit(APP_EVENTS.DISPUTE_FILED, {
      disputeId: dispute.id,
      bookingId: dispute.bookingId,
      raisedByName: `${raiser.firstname} ${raiser.lastname}`,
      raisedByRole: isCustomer ? Role.CUSTOMER : Role.ARTISAN,
    } as DisputeFiledPayload);

    return {
      message:
        'Dispute raised. Our team will review and respond within 48 hours.',
      data: this.toDto(dispute),
    };
  }

  async getMyDisputes(userId: number) {
    const disputes = await this.repo.find({
      where: { raisedById: userId },
      relations: ['booking', 'raisedBy', 'resolvedBy'],
      order: { createdAt: 'DESC' },
    });

    return {
      message: 'Your disputes retrieved.',
      data: disputes.map((d) => this.toDto(d)),
    };
  }

  async getMyDispute(userId: number, disputeId: number) {
    const dispute = await this.repo.findOne({
      where: { id: disputeId, raisedById: userId },
      relations: ['booking', 'raisedBy', 'resolvedBy'],
    });
    if (!dispute) throw new NotFoundException('Dispute not found.');

    return { message: 'Dispute retrieved.', data: this.toDto(dispute) };
  }

  // ─── Admin-facing ────────────────────────────────────────────────────────────

  async findAll(query: GetDisputesQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const qb = this.repo
      .createQueryBuilder('d')
      .leftJoinAndSelect('d.booking', 'booking')
      .leftJoinAndSelect('d.raisedBy', 'raisedBy')
      .leftJoinAndSelect('d.resolvedBy', 'resolvedBy')
      .orderBy('d.createdAt', 'DESC');

    if (query.status)
      qb.andWhere('d.status = :status', { status: query.status });

    const [disputes, total] = await qb
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();

    return {
      message: 'Disputes retrieved.',
      data: disputes.map((d) => this.toDto(d)),
      pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  /**
   * Ad3: `Dispute.bookingId` and `Payment.jobId` are never joined anywhere
   * else in the codebase — a booking-derived `Job` (`Job.bookingId`) is the
   * only link between the two. Look one up here so the admin dispute screen
   * can show the associated payment (if any) without a separate manual
   * lookup in the transactions list.
   *
   * A dispute's booking legitimately may have no associated payment at all:
   * booking-derived jobs don't currently call `holdPayment` (see the
   * payments-integration requirements doc), so `jobId`/`payment` being
   * `null` here is an expected, common case, not an error.
   */
  private async findLinkedPayment(
    bookingId: number,
  ): Promise<{ jobId: number | null; payment: Payment | null }> {
    // `Job.bookingId` is a `@RelationId` projection, not a real column —
    // TypeORM's find options can't filter on it directly (it throws
    // EntityPropertyNotFoundError at runtime despite compiling fine, since
    // RelationId fields are populated from a loaded relation, not queryable
    // on their own). Filter on the relation itself instead, which TypeORM
    // correctly translates into a `booking_id = :id` condition.
    const job = await this.jobRepo.findOne({
      where: { booking: { id: bookingId } },
    });
    if (!job) return { jobId: null, payment: null };

    const payment = await this.paymentRepo.findOne({
      where: { jobId: job.id },
    });
    return { jobId: job.id, payment: payment ?? null };
  }

  async findOne(id: number) {
    const dispute = await this.repo.findOne({
      where: { id },
      relations: [
        'booking',
        'booking.customer',
        'booking.artisanProfile',
        'raisedBy',
        'resolvedBy',
      ],
    });
    if (!dispute) throw new NotFoundException('Dispute not found.');

    const { jobId, payment } = await this.findLinkedPayment(dispute.bookingId);

    return {
      message: 'Dispute retrieved.',
      data: { ...this.toDto(dispute), jobId, payment },
    };
  }

  async startReview(adminId: number, id: number) {
    const dispute = await this.loadOrFail(id);
    if (dispute.status !== DisputeStatus.OPEN) {
      throw new BadRequestException(
        `Cannot start review — current status is ${dispute.status}.`,
      );
    }
    dispute.status = DisputeStatus.UNDER_REVIEW;
    await this.repo.save(dispute);
    return { message: 'Dispute is now UNDER_REVIEW.' };
  }

  async resolve(adminId: number, id: number, dto: ResolveDisputeDto) {
    const dispute = await this.loadOrFail(id, PARTICIPANT_RELATIONS);
    if (
      dispute.status === DisputeStatus.RESOLVED ||
      dispute.status === DisputeStatus.CLOSED
    ) {
      throw new BadRequestException(`Dispute is already ${dispute.status}.`);
    }

    dispute.status = DisputeStatus.RESOLVED;
    dispute.resolution = dto.resolution;
    dispute.resolvedById = adminId;
    dispute.resolvedBy = { id: adminId } as User;
    dispute.resolvedAt = new Date();
    if (dto.adminNotes) dispute.adminNotes = dto.adminNotes;

    await this.repo.save(dispute);
    this.emitOutcome(dispute, 'RESOLVED', dto.resolution);
    return { message: 'Dispute resolved.' };
  }

  async close(adminId: number, id: number, dto: CloseDisputeDto) {
    const dispute = await this.loadOrFail(id, PARTICIPANT_RELATIONS);
    if (dispute.status === DisputeStatus.CLOSED) {
      throw new BadRequestException('Dispute is already closed.');
    }

    dispute.status = DisputeStatus.CLOSED;
    dispute.resolvedById = adminId;
    dispute.resolvedBy = { id: adminId } as User;
    dispute.resolvedAt = new Date();
    if (dto.adminNotes) dispute.adminNotes = dto.adminNotes;

    await this.repo.save(dispute);
    this.emitOutcome(dispute, 'CLOSED');
    return { message: 'Dispute closed.' };
  }

  // ─── AD1/AD2: dispute-scoped conversation lookup ─────────────────────────────

  /**
   * AD1: returns the message thread between the two parties of a dispute's
   * underlying booking, read-only, for an admin who is working that dispute.
   *
   * AD2 — this is the *only* way an admin can read someone else's
   * conversation, and the boundary is enforced here, server-side, not by the
   * frontend simply not offering a general browser:
   *
   *  1. The route is admin-only (`@Roles(Role.ADMIN)` on `AdminController`).
   *  2. The participants are *derived* from the dispute's booking — an admin
   *     cannot name the two users they want to read. There is no parameter
   *     that accepts a user id or a conversation id, so there is nothing to
   *     tamper with.
   *  3. The dispute must still be open work (`OPEN` or `UNDER_REVIEW`). Once
   *     it reaches `RESOLVED`/`CLOSED` the evidentiary need is over and access
   *     is refused, so a stale dispute cannot become a permanent read tap on
   *     two users' private thread.
   *
   * "No conversation between these two users" is an expected, common outcome
   * (a dispute can be raised by people who never messaged), so it returns
   * `data: null` with an explanatory message rather than a 404.
   */
  async getConversationForDispute(disputeId: number) {
    const dispute = await this.loadOrFail(disputeId, PARTICIPANT_RELATIONS);

    const activeStatuses: DisputeStatus[] = [
      DisputeStatus.OPEN,
      DisputeStatus.UNDER_REVIEW,
    ];
    if (!activeStatuses.includes(dispute.status)) {
      throw new ForbiddenException(
        `Conversation access is scoped to disputes that are still open (OPEN or UNDER_REVIEW). ` +
          `This dispute is ${dispute.status}.`,
      );
    }

    const customer = dispute.booking?.customer;
    const artisanUser = dispute.booking?.artisanProfile?.user;
    if (!customer || !artisanUser) {
      throw new NotFoundException(
        "Could not resolve this dispute's booking participants.",
      );
    }

    return this.messagesService.getConversationBetween(
      customer.id,
      artisanUser.id,
      { disputeId: dispute.id, bookingId: dispute.bookingId },
    );
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  private async loadOrFail(id: number, relations?: string[]): Promise<Dispute> {
    const dispute = await this.repo.findOne({ where: { id }, relations });
    if (!dispute) throw new NotFoundException('Dispute not found.');
    return dispute;
  }

  /**
   * PD4: notifies both the party who raised the dispute and the counterparty
   * of the final outcome — PRD §5.13's "both parties notified automatically".
   *
   * Only final outcomes emit. A dispute moving to `UNDER_REVIEW` deliberately
   * does not, per the approved requirements ("PRD's language anchors on
   * 'outcome'"), so the parties aren't pinged for an internal admin step.
   *
   * Best-effort: a notification failure must never fail the admin's resolve or
   * close action, which has already committed by the time this runs.
   */
  private emitOutcome(
    dispute: Dispute,
    outcome: 'RESOLVED' | 'CLOSED',
    resolution?: string,
  ): void {
    try {
      const customerId = dispute.booking?.customer?.id;
      const artisanUserId = dispute.booking?.artisanProfile?.user?.id;

      if (!customerId || !artisanUserId) {
        this.logger.warn(
          `Dispute ${dispute.id} ${outcome} but participants could not be resolved — no outcome notification sent.`,
        );
        return;
      }

      // The raiser is whichever of the two the dispute is attributed to; the
      // counterparty is the other one. Derived rather than assumed, since
      // either party can raise a dispute.
      const raisedByUserId = dispute.raisedById;
      const counterpartyUserId =
        raisedByUserId === customerId ? artisanUserId : customerId;

      this.eventEmitter.emit(
        outcome === 'RESOLVED'
          ? APP_EVENTS.DISPUTE_RESOLVED
          : APP_EVENTS.DISPUTE_CLOSED,
        {
          disputeId: dispute.id,
          bookingId: dispute.bookingId,
          raisedByUserId,
          counterpartyUserId,
          outcome,
          resolution,
        } as DisputeOutcomePayload,
      );
    } catch (err) {
      this.logger.error(
        `Failed to emit dispute ${outcome} notification for dispute ${dispute.id}: ${(err as Error).message}`,
      );
    }
  }

  private toDto(dispute: Dispute): DisputeResponseDto {
    return plainToInstance(DisputeResponseDto, dispute, {
      excludeExtraneousValues: true,
    });
  }
}

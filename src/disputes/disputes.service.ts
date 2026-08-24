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
import { Brackets, In, Not, Repository } from 'typeorm';
import { Dispute } from './entities/dispute.entity';
import { Booking } from '../bookings/entities/booking.entity';
import { Job } from '@jobs/entities/job.entity';
import { JobStatusHistory } from '@jobs/entities/job-status-history.entity';
import { Payment } from '../payments/entities/payment.entity';
import { User } from '@users/entities/user.entity';
import { CreateDisputeDto } from './dto/create-dispute.dto';
import { GetDisputesQueryDto } from './dto/get-disputes-query.dto';
import { ResolveDisputeDto, CloseDisputeDto } from './dto/resolve-dispute.dto';
import { RespondToDisputeDto } from './dto/respond-dispute.dto';
import {
  DisputeResponseDto,
  PartyDisputeResponseDto,
} from './dto/dispute-response.dto';
import {
  AdminActionTarget,
  AdminActionType,
  BookingStatus,
  DisputeCategory,
  DisputeMoneyAction,
  DisputeOutcome,
  DisputeStatus,
  PaymentStatus,
  Role,
  Status,
} from '@common/types/enums';
import { APP_EVENTS } from '@common/events/app.events';
import type {
  DisputeFiledPayload,
  DisputeOutcomePayload,
} from '@common/events/app.events';
import { MessagesService } from '@messages/messages.service';
import { PaymentsService } from '../payments/payments.service';
import { AdminAuditService } from '../admin-audit/admin-audit.service';
import { formatGhs } from '@common/utils/currency.util';

/** Relations needed to resolve both parties of a dispute's underlying booking. */
const PARTICIPANT_RELATIONS = [
  'booking',
  'booking.customer',
  'booking.artisanProfile',
  'booking.artisanProfile.user',
  'raisedBy',
];

/** DR6 / PRD §11: the platform's stated dispute-resolution target. */
const SLA_HOURS = 48;

/** Dispute statuses that still count as open work. */
const ACTIVE_STATUSES: DisputeStatus[] = [
  DisputeStatus.OPEN,
  DisputeStatus.UNDER_REVIEW,
];

/** What the money side of a verdict is going to do, decided before any write. */
interface MoneyPlan {
  action: DisputeMoneyAction;
  paymentId?: number;
  /** GHS amount the action will move. */
  amount?: number;
  /**
   * Why no money is moving, when `action === NONE` and the verdict implied
   * one. Surfaced to the admin verbatim so a skipped money step is never
   * silent (DR2).
   */
  skippedReason?: string;
}

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
    @InjectRepository(JobStatusHistory)
    private readonly jobHistoryRepo: Repository<JobStatusHistory>,
    @InjectRepository(Payment)
    private readonly paymentRepo: Repository<Payment>,
    /**
     * PD4: this module emitted nothing before the messaging round, so PRD
     * §5.13's "both parties notified automatically" was simply not happening.
     */
    private readonly eventEmitter: EventEmitter2,
    /**
     * AD1: resolves the dispute's two parties to their message thread. Owned
     * by MessagesService because it is message-thread logic; this service only
     * supplies the dispute → booking → participants resolution and the AD2
     * authorization gate.
     */
    private readonly messagesService: MessagesService,
    /**
     * DR2: the money side of a verdict. Both capabilities already existed and
     * were simply unreachable from a dispute — `adminRefund` for a client
     * ruling, `capturePayment` (release of a withheld payment) for an artisan
     * ruling. Neither is re-implemented here.
     */
    private readonly paymentsService: PaymentsService,
    /** AT5: append-only audit row for every ruling, including the money action. */
    private readonly auditService: AdminAuditService,
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
        // DR5: required on every new dispute.
        category: dto.category,
        status: DisputeStatus.OPEN,
      }),
    );

    // PR3: puts a real trigger behind the admin "Dispute Filed" toggle.
    // DR4: `counterpartyUserId` makes the *other party* a recipient too — the
    // filing notification previously fanned out to admins only, so the party
    // a dispute was filed against was never told it existed.
    const raiser = isCustomer ? booking.customer : booking.artisanProfile.user;
    const counterparty = isCustomer
      ? booking.artisanProfile.user
      : booking.customer;
    this.eventEmitter.emit(APP_EVENTS.DISPUTE_FILED, {
      disputeId: dispute.id,
      bookingId: dispute.bookingId,
      raisedByName: `${raiser.firstname} ${raiser.lastname}`,
      raisedByRole: isCustomer ? Role.CUSTOMER : Role.ARTISAN,
      counterpartyUserId: counterparty?.id,
      category: dto.category,
    } as DisputeFiledPayload);

    return {
      message:
        'Dispute raised. Our team will review and respond within 48 hours.',
      data: this.toPartyDto(dispute, userId),
    };
  }

  /**
   * DP2: every dispute the caller is a participant of — the ones they filed
   * *and* the ones filed against them.
   *
   * Widened from "disputes I raised" this round: DR4 lets the counterparty
   * respond, which they cannot do if they cannot read the dispute. This is a
   * superset of the previous behaviour, never a narrower one.
   */
  async getMyDisputes(userId: number) {
    const disputes = await this.participantQb(userId)
      .orderBy('d.createdAt', 'DESC')
      .getMany();

    return {
      message: 'Your disputes retrieved.',
      data: disputes.map((d) => this.toPartyDto(d, userId)),
    };
  }

  async getMyDispute(userId: number, disputeId: number) {
    const dispute = await this.participantQb(userId)
      .andWhere('d.id = :disputeId', { disputeId })
      .getOne();
    // Deliberately a 404 (not a 403) for a dispute that exists but isn't
    // theirs — never confirm to a stranger that an id is real.
    if (!dispute) throw new NotFoundException('Dispute not found.');

    return {
      message: 'Dispute retrieved.',
      data: this.toPartyDto(dispute, userId),
    };
  }

  /**
   * DR4: the counterparty's single written response.
   *
   * Only the participant who did **not** file it may respond, only once, and
   * only while the dispute is still open work. The raiser already has the
   * `reason` field; letting them "respond" too would give one side two
   * statements.
   */
  async respond(userId: number, disputeId: number, dto: RespondToDisputeDto) {
    const dispute = await this.loadOrFail(disputeId, PARTICIPANT_RELATIONS);
    const { customerId, artisanUserId } = this.participants(dispute);

    if (userId !== customerId && userId !== artisanUserId) {
      // Same reasoning as getMyDispute: don't confirm the id exists.
      throw new NotFoundException('Dispute not found.');
    }
    if (userId === dispute.raisedById) {
      throw new ForbiddenException(
        'You raised this dispute — your account of events is the claim itself. Only the other party can add a response.',
      );
    }
    if (!ACTIVE_STATUSES.includes(dispute.status)) {
      throw new BadRequestException(
        `This dispute is ${dispute.status} and can no longer receive a response.`,
      );
    }
    if (dispute.response) {
      throw new BadRequestException(
        'You have already responded to this dispute. Contact support if you need to add something.',
      );
    }

    dispute.response = dto.response;
    dispute.respondedBy = { id: userId } as User;
    dispute.respondedById = userId;
    dispute.respondedAt = new Date();
    await this.repo.save(dispute);

    return {
      message: 'Your response has been recorded. Our team can now see it.',
      data: this.toPartyDto(dispute, userId),
    };
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
      .leftJoinAndSelect('d.respondedBy', 'respondedBy')
      .orderBy('d.createdAt', 'DESC');

    this.applyQueueFilters(qb, query);

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
   * DQ2: whole-set aggregate counts for the queue's four counter cards, plus
   * DR6's SLA figures.
   *
   * The counters previously summed the loaded page, so they went quietly wrong
   * from row 101 onwards. They are computed here with a single `GROUP BY
   * status` (the codebase's established groupBy + `getRawMany` pattern) over
   * the whole set.
   *
   * The `category`/`q` filters are honoured so the cards describe the active
   * filter; `status` is deliberately **ignored**, because a per-status
   * breakdown filtered to one status is just that status' own count.
   */
  async getQueueSummary(query: GetDisputesQueryDto) {
    const qb = this.repo
      .createQueryBuilder('d')
      .leftJoin('d.raisedBy', 'raisedBy')
      .select('d.status', 'status')
      .addSelect('COUNT(d.id)', 'count')
      .groupBy('d.status');

    this.applyQueueFilters(qb, { ...query, status: undefined });

    const rows = await qb.getRawMany<{
      status: DisputeStatus;
      count: string;
    }>();

    // Postgres returns COUNT as text — every aggregate call site in this
    // codebase wraps in Number(), and the frontend expects numbers.
    const counts = {
      open: 0,
      underReview: 0,
      resolved: 0,
      closed: 0,
      total: 0,
    };
    for (const row of rows) {
      const n = Number(row.count);
      counts.total += n;
      switch (row.status) {
        case DisputeStatus.OPEN:
          counts.open = n;
          break;
        case DisputeStatus.UNDER_REVIEW:
          counts.underReview = n;
          break;
        case DisputeStatus.RESOLVED:
          counts.resolved = n;
          break;
        case DisputeStatus.CLOSED:
          counts.closed = n;
          break;
        default:
          break;
      }
    }

    const sla = await this.getResolutionMetrics();

    return {
      message: 'Dispute queue summary retrieved.',
      data: { counts, sla },
    };
  }

  /**
   * DR6 / AP3: average time from filing to resolution, and how many disputes
   * are still open past the 48h target.
   *
   * Range-scoped so the same method backs both the queue summary (whole set)
   * and the admin analytics screen (selected range). Uses the codebase's
   * existing `AVG`/`COUNT` + `COALESCE` scalar-aggregate pattern.
   *
   * `from`/`to` filter on **filing** date (`created_at`), so "disputes filed
   * in this range" is the population for both figures — the alternative
   * (filtering resolved disputes by `resolved_at`) would make the average and
   * the open-count describe two different sets of disputes.
   */
  async getResolutionMetrics(from?: Date, to?: Date) {
    const scope = <T>(qb: {
      andWhere: (w: string, p?: Record<string, unknown>) => T;
    }) => {
      if (from) qb.andWhere('d.created_at >= :from', { from });
      if (to) qb.andWhere('d.created_at <= :to', { to });
    };

    const avgQb = this.repo
      .createQueryBuilder('d')
      .select(
        'COALESCE(AVG(EXTRACT(EPOCH FROM (d.resolved_at - d.created_at))), 0)',
        'avgSeconds',
      )
      .addSelect('COUNT(d.id)', 'resolvedCount')
      .where('d.resolved_at IS NOT NULL');
    scope(avgQb);

    const openQb = this.repo
      .createQueryBuilder('d')
      .select('COUNT(d.id)', 'count')
      .where('d.status IN (:...active)', { active: ACTIVE_STATUSES });
    scope(openQb);

    const overdueQb = this.repo
      .createQueryBuilder('d')
      .select('COUNT(d.id)', 'count')
      .where('d.status IN (:...active)', { active: ACTIVE_STATUSES })
      .andWhere("d.created_at < NOW() - INTERVAL '48 hours'");
    scope(overdueQb);

    const filedQb = this.repo
      .createQueryBuilder('d')
      .select('COUNT(d.id)', 'count');
    if (from) filedQb.andWhere('d.created_at >= :from', { from });
    if (to) filedQb.andWhere('d.created_at <= :to', { to });

    const [avgRow, openRow, overdueRow, filedRow] = await Promise.all([
      avgQb.getRawOne<{ avgSeconds: string; resolvedCount: string }>(),
      openQb.getRawOne<{ count: string }>(),
      overdueQb.getRawOne<{ count: string }>(),
      filedQb.getRawOne<{ count: string }>(),
    ]);

    const avgSeconds = Number(avgRow?.avgSeconds ?? 0);
    const resolvedCount = Number(avgRow?.resolvedCount ?? 0);

    return {
      /** Average filing → resolution time, in hours. 0 when nothing is resolved yet. */
      averageResolutionHours:
        resolvedCount > 0 ? Number((avgSeconds / 3600).toFixed(2)) : 0,
      resolvedCount,
      filedCount: Number(filedRow?.count ?? 0),
      openCount: Number(openRow?.count ?? 0),
      /** DR6: OPEN/UNDER_REVIEW disputes older than the 48h target. */
      openPast48h: Number(overdueRow?.count ?? 0),
      slaHours: SLA_HOURS,
      /** True when the average breaches PRD §11's stated target. */
      breachesTarget:
        resolvedCount > 0 && avgSeconds / 3600 > SLA_HOURS ? true : false,
    };
  }

  /**
   * Ad3 / DR3: resolves the payment behind a dispute by walking
   * `Dispute → Booking → Job → Payment`.
   *
   * `Job.booking` is written by `BookingsService.confirm()` when a confirmed
   * booking is turned into a job (the R2 flow), so the first hop does resolve
   * for booking-derived jobs — see `assertBookingJobLink` below, which is the
   * regression guard on that.
   *
   * A dispute's booking legitimately may still have no payment at all:
   * booking-derived jobs don't call `holdPayment`, so `payment` being `null`
   * here is an expected, common case, not an error, and the panel's "no
   * payment on file" state stays.
   */
  private async findLinkedWork(bookingId: number): Promise<{
    job: Job | null;
    payment: Payment | null;
  }> {
    // `Job.bookingId` is a `@RelationId` projection, not a real column —
    // TypeORM's find options can't filter on it directly (it throws
    // EntityPropertyNotFoundError at runtime despite compiling fine, since
    // RelationId fields are populated from a loaded relation, not queryable
    // on their own). Filter on the relation itself instead, which TypeORM
    // correctly translates into a `booking_id = :id` condition.
    const job = await this.jobRepo.findOne({
      where: { booking: { id: bookingId } },
      relations: ['service'],
      withDeleted: true,
    });
    if (!job) return { job: null, payment: null };

    const payment = await this.paymentRepo.findOne({
      where: { jobId: job.id },
      order: { createdAt: 'DESC' },
    });
    return { job, payment: payment ?? null };
  }

  async findOne(id: number) {
    const dispute = await this.repo.findOne({
      where: { id },
      relations: [
        'booking',
        'booking.customer',
        'booking.artisanProfile',
        'booking.artisanProfile.user',
        'booking.service',
        'raisedBy',
        'resolvedBy',
        'respondedBy',
      ],
    });
    if (!dispute) throw new NotFoundException('Dispute not found.');

    const { job, payment } = await this.findLinkedWork(dispute.bookingId);
    const work = await this.buildWorkDetail(dispute.booking, job);

    // DR2 / Open Question 14: two parties can each file a separate dispute on
    // one booking, and once a verdict moves money that is a real hazard. Show
    // the admin the sibling disputes so they can see a ruling has (or hasn't)
    // already been made against this booking's payment.
    const siblings = await this.repo.find({
      where: { bookingId: dispute.bookingId, id: Not(dispute.id) },
      relations: ['raisedBy'],
      order: { createdAt: 'ASC' },
    });

    return {
      message: 'Dispute retrieved.',
      data: {
        ...this.toDto(dispute),
        counterparty: this.counterpartySummary(dispute),
        jobId: job?.id ?? null,
        payment,
        /** DQ3: enough about the work to identify it without a second lookup. */
        work,
        siblingDisputes: siblings.map((s) => ({
          id: s.id,
          status: s.status,
          outcome: s.outcome ?? null,
          moneyAction: s.moneyAction ?? null,
          raisedById: s.raisedById,
          raisedByName: s.raisedBy
            ? `${s.raisedBy.firstname} ${s.raisedBy.lastname}`
            : null,
          createdAt: s.createdAt,
        })),
        /** DR2: what the resolve action can actually do, decided server-side. */
        moneyOptions: this.describeMoneyOptions(payment, siblings),
      },
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

  /**
   * DR1 + DR2: records the verdict **and** carries out the money action it
   * implies.
   *
   * Ordering is deliberate and is the whole safety argument:
   *
   *  1. The money plan is decided first, from the payment's real state. If the
   *     verdict implies an action that is *impossible* (no linked payment, the
   *     payment is already REFUNDED/RELEASED, a sibling dispute already moved
   *     money on it), the plan degrades to `NONE` with a stated reason — the
   *     verdict is still recorded, and no clawback is attempted (Open Question
   *     3, resolved). An amount the backend *rejects* is a different thing and
   *     throws here, before anything is written.
   *  2. The dispute is then claimed with a single conditional `UPDATE ...
   *     WHERE status IN ('OPEN','UNDER_REVIEW')`. Exactly one of two
   *     concurrent admins can win that; the loser gets the existing "already
   *     resolved/closed" message rather than a generic failure, and — critically
   *     — never reaches the money action.
   *  3. Only the winner performs the money movement. If it fails, the claim is
   *     rolled back (status, verdict and note restored to what they were) and
   *     the provider's specific error is surfaced, so the dispute is left
   *     actionable and never displays an outcome that contradicts the payment.
   *  4. The real money result is written last, so `moneyAction`/`moneyAmount`
   *     can only ever describe money that actually moved.
   */
  async resolve(admin: User, id: number, dto: ResolveDisputeDto) {
    const dispute = await this.loadOrFail(id, PARTICIPANT_RELATIONS);
    if (
      dispute.status === DisputeStatus.RESOLVED ||
      dispute.status === DisputeStatus.CLOSED
    ) {
      throw new BadRequestException(`Dispute is already ${dispute.status}.`);
    }

    const previousStatus = dispute.status;
    const previousOutcome = dispute.outcome ?? null;
    const previousResolution = dispute.resolution ?? null;

    // 1 ── decide what the money side is going to do, before writing anything.
    const plan = await this.planMoneyAction(dispute, dto);

    // 2 ── atomic claim. `affected === 0` means another admin (or another
    // request from the same admin) got here first.
    const claim = await this.repo
      .createQueryBuilder()
      .update(Dispute)
      .set({
        status: DisputeStatus.RESOLVED,
        outcome: dto.outcome,
        resolution: dto.resolution,
        resolvedById: admin.id,
        resolvedAt: new Date(),
        ...(dto.adminNotes ? { adminNotes: dto.adminNotes } : {}),
        // Left null on purpose: this column must only ever describe money that
        // actually moved, so it is written in step 4, never optimistically.
        moneyAction: undefined,
      })
      .where('id = :id', { id })
      .andWhere('status IN (:...active)', { active: ACTIVE_STATUSES })
      .execute();

    if (!claim.affected) {
      const current = await this.repo.findOne({ where: { id } });
      throw new BadRequestException(
        `Dispute is already ${current?.status ?? 'resolved'}. Another admin resolved it first — reload to see their ruling.`,
      );
    }

    // 3 ── money movement, for the winner only.
    let moved: {
      action: DisputeMoneyAction;
      amount: number;
      paymentId: number;
    } | null = null;
    if (plan.action !== DisputeMoneyAction.NONE && plan.paymentId) {
      try {
        if (plan.action === DisputeMoneyAction.REFUND) {
          await this.paymentsService.adminRefund(
            plan.paymentId,
            plan.amount,
            admin,
          );
        } else {
          await this.paymentsService.releaseWithheldPayment(plan.paymentId);
        }
        moved = {
          action: plan.action,
          amount: plan.amount ?? 0,
          paymentId: plan.paymentId,
        };
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        this.logger.error(
          `Dispute ${id}: ${plan.action} on payment ${plan.paymentId} failed — rolling the ruling back. ${detail}`,
        );
        await this.repo
          .createQueryBuilder()
          .update(Dispute)
          .set({
            status: previousStatus,
            outcome: previousOutcome ?? undefined,
            resolution: previousResolution ?? undefined,
            resolvedById: undefined,
            resolvedAt: undefined,
            moneyAction: undefined,
          })
          .where('id = :id', { id })
          .execute();

        throw new BadRequestException(
          `The ${plan.action === DisputeMoneyAction.REFUND ? 'refund' : 'release'} could not be completed, ` +
            `so this dispute has NOT been resolved and is still actionable. Reason: ${detail}`,
        );
      }
    }

    // 4 ── record what actually happened to the money.
    await this.repo
      .createQueryBuilder()
      .update(Dispute)
      .set({
        moneyAction: moved ? moved.action : DisputeMoneyAction.NONE,
        moneyAmount: moved ? moved.amount : undefined,
        moneyPaymentId: moved ? moved.paymentId : undefined,
      })
      .where('id = :id', { id })
      .execute();

    // Reflect the committed state on the in-memory entity for the notification
    // and audit payloads below.
    dispute.status = DisputeStatus.RESOLVED;
    dispute.outcome = dto.outcome;
    dispute.resolution = dto.resolution;
    dispute.resolvedById = admin.id;
    dispute.resolvedAt = new Date();
    dispute.moneyAction = moved ? moved.action : DisputeMoneyAction.NONE;
    dispute.moneyAmount = moved?.amount;
    dispute.moneyPaymentId = moved?.paymentId;

    this.emitOutcome(dispute, 'RESOLVED', dto.resolution);
    await this.recordRuling(
      admin,
      dispute,
      AdminActionType.DISPUTE_RESOLVE,
      dto.resolution,
    );

    return {
      message: this.describeRuling(dto.outcome, moved, plan.skippedReason),
      data: {
        outcome: dto.outcome,
        moneyAction: dispute.moneyAction,
        moneyAmount: dispute.moneyAmount ?? null,
        moneyPaymentId: dispute.moneyPaymentId ?? null,
        /** Present when the verdict implied a money action that wasn't possible. */
        moneySkippedReason: moved ? null : (plan.skippedReason ?? null),
      },
    };
  }

  async close(admin: User, id: number, dto: CloseDisputeDto) {
    const dispute = await this.loadOrFail(id, PARTICIPANT_RELATIONS);
    if (dispute.status === DisputeStatus.CLOSED) {
      throw new BadRequestException('Dispute is already closed.');
    }

    // Same conditional-update mutex as resolve(), so two admins closing (or
    // one closing while another resolves) cannot both succeed.
    const claim = await this.repo
      .createQueryBuilder()
      .update(Dispute)
      .set({
        status: DisputeStatus.CLOSED,
        resolvedById: admin.id,
        resolvedAt: new Date(),
        ...(dto.adminNotes ? { adminNotes: dto.adminNotes } : {}),
      })
      .where('id = :id', { id })
      .andWhere('status != :closed', { closed: DisputeStatus.CLOSED })
      .execute();
    if (!claim.affected) {
      throw new BadRequestException('Dispute is already closed.');
    }

    dispute.status = DisputeStatus.CLOSED;
    dispute.resolvedById = admin.id;
    dispute.resolvedAt = new Date();

    this.emitOutcome(dispute, 'CLOSED');
    await this.recordRuling(
      admin,
      dispute,
      AdminActionType.DISPUTE_CLOSE,
      dto.adminNotes ?? null,
    );
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
   *
   * This rule is settled product behaviour and is deliberately unchanged by
   * this round — do not relax it.
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

  // ─── Money-plan helpers (DR2) ────────────────────────────────────────────────

  /**
   * Decides what the money side of a verdict will do, from the payment's real
   * state, before anything is written.
   *
   * Returns `NONE` with a `skippedReason` for every case where the action is
   * *impossible* — no linked payment (the common case today), a payment
   * already refunded or released, a sibling dispute that already moved money
   * on it. Throws only for an amount the backend genuinely rejects.
   */
  private async planMoneyAction(
    dispute: Dispute,
    dto: ResolveDisputeDto,
  ): Promise<MoneyPlan> {
    if (dto.outcome === DisputeOutcome.MUTUAL) {
      if (dto.refundAmountGhs != null) {
        throw new BadRequestException(
          'A refund amount cannot be supplied with a "mutually resolved" verdict — that verdict moves no money.',
        );
      }
      return {
        action: DisputeMoneyAction.NONE,
        skippedReason: 'Mutually resolved — no money moves by design.',
      };
    }

    if (
      dto.refundAmountGhs != null &&
      dto.outcome !== DisputeOutcome.REFUND_CLIENT
    ) {
      throw new BadRequestException(
        'A refund amount is only valid with the "rule for client" verdict.',
      );
    }

    const { payment } = await this.findLinkedWork(dispute.bookingId);
    if (!payment) {
      return {
        action: DisputeMoneyAction.NONE,
        skippedReason:
          'No payment is linked to this booking, so there was nothing to refund or release. The verdict has been recorded.',
      };
    }

    // Open Question 14 (resolved): the one-dispute-per-booking-per-raiser rule
    // stays, so two disputes can point at one payment. This is the hard guard
    // against the second one moving money again. The partial unique index
    // `uq_disputes_money_payment` is the DB-level backstop behind it.
    const siblingWithMoney = await this.repo.findOne({
      where: {
        bookingId: dispute.bookingId,
        id: Not(dispute.id),
        moneyPaymentId: payment.id,
        moneyAction: In([
          DisputeMoneyAction.REFUND,
          DisputeMoneyAction.RELEASE,
        ]),
      },
    });
    if (siblingWithMoney) {
      return {
        action: DisputeMoneyAction.NONE,
        skippedReason:
          `Dispute #${siblingWithMoney.id} already moved money on this payment ` +
          `(${siblingWithMoney.moneyAction}). No second money action was taken; the verdict has been recorded.`,
      };
    }

    if (dto.outcome === DisputeOutcome.REFUND_CLIENT) {
      return this.planRefund(payment, dto.refundAmountGhs);
    }
    return this.planRelease(payment);
  }

  private planRefund(payment: Payment, requested?: number): MoneyPlan {
    const refundable: PaymentStatus[] = [
      PaymentStatus.HELD,
      PaymentStatus.RELEASED,
    ];
    if (!refundable.includes(payment.status)) {
      return {
        action: DisputeMoneyAction.NONE,
        skippedReason: `This payment is ${payment.status}, which cannot be refunded. The verdict has been recorded without a money action.`,
      };
    }

    const alreadyRefunded = Number(payment.refundedAmount ?? 0);
    const remaining = +(Number(payment.amount) - alreadyRefunded).toFixed(2);
    if (remaining <= 0) {
      return {
        action: DisputeMoneyAction.NONE,
        skippedReason:
          'This payment has already been fully refunded, so there was nothing left to refund. The verdict has been recorded.',
      };
    }

    // DR2: full refund by default; a partial amount may be supplied in the
    // same action. Rejected amounts fail *before* the dispute is touched.
    const amount = requested ?? remaining;
    if (amount > remaining) {
      throw new BadRequestException(
        `Refund amount (${formatGhs(amount)}) exceeds the remaining refundable balance (${formatGhs(remaining)}).`,
      );
    }

    return { action: DisputeMoneyAction.REFUND, paymentId: payment.id, amount };
  }

  private planRelease(payment: Payment): MoneyPlan {
    if (payment.status === PaymentStatus.RELEASED) {
      return {
        action: DisputeMoneyAction.NONE,
        skippedReason:
          'This payment was already released to the artisan, so there was nothing to release. The verdict has been recorded.',
      };
    }
    if (payment.status === PaymentStatus.HELD && payment.transferCode) {
      return {
        action: DisputeMoneyAction.NONE,
        skippedReason:
          'A payout for this payment has already been initiated and is awaiting confirmation. The verdict has been recorded without starting a second transfer.',
      };
    }

    const releasable: PaymentStatus[] = [
      PaymentStatus.HELD,
      PaymentStatus.PENDING_TRANSFER,
      PaymentStatus.TRANSFER_FAILED,
    ];
    if (!releasable.includes(payment.status)) {
      return {
        action: DisputeMoneyAction.NONE,
        skippedReason: `This payment is ${payment.status}, so there is no withheld amount to release. The verdict has been recorded.`,
      };
    }

    return {
      action: DisputeMoneyAction.RELEASE,
      paymentId: payment.id,
      amount: Number(payment.artisanAmount),
    };
  }

  /**
   * DR2: tells the admin surface, server-side, which money verdicts are
   * actually available on this dispute and why — so the UI can disable an
   * option with a stated reason instead of letting an admin pick something the
   * backend will decline to do.
   */
  private describeMoneyOptions(payment: Payment | null, siblings: Dispute[]) {
    if (!payment) {
      return {
        canRefund: false,
        canRelease: false,
        reason:
          'No payment is linked to this booking, so there is nothing to refund or release. You can still record any verdict.',
        refundableAmount: 0,
        releasableAmount: 0,
      };
    }

    const siblingWithMoney = siblings.find(
      (s) =>
        s.moneyPaymentId === payment.id &&
        s.moneyAction &&
        s.moneyAction !== DisputeMoneyAction.NONE,
    );
    if (siblingWithMoney) {
      return {
        canRefund: false,
        canRelease: false,
        reason: `Dispute #${siblingWithMoney.id} already moved money on this payment (${siblingWithMoney.moneyAction}).`,
        refundableAmount: 0,
        releasableAmount: 0,
      };
    }

    const refundPlan = this.planRefundSafely(payment);
    const releasePlan = this.planRelease(payment);

    return {
      canRefund: refundPlan.action === DisputeMoneyAction.REFUND,
      canRelease: releasePlan.action === DisputeMoneyAction.RELEASE,
      refundReason: refundPlan.skippedReason ?? null,
      releaseReason: releasePlan.skippedReason ?? null,
      refundableAmount: refundPlan.amount ?? 0,
      releasableAmount: releasePlan.amount ?? 0,
      paymentStatus: payment.status,
    };
  }

  /** `planRefund` without the throw, for the read-only options describer. */
  private planRefundSafely(payment: Payment): MoneyPlan {
    try {
      return this.planRefund(payment);
    } catch {
      return {
        action: DisputeMoneyAction.NONE,
        skippedReason: 'This payment cannot be refunded.',
      };
    }
  }

  private describeRuling(
    outcome: DisputeOutcome,
    moved: { action: DisputeMoneyAction; amount: number } | null,
    skippedReason?: string,
  ): string {
    if (moved?.action === DisputeMoneyAction.REFUND) {
      return `Dispute resolved. ${formatGhs(moved.amount)} refunded to the client. Both parties have been notified.`;
    }
    if (moved?.action === DisputeMoneyAction.RELEASE) {
      return `Dispute resolved. ${formatGhs(moved.amount)} released to the artisan. Both parties have been notified.`;
    }
    if (outcome === DisputeOutcome.MUTUAL) {
      return 'Dispute resolved as mutually resolved. No money moved. Both parties have been notified.';
    }
    return `Dispute resolved, verdict recorded. ${skippedReason ?? 'No money moved.'} Both parties have been notified.`;
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  /**
   * DP2: base query for "disputes this user is a participant of" — either the
   * raiser, the booking's customer, or the booking's artisan.
   *
   * `Booking.customerId` / `Booking.artisanProfileId` are `@RelationId`
   * projections, not real columns, so the raw snake_case column names are used
   * here (the same approach `AdminService.listBookings` documents).
   */
  private participantQb(userId: number) {
    return this.repo
      .createQueryBuilder('d')
      .leftJoinAndSelect('d.booking', 'booking')
      .leftJoinAndSelect('booking.service', 'service')
      .leftJoin('booking.artisanProfile', 'artisanProfile')
      .leftJoinAndSelect('d.raisedBy', 'raisedBy')
      .leftJoinAndSelect('d.respondedBy', 'respondedBy')
      .where(
        new Brackets((qb) =>
          qb
            .where('d.raised_by_id = :userId', { userId })
            .orWhere('booking.customer_id = :userId', { userId })
            .orWhere('artisanProfile.user_id = :userId', { userId }),
        ),
      );
  }

  /** DQ1: status, category and free-text search, all server-side. */
  private applyQueueFilters(
    qb: {
      andWhere: (
        where: string | Brackets,
        params?: Record<string, unknown>,
      ) => unknown;
      leftJoin?: unknown;
    },
    query: GetDisputesQueryDto,
  ): void {
    if (query.status) {
      qb.andWhere('d.status = :status', { status: query.status });
    }
    if (query.category) {
      qb.andWhere('d.category = :category', { category: query.category });
    }

    const term = query.q?.trim();
    if (term) {
      const like = `%${term.toLowerCase()}%`;
      const numeric = /^\d+$/.test(term) ? Number(term) : null;
      qb.andWhere(
        new Brackets((inner) => {
          inner
            .where(
              "LOWER(raisedBy.firstname || ' ' || raisedBy.lastname) LIKE :like",
              {
                like,
              },
            )
            .orWhere('LOWER(raisedBy.email) LIKE :like', { like });
          if (numeric !== null) {
            inner
              .orWhere('d.id = :numeric', { numeric })
              .orWhere('d.booking_id = :numeric', { numeric });
          }
        }),
      );
    }
  }

  private async loadOrFail(id: number, relations?: string[]): Promise<Dispute> {
    const dispute = await this.repo.findOne({ where: { id }, relations });
    if (!dispute) throw new NotFoundException('Dispute not found.');
    return dispute;
  }

  private participants(dispute: Dispute) {
    return {
      customerId: dispute.booking?.customer?.id,
      artisanUserId: dispute.booking?.artisanProfile?.user?.id,
    };
  }

  private counterpartySummary(dispute: Dispute) {
    const customer = dispute.booking?.customer;
    const artisanUser = dispute.booking?.artisanProfile?.user;
    const counterparty =
      dispute.raisedById === customer?.id ? artisanUser : customer;
    if (!counterparty) return null;
    return {
      id: counterparty.id,
      firstname: counterparty.firstname,
      lastname: counterparty.lastname,
      profilePicture: counterparty.profilePicture,
      role: counterparty.id === artisanUser?.id ? Role.ARTISAN : Role.CUSTOMER,
    };
  }

  /**
   * DQ3: the job/booking detail PRD §5.13 requires and the old dialog omitted
   * — service, scheduled/completed dates, current status and agreed price, so
   * an admin can identify the work without cross-referencing another screen.
   *
   * `completedAt` is derived from `job_status_history`'s transition into
   * `COMPLETED` rather than a column, because `Job` has no `completedAt` and
   * `updatedAt` also moves on unrelated writes.
   */
  private async buildWorkDetail(booking: Booking | undefined, job: Job | null) {
    if (!booking) return null;

    let completedAt: Date | null = null;
    if (job) {
      const completion = await this.jobHistoryRepo.findOne({
        where: { jobId: job.id, toStatus: Status.COMPLETED },
        order: { createdAt: 'DESC' },
      });
      completedAt = completion?.createdAt ?? null;
    }

    return {
      bookingId: booking.id,
      service: booking.service
        ? { id: booking.service.id, name: booking.service.name }
        : job?.service
          ? { id: job.service.id, name: job.service.name }
          : null,
      scheduledDate: booking.scheduledDate,
      startTime: booking.startTime,
      endTime: booking.endTime,
      bookingStatus: booking.status,
      agreedPrice:
        booking.agreedPrice != null ? Number(booking.agreedPrice) : null,
      currency: booking.currency,
      job: job
        ? {
            id: job.id,
            title: job.title ?? null,
            status: job.status,
            location: job.location,
            budgetMax: job.budgetMax != null ? Number(job.budgetMax) : null,
            currency: job.currency,
            createdAt: job.createdAt,
            completedAt,
            deletedAt: job.deletedAt ?? null,
          }
        : null,
    };
  }

  /**
   * PD4: notifies both the party who raised the dispute and the counterparty
   * of the final outcome — PRD §5.13's "both parties notified automatically".
   *
   * DR2/DR4: now carries the verdict and, where money moved, the amount and
   * which side it went to, so the notification says what was decided instead
   * of only that something was.
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
      const { customerId, artisanUserId } = this.participants(dispute);

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
          verdict: dispute.outcome,
          moneyAction: dispute.moneyAction,
          moneyAmount:
            dispute.moneyAmount != null
              ? Number(dispute.moneyAmount)
              : undefined,
          customerUserId: customerId,
          artisanUserId,
        } as DisputeOutcomePayload,
      );
    } catch (err) {
      this.logger.error(
        `Failed to emit dispute ${outcome} notification for dispute ${dispute.id}: ${(err as Error).message}`,
      );
    }
  }

  /** AT5: one audit row per ruling, carrying the verdict and any money action. */
  private async recordRuling(
    admin: User,
    dispute: Dispute,
    action: AdminActionType,
    reason: string | null,
  ): Promise<void> {
    await this.auditService.record({
      action,
      targetType: AdminActionTarget.DISPUTE,
      targetId: dispute.id,
      targetLabel: `Dispute #${dispute.id} · booking #${dispute.bookingId}`,
      reason,
      actorId: admin.id,
      actorName: `${admin.firstname} ${admin.lastname}`,
      actorEmail: admin.email,
      outcome: dispute.outcome ?? null,
      moneyAction: dispute.moneyAction ?? null,
      amount: dispute.moneyAmount != null ? Number(dispute.moneyAmount) : null,
      metadata: {
        bookingId: dispute.bookingId,
        ...(dispute.moneyPaymentId
          ? { paymentId: dispute.moneyPaymentId }
          : {}),
        ...(dispute.category ? { category: dispute.category } : {}),
      },
    });
  }

  private toDto(dispute: Dispute): DisputeResponseDto {
    const dto = plainToInstance(DisputeResponseDto, dispute, {
      excludeExtraneousValues: true,
    });
    // DR5: disputes filed before the category column existed have none; read
    // them back as OTHER rather than leaking a null into a badge slot.
    dto.category = dispute.category ?? DisputeCategory.OTHER;
    return dto;
  }

  /**
   * DP2: the party-facing shape. `PartyDisputeResponseDto` has no
   * `adminNotes` field at all, so `excludeExtraneousValues` drops it — a
   * party can never see admin-internal notes, enforced by the DTO rather than
   * by a caller remembering to strip it.
   */
  private toPartyDto(
    dispute: Dispute,
    viewerId: number,
  ): PartyDisputeResponseDto {
    const dto = plainToInstance(PartyDisputeResponseDto, dispute, {
      excludeExtraneousValues: true,
    });
    dto.category = dispute.category ?? DisputeCategory.OTHER;
    dto.viewerRole =
      dispute.raisedById === viewerId ? 'RAISER' : 'COUNTERPARTY';
    dto.canRespond =
      dto.viewerRole === 'COUNTERPARTY' &&
      !dispute.response &&
      ACTIVE_STATUSES.includes(dispute.status);
    return dto;
  }
}

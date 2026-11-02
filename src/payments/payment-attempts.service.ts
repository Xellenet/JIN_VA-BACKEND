import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, Repository } from 'typeorm';
import { randomBytes } from 'crypto';
import { PaymentStatus } from '@common/types/enums';
import { Payment } from './entities/payment.entity';
import {
  ACTIVE_CHARGE_STATUSES,
  isActiveCharge,
  PaymentCharge,
  type ActiveChargeStatus,
  type ChargeMethodType,
  type RefundStatus,
} from './entities/payment-charge.entity';
import { PaystackRequestError, PaystackService } from './paystack.service';
import { CHARGE_MESSAGES } from './charge-outcome';
import { CustomerPaymentMethod } from '../payment-methods/entities/customer-payment-method.entity';
import {
  NETWORK_LABEL,
  normaliseCardBrand,
} from '../payment-methods/payment-methods.constants';

/** How long an attempt holds the job before it may be released (after a verify). */
export const ATTEMPT_WINDOW_MS: Record<ChargeMethodType, number> = {
  mobile_money: 10 * 60_000,
  card: 10 * 60_000,
  hosted: 30 * 60_000,
};
/** An active attempt is checked with Paystack at most this often. */
export const ATTEMPT_VERIFY_INTERVAL_MS = 15_000;

/** Payment states that mean the job is paid (paying again is refused). */
export const PAID_STATUSES: readonly PaymentStatus[] = [
  PaymentStatus.HELD,
  PaymentStatus.PENDING_TRANSFER,
  PaymentStatus.TRANSFER_FAILED,
  PaymentStatus.RELEASED,
  PaymentStatus.REFUNDED,
];

export const ALREADY_PAID = 'ALREADY_PAID';
export const PAYMENT_ATTEMPT_ACTIVE = 'PAYMENT_ATTEMPT_ACTIVE';
export const JOB_ALREADY_PAID = 'This job is already paid.';

export const ATTEMPT_ACTIVE_MESSAGES: Record<ChargeMethodType, string> = {
  mobile_money:
    'A payment is waiting for approval on your phone. Approve or decline it there, or wait for it to expire, before paying another way.',
  hosted:
    'A payment is open on the checkout page. Finish or close it there, or wait for it to expire, before paying another way.',
  card: 'A card payment is being confirmed. Wait for it to finish before paying another way.',
};

/** What the customer sees of an attempt that is still active. */
export interface AttemptView {
  reference: string;
  jobId: number;
  kind: ChargeMethodType;
  status: ActiveChargeStatus;
  action: string | null;
  message: string | null;
  paymentMethodId: number | null;
  startedAt: string;
  expiresAt: string;
  /** Hosted only: the open checkout page. */
  authorizationUrl: string | null;
}

/** A refunded (or being refunded) duplicate payment. */
export interface DuplicateRefundView {
  reference: string;
  amount: number;
  currency: 'GHS';
  method: ChargeMethodType;
  methodLabel: string | null;
  status: Exclude<RefundStatus, 'processing'>;
  createdAt: string;
}

export interface PaidPaymentView {
  jobId: number;
  status: PaymentStatus;
  amount: number;
  currency: string;
  paidAt: string | null;
  reference: string;
}

export interface JobPaymentState {
  jobId: number;
  paid: boolean;
  payment: {
    id: number;
    status: PaymentStatus;
    amount: number;
    currency: string;
    paidAt: string | null;
  } | null;
  activeAttempt: AttemptView | null;
  duplicateRefunds: DuplicateRefundView[];
}

/** What to start: the hosted checkout, or a charge of one saved method. */
export type AttemptSpec =
  | { kind: 'hosted' }
  | { kind: 'mobile_money' | 'card'; paymentMethodId: number };

export type ClaimResult =
  | { outcome: 'created'; payment: Payment; charge: PaymentCharge }
  | { outcome: 'existing'; payment: Payment; charge: PaymentCharge };

/** The money path: a verified success goes through the locked HELD transition. */
export type SettleCharge = (
  chargeId: number,
  data: Record<string, unknown>,
) => Promise<void>;

/** What a check with Paystack did to an active attempt. */
export type ReconcileOutcome = 'settled' | 'released' | 'active';

type TryClaim =
  | ClaimResult
  | { outcome: 'stale'; payment: Payment; charge: PaymentCharge }
  | { outcome: 'raced' };

const RELEASE_ON_REMOTE = new Set(['failed', 'abandoned', 'reversed']);

/** A Postgres unique violation on the one-active-attempt index. */
function isActiveIndexViolation(err: unknown): boolean {
  const e = err as { code?: string; constraint?: string; message?: string };
  return (
    e?.code === '23505' &&
    (e.constraint === 'uq_payment_charges_one_active' ||
      /uq_payment_charges_one_active/.test(e.message ?? ''))
  );
}

/**
 * One active payment attempt per job. Every way of paying (the hosted
 * checkout, a saved mobile money number, a saved card) starts here, under a
 * lock on the job's payment row, and the partial unique index
 * `uq_payment_charges_one_active` backs the rule in the database:
 *
 * - The same kind again (or the same saved method) returns the active attempt.
 * - A different kind is refused with 409 `PAYMENT_ATTEMPT_ACTIVE`, carrying
 *   the active attempt so the client can resume it.
 * - A paid job is refused with 409 `ALREADY_PAID`, carrying the payment.
 * - An attempt is released only after Paystack says it did not succeed:
 *   a saved charge as soon as Paystack reports it failed, abandoned or
 *   reversed; any attempt once it is past its window (10 minutes for saved
 *   methods, 30 for the hosted checkout) and Paystack does not report a
 *   success. If Paystack can't be reached, the attempt stays active. A
 *   success found this way goes through the same HELD transition as the
 *   webhook. This happens lazily, on the next request for the job.
 */
@Injectable()
export class PaymentAttemptsService {
  private readonly logger = new Logger(PaymentAttemptsService.name);

  constructor(
    @InjectRepository(Payment) private readonly payments: Repository<Payment>,
    @InjectRepository(PaymentCharge)
    private readonly charges: Repository<PaymentCharge>,
    private readonly dataSource: DataSource,
    private readonly paystack: PaystackService,
  ) {}

  // ─── Views and errors ───────────────────────────────────────────────────────

  static isPaid(status: PaymentStatus | string): boolean {
    return (PAID_STATUSES as readonly string[]).includes(status);
  }

  static expiresAt(charge: PaymentCharge): Date {
    if (charge.expiresAt) return new Date(charge.expiresAt);
    return new Date(
      new Date(charge.createdAt).getTime() +
        ATTEMPT_WINDOW_MS[charge.methodType],
    );
  }

  static isPastWindow(charge: PaymentCharge, now = Date.now()): boolean {
    return now >= PaymentAttemptsService.expiresAt(charge).getTime();
  }

  static view(charge: PaymentCharge, jobId: number): AttemptView {
    return {
      reference: charge.reference,
      jobId,
      kind: charge.methodType,
      status: charge.status as ActiveChargeStatus,
      action: charge.action ?? null,
      message: charge.message ?? null,
      paymentMethodId: charge.paymentMethodId ?? null,
      startedAt: new Date(charge.createdAt).toISOString(),
      expiresAt: PaymentAttemptsService.expiresAt(charge).toISOString(),
      authorizationUrl:
        charge.methodType === 'hosted'
          ? (charge.authorizationUrl ?? null)
          : null,
    };
  }

  static paidView(payment: Payment): PaidPaymentView {
    return {
      jobId: payment.jobId,
      status: payment.status,
      amount: Number(payment.amount),
      currency: payment.currency,
      paidAt: payment.paidAt ? new Date(payment.paidAt).toISOString() : null,
      reference: payment.paidReference ?? payment.reference,
    };
  }

  static alreadyPaid(payment: Payment): ConflictException {
    return new ConflictException({
      errorCode: ALREADY_PAID,
      message: JOB_ALREADY_PAID,
      data: PaymentAttemptsService.paidView(payment),
    });
  }

  static attemptActive(charge: PaymentCharge, jobId: number) {
    return new ConflictException({
      errorCode: PAYMENT_ATTEMPT_ACTIVE,
      message: ATTEMPT_ACTIVE_MESSAGES[charge.methodType],
      data: PaymentAttemptsService.view(charge, jobId),
    });
  }

  private static sameKind(charge: PaymentCharge, spec: AttemptSpec): boolean {
    if (spec.kind === 'hosted') return charge.methodType === 'hosted';
    return (
      charge.methodType !== 'hosted' &&
      charge.paymentMethodId === spec.paymentMethodId
    );
  }

  static newReference(kind: ChargeMethodType, paymentId: number): string {
    const tag = kind === 'hosted' ? 'ho' : 'ch';
    return `jinva-${tag}-${paymentId}-${Date.now()}-${randomBytes(3).toString('hex')}`;
  }

  // ─── Starting an attempt ────────────────────────────────────────────────────

  /**
   * Starts an attempt of `spec` for the caller's job, or returns the active
   * one of the same kind. Throws 409 `ALREADY_PAID`, 409
   * `PAYMENT_ATTEMPT_ACTIVE` or 404 (`notFoundMessage`).
   */
  async claim(
    customerId: number,
    jobId: number,
    spec: AttemptSpec,
    settle: SettleCharge,
    notFoundMessage: string,
  ): Promise<ClaimResult> {
    for (let round = 0; round < 4; round++) {
      const res = await this.tryClaim(customerId, jobId, spec, notFoundMessage);
      if (res.outcome === 'raced') continue;
      if (res.outcome !== 'stale') return res;
      const outcome = await this.reconcile(res.charge, settle, {
        force: true,
      });
      if (outcome === 'active') {
        // Paystack couldn't say: never release blind. The same kind gets
        // its attempt back; another kind waits.
        if (PaymentAttemptsService.sameKind(res.charge, spec)) {
          return {
            outcome: 'existing',
            payment: res.payment,
            charge: res.charge,
          };
        }
        throw PaymentAttemptsService.attemptActive(res.charge, jobId);
      }
    }
    // Only reachable after repeated index races, which the lock prevents.
    throw new ConflictException({
      errorCode: PAYMENT_ATTEMPT_ACTIVE,
      message: 'A payment for this job is being started. Try again.',
    });
  }

  private async tryClaim(
    customerId: number,
    jobId: number,
    spec: AttemptSpec,
    notFoundMessage: string,
  ): Promise<TryClaim> {
    try {
      return await this.dataSource.transaction(async (manager) => {
        const payment = await this.lockPayable(
          manager,
          customerId,
          jobId,
          notFoundMessage,
        );
        const repo = manager.getRepository(PaymentCharge);
        const active = await repo.findOne({
          where: {
            paymentId: payment.id,
            status: In([...ACTIVE_CHARGE_STATUSES]),
          },
          order: { createdAt: 'DESC', id: 'DESC' },
        });
        if (active) {
          if (PaymentAttemptsService.isPastWindow(active)) {
            return { outcome: 'stale', payment, charge: active } as const;
          }
          if (PaymentAttemptsService.sameKind(active, spec)) {
            return { outcome: 'existing', payment, charge: active } as const;
          }
          throw PaymentAttemptsService.attemptActive(active, jobId);
        }

        const kind: ChargeMethodType = spec.kind;
        // The first hosted attempt uses the payment's own reference (the
        // one the pay page and the redirect already know); later ones, and
        // every saved-method charge, get their own.
        const ownTaken =
          kind !== 'hosted' ||
          (await repo.count({ where: { reference: payment.reference } })) > 0;
        const now = Date.now();
        const charge = await repo.save(
          repo.create({
            paymentId: payment.id,
            customerId,
            reference: ownTaken
              ? PaymentAttemptsService.newReference(kind, payment.id)
              : payment.reference,
            methodType: kind,
            paymentMethodId:
              spec.kind === 'hosted' ? null : spec.paymentMethodId,
            status: kind === 'hosted' ? 'hosted_open' : 'pending',
            action: kind === 'hosted' ? 'continue_checkout' : 'wait',
            message: kind === 'hosted' ? null : CHARGE_MESSAGES.CONFIRMING,
            lastVerifiedAt: null,
            expiresAt: new Date(now + ATTEMPT_WINDOW_MS[kind]),
          }),
        );
        return { outcome: 'created', payment, charge } as const;
      });
    } catch (err) {
      if (isActiveIndexViolation(err)) return { outcome: 'raced' };
      throw err;
    }
  }

  /**
   * The caller's pending payment for the job, locked. A paid job is 409
   * `ALREADY_PAID`; no payment due is 404.
   */
  async lockPayable(
    manager: EntityManager,
    customerId: number,
    jobId: number,
    notFoundMessage: string,
  ): Promise<Payment> {
    const payment = await manager.getRepository(Payment).findOne({
      where: { jobId, customerId, status: PaymentStatus.PENDING },
      lock: { mode: 'pessimistic_write' },
    });
    if (payment) return payment;
    const latest = await manager.getRepository(Payment).findOne({
      where: { jobId, customerId },
      order: { id: 'DESC' },
    });
    if (latest && PaymentAttemptsService.isPaid(latest.status)) {
      throw PaymentAttemptsService.alreadyPaid(latest);
    }
    throw new NotFoundException(notFoundMessage);
  }

  // ─── Checking with Paystack ─────────────────────────────────────────────────

  /**
   * Asks Paystack about an active attempt (at most every
   * `ATTEMPT_VERIFY_INTERVAL_MS` unless `force`), then settles it, releases
   * it, or leaves it active. Never releases a success, and never releases
   * without an answer from Paystack.
   */
  async reconcile(
    charge: PaymentCharge,
    settle: SettleCharge,
    opts: { force?: boolean } = {},
  ): Promise<ReconcileOutcome> {
    if (!isActiveCharge(charge.status)) return 'released';
    const now = Date.now();
    const lastCheck = new Date(
      charge.lastVerifiedAt ?? charge.createdAt,
    ).getTime();
    if (!opts.force && now - lastCheck < ATTEMPT_VERIFY_INTERVAL_MS) {
      return 'active';
    }
    await this.charges.update(
      { id: charge.id },
      { lastVerifiedAt: new Date(now) },
    );

    let remoteStatus: string | null;
    let remote: Awaited<
      ReturnType<PaystackService['verifyTransaction']>
    > | null = null;
    try {
      remote = await this.paystack.verifyTransaction(charge.reference);
      remoteStatus = typeof remote?.status === 'string' ? remote.status : null;
    } catch (err) {
      // Paystack answered "no" (e.g. no such transaction: the charge never
      // started): that is a non-success. Anything else is "unknown".
      remoteStatus = err instanceof PaystackRequestError ? 'not_found' : null;
    }

    if (remoteStatus === 'success' && remote) {
      await settle(charge.id, {
        reference: charge.reference,
        amount: remote.amount,
        currency: remote.currency,
        channel: remote.channel,
        paid_at: remote.paid_at,
      });
      return 'settled';
    }
    if (remoteStatus === null) return 'active';

    const pastWindow = PaymentAttemptsService.isPastWindow(charge, now);
    const savedFailed =
      charge.methodType !== 'hosted' && RELEASE_ON_REMOTE.has(remoteStatus);
    if (!pastWindow && !savedFailed) return 'active';

    const released = await this.release(
      charge,
      savedFailed ? 'failed' : 'expired',
    );
    return released ? 'released' : 'active';
  }

  /** Moves an active attempt to `failed`/`expired`, only if still active. */
  private async release(
    charge: PaymentCharge,
    to: 'failed' | 'expired',
  ): Promise<boolean> {
    const message =
      charge.methodType === 'hosted'
        ? null
        : to === 'failed'
          ? CHARGE_MESSAGES.FAILED
          : CHARGE_MESSAGES.NOT_APPROVED;
    const res = await this.charges.update(
      { id: charge.id, status: In([...ACTIVE_CHARGE_STATUSES]) },
      { status: to, action: null, message },
    );
    const done = (res?.affected ?? 0) > 0;
    if (done) {
      this.logger.log(
        `Payment attempt ${charge.reference} released (${to}) after a check with Paystack`,
      );
    }
    return done;
  }

  // ─── Reading a job's payment state ──────────────────────────────────────────

  /**
   * `GET /payments/jobs/:jobId/attempt`: whether the job is paid, the active
   * attempt (checked with Paystack first when due), and any duplicate
   * payments refunded for it. 404 unless the caller is the job's customer.
   */
  async jobState(
    customerId: number,
    jobId: number,
    settle: SettleCharge,
  ): Promise<JobPaymentState> {
    const find = () =>
      this.payments.findOne({
        where: { jobId, customerId },
        order: { id: 'DESC' },
      });
    let payment = await find();
    if (!payment) throw new NotFoundException('Payment not found.');

    let active = await this.activeFor(payment.id);
    if (active) {
      const outcome = await this.reconcile(active, settle, {
        force: false,
      });
      if (outcome !== 'active') {
        payment = (await find()) ?? payment;
        active = await this.activeFor(payment.id);
      }
    }

    const duplicates = await this.charges.find({
      where: { paymentId: payment.id, status: 'duplicate' },
      order: { createdAt: 'ASC', id: 'ASC' },
    });
    const labels = await this.methodLabels(duplicates);

    return {
      jobId,
      paid: PaymentAttemptsService.isPaid(payment.status),
      payment: {
        id: payment.id,
        status: payment.status,
        amount: Number(payment.amount),
        currency: payment.currency,
        paidAt: payment.paidAt ? new Date(payment.paidAt).toISOString() : null,
      },
      activeAttempt: active
        ? PaymentAttemptsService.view(active, payment.jobId)
        : null,
      duplicateRefunds: duplicates
        .filter((c) => c.refundStatus)
        .map((c) => ({
          reference: c.reference,
          amount: Number(c.refundAmount ?? payment.amount),
          currency: 'GHS' as const,
          method: c.methodType,
          methodLabel: labels.get(c.id) ?? null,
          status:
            c.refundStatus === 'processing'
              ? ('pending' as const)
              : (c.refundStatus as DuplicateRefundView['status']),
          createdAt: new Date(c.createdAt).toISOString(),
        })),
    };
  }

  private activeFor(paymentId: number): Promise<PaymentCharge | null> {
    return this.charges.findOne({
      where: { paymentId, status: In([...ACTIVE_CHARGE_STATUSES]) },
      order: { createdAt: 'DESC', id: 'DESC' },
    });
  }

  /** "MTN MoMo", "Visa card ending 4081", or by channel: "card", "mobile money". */
  async methodLabels(charges: PaymentCharge[]): Promise<Map<number, string>> {
    const out = new Map<number, string>();
    const ids = charges
      .map((c) => c.paymentMethodId)
      .filter((id): id is number => typeof id === 'number');
    const methods = ids.length
      ? await this.dataSource
          .getRepository(CustomerPaymentMethod)
          .find({ where: { id: In(ids) } })
      : [];
    for (const c of charges) {
      const m = methods.find((x) => x.id === c.paymentMethodId);
      out.set(c.id, PaymentAttemptsService.labelFor(c, m ?? null));
    }
    return out;
  }

  static labelFor(
    charge: Pick<PaymentCharge, 'methodType' | 'channel'>,
    method: CustomerPaymentMethod | null,
  ): string {
    if (method?.type === 'mobile_money' && method.network) {
      return NETWORK_LABEL[method.network];
    }
    if (method?.type === 'card' && method.cardLast4) {
      const brand = normaliseCardBrand(method.cardBrand);
      const name = brand ? brand.charAt(0).toUpperCase() + brand.slice(1) : '';
      return `${name ? `${name} ` : ''}card ending ${method.cardLast4}`;
    }
    const channel =
      charge.methodType === 'hosted' ? charge.channel : charge.methodType;
    if (channel === 'mobile_money') return 'mobile money';
    if (channel === 'card') return 'card';
    return 'original payment method';
  }

  // ─── Account deletion ───────────────────────────────────────────────────────

  /**
   * Account deletion: cancels the customer's active attempts and withdraws
   * any save-card opt-in, inside the deletion request's transaction. A
   * cancelled attempt that Paystack still completes is accepted as payment
   * (money is never lost) but can never become a saved card.
   */
  static async cancelForAccountDeletion(
    manager: EntityManager,
    customerId: number,
  ): Promise<number> {
    const res = await manager.getRepository(PaymentCharge).update(
      { customerId, status: In([...ACTIVE_CHARGE_STATUSES]) },
      {
        status: 'cancelled',
        action: null,
        message: CHARGE_MESSAGES.CANCELLED,
      },
    );
    await manager
      .getRepository(Payment)
      .update(
        { customerId, saveCardRequested: true },
        { saveCardRequested: false },
      );
    return res?.affected ?? 0;
  }
}

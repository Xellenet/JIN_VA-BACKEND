import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource, In, LessThanOrEqual, Repository } from 'typeorm';
import { APP_EVENTS } from '@common/events/app.events';
import type {
  PaymentDuplicateRefundedPayload,
  PaymentRefundNeedsAttentionPayload,
} from '@common/events/app.events';
import { Job } from '@jobs/entities/job.entity';
import { Payment } from './entities/payment.entity';
import { PaymentCharge } from './entities/payment-charge.entity';
import { PaystackService } from './paystack.service';
import { PaymentAttemptsService } from './payment-attempts.service';

/** Wait before retry n (1-based) of a refund call that failed. */
export const REFUND_BACKOFF_MS = [
  60_000,
  5 * 60_000,
  30 * 60_000,
  2 * 60 * 60_000,
  6 * 60 * 60_000,
];
/** After this many failed calls the refund is left to an admin. */
export const REFUND_MAX_ATTEMPTS = 6;
/** A claimed refund call that never finished is picked up again after this. */
export const REFUND_LEASE_MS = 10 * 60_000;
/** How many due refunds one scheduler run handles. */
const REFUND_BATCH = 20;

/** Paystack's answers that mean "this transaction is already refunded". */
const ALREADY_REFUNDED =
  /already been (fully )?(refunded|reversed)|fully reversed|already refunded/i;

export type RefundRunOutcome = 'requested' | 'retry' | 'gave_up' | 'skipped';

/**
 * Automatic refund of a duplicate payment: a second successful charge for a
 * job whose money is already held by another reference.
 *
 * Idempotent by construction: the refund lives on the duplicate's own
 * attempt row (one row per Paystack reference, unique), and every step is a
 * guarded state change (`pending` → `processing` → `requested` →
 * `processed`/`failed`) made under a row lock, so a reference is never
 * refunded twice. The reference that holds the job's money
 * (`payments.paid_reference`) is never refunded here.
 *
 * A failed call is retried by the scheduler with backoff (1 min, 5 min,
 * 30 min, 2 h, 6 h), up to `REFUND_MAX_ATTEMPTS` calls; admins are told on
 * the first failure and when it gives up. The customer is told once, when
 * Paystack accepts the refund.
 */
@Injectable()
export class DuplicateRefundService {
  private readonly logger = new Logger(DuplicateRefundService.name);

  constructor(
    @InjectRepository(PaymentCharge)
    private readonly charges: Repository<PaymentCharge>,
    @InjectRepository(Payment) private readonly payments: Repository<Payment>,
    private readonly dataSource: DataSource,
    private readonly paystack: PaystackService,
    private readonly attempts: PaymentAttemptsService,
    private readonly events: EventEmitter2,
  ) {}

  /** True when `reference` is the one holding the payment's money. */
  static holdsMoney(payment: Payment, reference: string): boolean {
    if (payment.paidReference) return payment.paidReference === reference;
    return (
      PaymentAttemptsService.isPaid(payment.status) &&
      payment.reference === reference
    );
  }

  /** Makes (or retries) the refund call for one duplicate, if it is due. */
  async process(chargeId: number): Promise<RefundRunOutcome> {
    const claimed = await this.dataSource.transaction(async (manager) => {
      const repo = manager.getRepository(PaymentCharge);
      const charge = await repo.findOne({
        where: { id: chargeId },
        lock: { mode: 'pessimistic_write' },
      });
      if (
        !charge ||
        charge.status !== 'duplicate' ||
        (charge.refundStatus !== 'pending' &&
          charge.refundStatus !== 'processing') ||
        (charge.refundNextAt &&
          new Date(charge.refundNextAt).getTime() > Date.now())
      ) {
        return null;
      }
      const payment = await manager
        .getRepository(Payment)
        .findOne({ where: { id: charge.paymentId } });
      if (!payment) return null;
      if (DuplicateRefundService.holdsMoney(payment, charge.reference)) {
        // Never refund the payment that is holding the job's money.
        this.logger.error(
          `Refusing to refund ${charge.reference}: it holds payment ${payment.id}'s money.`,
        );
        await repo.update(
          { id: charge.id },
          { refundStatus: 'failed', refundNextAt: null },
        );
        return null;
      }
      const attempts = (charge.refundAttempts ?? 0) + 1;
      await repo.update(
        { id: charge.id },
        {
          refundStatus: 'processing',
          refundAttempts: attempts,
          refundNextAt: new Date(Date.now() + REFUND_LEASE_MS),
        },
      );
      return { charge: { ...charge, refundAttempts: attempts }, payment };
    });
    if (!claimed) return 'skipped';
    const { charge, payment } = claimed;

    let reply: { id: string | null; status: string | null };
    try {
      reply = await this.paystack.refund(charge.reference);
    } catch (err) {
      const text = err instanceof Error ? err.message : '';
      if (ALREADY_REFUNDED.test(text)) {
        reply = { id: charge.refundId ?? null, status: 'requested' };
      } else {
        return this.onCallFailed(charge, payment, text);
      }
    }

    const processed = reply.status === 'processed';
    const res = await this.charges.update(
      { id: charge.id, refundStatus: 'processing' },
      {
        refundStatus: processed ? 'processed' : 'requested',
        refundId: reply.id ?? charge.refundId ?? null,
        refundNextAt: null,
        ...(processed ? { refundedAt: new Date() } : {}),
      },
    );
    if ((res?.affected ?? 0) === 0) return 'skipped'; // A webhook got there first.
    this.logger.warn(
      `Duplicate payment ${charge.reference} for payment ${payment.id} (job ${payment.jobId}) refunded automatically; refund ${reply.id ?? 'unknown'}.`,
    );
    await this.notifyCustomer(charge, payment);
    return 'requested';
  }

  private async onCallFailed(
    charge: PaymentCharge,
    payment: Payment,
    text: string,
  ): Promise<RefundRunOutcome> {
    const attempts = charge.refundAttempts;
    const giveUp = attempts >= REFUND_MAX_ATTEMPTS;
    const wait =
      REFUND_BACKOFF_MS[Math.min(attempts - 1, REFUND_BACKOFF_MS.length - 1)];
    await this.charges.update(
      { id: charge.id, refundStatus: 'processing' },
      giveUp
        ? { refundStatus: 'failed', refundNextAt: null }
        : {
            refundStatus: 'pending',
            refundNextAt: new Date(Date.now() + wait),
          },
    );
    this.logger.error(
      `Refund of duplicate ${charge.reference} (payment ${payment.id}) failed, call ${attempts}/${REFUND_MAX_ATTEMPTS}` +
        (giveUp ? '; left for an admin.' : '; will retry.'),
    );
    if (attempts === 1 || giveUp) {
      await this.alertAdmins(
        charge,
        payment,
        giveUp
          ? `Paystack refused it ${attempts} times; refund it by hand. Last reply: ${text.slice(0, 160) || 'none'}`
          : `The first try failed; it will be retried automatically. Reply: ${text.slice(0, 160) || 'none'}`,
      );
    }
    return giveUp ? 'gave_up' : 'retry';
  }

  /** Scheduler: refund calls that are due (new, retried, or a lost lease). */
  async retryDue(): Promise<{ candidates: number; requested: number }> {
    const due = await this.charges.find({
      where: {
        status: 'duplicate',
        refundStatus: In(['pending', 'processing']),
        refundNextAt: LessThanOrEqual(new Date()),
      },
      select: { id: true },
      order: { refundNextAt: 'ASC' },
      take: REFUND_BATCH,
    });
    let requested = 0;
    for (const { id } of due) {
      try {
        if ((await this.process(id)) === 'requested') requested++;
      } catch (err) {
        this.logger.error(
          `Refund retry for attempt ${id} failed: ${(err as Error)?.message ?? 'Error'}`,
        );
      }
    }
    return { candidates: due.length, requested };
  }

  /**
   * Paystack `refund.pending` / `refund.processing` / `refund.processed` /
   * `refund.failed`. Only refunds of duplicate payments are tracked here
   * (admin refunds of a payment's own reference are not).
   */
  async onRefundWebhook(
    event: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    const tx = data.transaction as { reference?: unknown } | undefined;
    const reference =
      typeof data.transaction_reference === 'string'
        ? data.transaction_reference
        : typeof tx?.reference === 'string'
          ? tx.reference
          : null;
    const refundId =
      typeof data.id === 'number' || typeof data.id === 'string'
        ? String(data.id)
        : null;
    if (!reference && !refundId) return;

    const charge = await this.charges.findOne({
      where: reference
        ? { reference, status: 'duplicate' }
        : { refundId: refundId!, status: 'duplicate' },
    });
    if (!charge || !charge.refundStatus) {
      this.logger.log(`${event}: not a duplicate-payment refund; ignored.`);
      return;
    }

    if (event === 'refund.processed') {
      if (charge.refundStatus === 'processed') return;
      await this.charges.update(
        { id: charge.id },
        {
          refundStatus: 'processed',
          refundId: refundId ?? charge.refundId,
          refundNextAt: null,
          refundedAt: new Date(),
        },
      );
      return;
    }
    if (event === 'refund.failed') {
      if (charge.refundStatus === 'failed') return;
      await this.charges.update(
        { id: charge.id },
        {
          refundStatus: 'failed',
          refundId: refundId ?? charge.refundId,
          refundNextAt: null,
        },
      );
      const payment = await this.payments.findOne({
        where: { id: charge.paymentId },
      });
      if (payment) {
        await this.alertAdmins(
          charge,
          payment,
          'Paystack reported the refund failed; refund it by hand.',
        );
      }
      return;
    }
    // refund.pending / refund.processing: Paystack has it.
    if (
      charge.refundStatus === 'pending' ||
      charge.refundStatus === 'processing'
    ) {
      const res = await this.charges.update(
        { id: charge.id, refundStatus: In(['pending', 'processing']) },
        {
          refundStatus: 'requested',
          refundId: refundId ?? charge.refundId,
          refundNextAt: null,
        },
      );
      if ((res?.affected ?? 0) > 0) {
        const payment = await this.payments.findOne({
          where: { id: charge.paymentId },
        });
        if (payment) await this.notifyCustomer(charge, payment);
      }
    }
  }

  private async jobTitle(payment: Payment): Promise<string> {
    const job = await this.dataSource.getRepository(Job).findOne({
      where: { id: payment.jobId },
      select: { id: true, title: true },
    });
    return job?.title ?? `Job #${payment.jobId}`;
  }

  private async notifyCustomer(charge: PaymentCharge, payment: Payment) {
    try {
      const labels = await this.attempts.methodLabels([charge]);
      this.events.emit(APP_EVENTS.PAYMENT_DUPLICATE_REFUNDED, {
        customerId: payment.customerId,
        jobId: payment.jobId,
        jobTitle: await this.jobTitle(payment),
        amount: Number(charge.refundAmount ?? payment.amount),
        methodLabel: labels.get(charge.id) ?? 'original payment method',
      } satisfies PaymentDuplicateRefundedPayload);
    } catch (err) {
      this.logger.error(
        `Could not notify the customer of refund ${charge.reference}: ${(err as Error)?.name ?? 'Error'}`,
      );
    }
  }

  private async alertAdmins(
    charge: PaymentCharge,
    payment: Payment,
    reason: string,
  ) {
    try {
      this.events.emit(APP_EVENTS.PAYMENT_REFUND_NEEDS_ATTENTION, {
        paymentId: payment.id,
        jobId: payment.jobId,
        jobTitle: await this.jobTitle(payment),
        amount: Number(charge.refundAmount ?? payment.amount),
        reference: charge.reference,
        reason,
      } satisfies PaymentRefundNeedsAttentionPayload);
    } catch (err) {
      this.logger.error(
        `Could not alert admins about refund ${charge.reference}: ${(err as Error)?.name ?? 'Error'}`,
      );
    }
  }
}

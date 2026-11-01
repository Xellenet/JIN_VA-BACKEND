import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import { randomBytes } from 'crypto';
import { PaymentStatus } from '@common/types/enums';
import { User } from '@users/entities/user.entity';
import { Payment } from './entities/payment.entity';
import { PaymentCharge } from './entities/payment-charge.entity';
import { PaystackService } from './paystack.service';
import type { PaystackChargeReply } from './paystack.service';
import { PaymentsService } from './payments.service';
import { PaymentMethodsService } from '../payment-methods/payment-methods.service';
import { CHARGE_PROVIDER } from '../payment-methods/payment-methods.constants';
import {
  CHARGE_MESSAGES,
  mapChargeReply,
  type ChargeAction,
  type ChargeApiStatus,
} from './charge-outcome';

/** A charge waiting longer than this no longer blocks a new attempt. */
export const CHARGE_ACTIVE_WINDOW_MS = 10 * 60_000;
/** A pending charge is checked with Paystack at most this often. */
export const CHARGE_VERIFY_INTERVAL_MS = 15_000;

export const JOB_ALREADY_PAID = 'This job is already paid.';
export const NO_PENDING_PAYMENT =
  'No payment is due for this job yet. Has the artisan accepted?';
export const CARD_EXPIRED =
  'This card has expired. Pay another way, or remove it from your saved methods.';
export const CHARGE_NOT_FOUND = 'Payment attempt not found.';
export const NOT_WAITING_FOR_OTP = "This payment isn't waiting for a code.";

/** What `POST /payments/:jobId/charge`, the OTP and the status endpoints return. */
export interface ChargeResult {
  reference: string;
  jobId: number;
  method: 'mobile_money' | 'card';
  status: ChargeApiStatus;
  action: ChargeAction | null;
  message: string | null;
}

const ACTIVE = ['pending', 'needs_otp'] as const;

/**
 * Paying a job with a saved method: a direct Paystack charge with its own
 * reference per attempt. The money state machine is the hosted checkout's:
 * the payment row stays PENDING until `charge.success` (or a verify) moves
 * it to HELD through `PaymentsService.applySavedChargeSuccess`.
 *
 * The phone number, authorization code and OTP are only ever passed to
 * Paystack; none is logged or returned.
 */
@Injectable()
export class SavedMethodChargeService {
  private readonly logger = new Logger(SavedMethodChargeService.name);

  constructor(
    @InjectRepository(Payment) private readonly payments: Repository<Payment>,
    @InjectRepository(PaymentCharge)
    private readonly charges: Repository<PaymentCharge>,
    @InjectRepository(User) private readonly users: Repository<User>,
    private readonly dataSource: DataSource,
    private readonly paystack: PaystackService,
    private readonly methods: PaymentMethodsService,
    private readonly paymentsService: PaymentsService,
  ) {}

  static toResult(charge: PaymentCharge, jobId: number): ChargeResult {
    if (charge.status === 'duplicate') {
      return {
        reference: charge.reference,
        jobId,
        method: charge.methodType,
        status: 'succeeded',
        action: null,
        message: CHARGE_MESSAGES.DUPLICATE,
      };
    }
    return {
      reference: charge.reference,
      jobId,
      method: charge.methodType,
      status: charge.status,
      action: (charge.action as ChargeAction | null) ?? null,
      message: charge.message ?? null,
    };
  }

  private static newReference(paymentId: number): string {
    return `jinva-ch-${paymentId}-${Date.now()}-${randomBytes(3).toString('hex')}`;
  }

  /**
   * Starts a charge for the job's pending payment with one of the caller's
   * saved methods. While an attempt is still active (pending or waiting for
   * an OTP, within `CHARGE_ACTIVE_WINDOW_MS`), the same attempt is returned
   * instead of charging again.
   */
  async charge(
    customerId: number,
    jobId: number,
    paymentMethodId: number,
  ): Promise<ChargeResult> {
    // Ownership (404) and the encryption check (503) before anything else.
    const method = await this.methods.getChargeable(
      customerId,
      paymentMethodId,
    );
    if (method.type === 'card' && method.expired) {
      throw new UnprocessableEntityException(CARD_EXPIRED);
    }

    const started = await this.dataSource.transaction(async (manager) => {
      const payment = await manager.getRepository(Payment).findOne({
        where: { jobId, customerId, status: PaymentStatus.PENDING },
        lock: { mode: 'pessimistic_write' },
      });
      if (!payment) {
        const any = await manager
          .getRepository(Payment)
          .findOne({ where: { jobId, customerId }, select: { id: true } });
        if (any) throw new ConflictException(JOB_ALREADY_PAID);
        throw new NotFoundException(NO_PENDING_PAYMENT);
      }
      const repo = manager.getRepository(PaymentCharge);
      const active = await repo.findOne({
        where: { paymentId: payment.id, status: In([...ACTIVE]) },
        order: { createdAt: 'DESC', id: 'DESC' },
      });
      if (
        active &&
        Date.now() - new Date(active.createdAt).getTime() <
          CHARGE_ACTIVE_WINDOW_MS
      ) {
        return { payment, charge: active, existing: true };
      }
      const charge = await repo.save(
        repo.create({
          paymentId: payment.id,
          customerId,
          reference: SavedMethodChargeService.newReference(payment.id),
          methodType: method.type,
          paymentMethodId: method.id,
          status: 'pending',
          action: 'wait',
          message: CHARGE_MESSAGES.CONFIRMING,
          lastVerifiedAt: null,
        }),
      );
      return { payment, charge, existing: false };
    });

    if (started.existing) {
      return SavedMethodChargeService.toResult(started.charge, jobId);
    }

    const { payment, charge } = started;
    const customer = await this.users.findOne({
      where: { id: customerId },
      select: { id: true, email: true },
    });
    const metadata = {
      jobId,
      customerId,
      paymentId: payment.id,
      chargeId: charge.id,
      saved_method: true,
    };
    let reply: PaystackChargeReply;
    try {
      reply =
        method.type === 'mobile_money'
          ? await this.paystack.chargeMobileMoney({
              email: customer?.email ?? '',
              amountGhs: Number(payment.amount),
              reference: charge.reference,
              phone: method.phone,
              provider: CHARGE_PROVIDER[method.network],
              metadata,
            })
          : await this.paystack.chargeAuthorization({
              email: customer?.email ?? '',
              amountGhs: Number(payment.amount),
              reference: charge.reference,
              authorizationCode: method.authorizationCode,
              metadata,
            });
    } catch {
      reply = { outcome: 'unreachable' };
    }

    return this.applyReply(charge, jobId, reply, false);
  }

  /** Saves what a Paystack reply means, unless the webhook already settled it. */
  private async applyReply(
    charge: PaymentCharge,
    jobId: number,
    reply: PaystackChargeReply,
    otpStep: boolean,
  ): Promise<ChargeResult> {
    const outcome = mapChargeReply(reply, charge.methodType, { otpStep });
    const current = await this.charges.findOne({ where: { id: charge.id } });
    if (
      current &&
      !ACTIVE.includes(current.status as (typeof ACTIVE)[number])
    ) {
      // The webhook landed first; it wins.
      return SavedMethodChargeService.toResult(current, jobId);
    }
    await this.charges.update(
      { id: charge.id },
      {
        status: outcome.status,
        action: outcome.action,
        message: outcome.message,
      },
    );
    this.logger.log(
      `Saved-method charge ${charge.reference}: ${outcome.status}${
        outcome.action ? ` (${outcome.action})` : ''
      }`,
    );
    return SavedMethodChargeService.toResult(
      { ...charge, ...outcome } as PaymentCharge,
      jobId,
    );
  }

  private async ownedCharge(
    customerId: number,
    reference: string,
  ): Promise<{ charge: PaymentCharge; jobId: number }> {
    const charge = await this.charges.findOne({ where: { reference } });
    if (!charge || charge.customerId !== customerId) {
      throw new NotFoundException(CHARGE_NOT_FOUND);
    }
    const payment = await this.payments.findOne({
      where: { id: charge.paymentId },
      select: { id: true, jobId: true },
    });
    return { charge, jobId: payment?.jobId ?? 0 };
  }

  /** Sends the network's one-time code (Telecel) for a charge that asked for one. */
  async submitOtp(
    customerId: number,
    reference: string,
    otp: string,
  ): Promise<ChargeResult> {
    const { charge, jobId } = await this.ownedCharge(customerId, reference);
    if (charge.status !== 'needs_otp') {
      throw new ConflictException(NOT_WAITING_FOR_OTP);
    }
    let reply: PaystackChargeReply;
    try {
      reply = await this.paystack.submitChargeOtp(reference, otp);
    } catch {
      reply = { outcome: 'unreachable' };
    }
    return this.applyReply(charge, jobId, reply, true);
  }

  /**
   * The charge's state from our row (the webhook is the source of truth).
   * While it is still active, Paystack is asked at most once every
   * `CHARGE_VERIFY_INTERVAL_MS`; a success found that way goes through the
   * same HELD path as the webhook. An attempt older than the active window
   * that Paystack hasn't confirmed is reported as not approved.
   */
  async status(customerId: number, reference: string): Promise<ChargeResult> {
    const { charge, jobId } = await this.ownedCharge(customerId, reference);
    if (!ACTIVE.includes(charge.status as (typeof ACTIVE)[number])) {
      return SavedMethodChargeService.toResult(charge, jobId);
    }

    const now = Date.now();
    const lastCheck = new Date(
      charge.lastVerifiedAt ?? charge.createdAt,
    ).getTime();
    const age = now - new Date(charge.createdAt).getTime();
    if (now - lastCheck < CHARGE_VERIFY_INTERVAL_MS) {
      return SavedMethodChargeService.toResult(charge, jobId);
    }

    await this.charges.update(
      { id: charge.id },
      { lastVerifiedAt: new Date(now) },
    );
    let remote: Awaited<
      ReturnType<PaystackService['verifyTransaction']>
    > | null = null;
    try {
      remote = await this.paystack.verifyTransaction(reference);
    } catch {
      remote = null; // Unknown to Paystack yet, or unreachable: keep waiting.
    }

    if (remote?.status === 'success') {
      await this.paymentsService.applySavedChargeSuccess(charge.id, {
        reference,
        amount: remote.amount,
        currency: remote.currency,
        channel: remote.channel,
        paid_at: remote.paid_at,
      });
    } else if (
      remote &&
      ['failed', 'abandoned', 'reversed'].includes(remote.status)
    ) {
      await this.markFailedIfActive(charge.id, CHARGE_MESSAGES.FAILED);
    } else if (age >= CHARGE_ACTIVE_WINDOW_MS) {
      await this.markFailedIfActive(charge.id, CHARGE_MESSAGES.NOT_APPROVED);
    }

    const fresh = await this.charges.findOne({ where: { id: charge.id } });
    return SavedMethodChargeService.toResult(fresh ?? charge, jobId);
  }

  private async markFailedIfActive(id: number, message: string) {
    await this.charges.update(
      { id, status: In([...ACTIVE]) },
      { status: 'failed', action: null, message },
    );
  }
}

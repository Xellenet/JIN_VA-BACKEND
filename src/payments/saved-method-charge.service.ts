import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { User } from '@users/entities/user.entity';
import { Payment } from './entities/payment.entity';
import {
  ACTIVE_CHARGE_STATUSES,
  isActiveCharge,
  PaymentCharge,
} from './entities/payment-charge.entity';
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
import {
  ATTEMPT_VERIFY_INTERVAL_MS,
  ATTEMPT_WINDOW_MS,
  JOB_ALREADY_PAID,
  PaymentAttemptsService,
  type SettleCharge,
} from './payment-attempts.service';

/** A saved-method charge holds the job this long before it may be released. */
export const CHARGE_ACTIVE_WINDOW_MS = ATTEMPT_WINDOW_MS.mobile_money;
/** A pending charge is checked with Paystack at most this often. */
export const CHARGE_VERIFY_INTERVAL_MS = ATTEMPT_VERIFY_INTERVAL_MS;

export { JOB_ALREADY_PAID };
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
  method: 'mobile_money' | 'card' | 'hosted';
  status: ChargeApiStatus;
  action: ChargeAction | null;
  message: string | null;
}

/**
 * Paying a job with a saved method: a direct Paystack charge with its own
 * reference per attempt. The attempt is claimed through
 * {@link PaymentAttemptsService} (one active attempt per job), and the money
 * state machine is the hosted checkout's: the payment row stays PENDING
 * until `charge.success` (or a verify) moves it to HELD through
 * `PaymentsService.applyChargeSuccess`.
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
    private readonly paystack: PaystackService,
    private readonly methods: PaymentMethodsService,
    private readonly paymentsService: PaymentsService,
    private readonly attempts: PaymentAttemptsService,
  ) {}

  private readonly settle: SettleCharge = (chargeId, data) =>
    this.paymentsService.applyChargeSuccess(chargeId, data);

  static toResult(charge: PaymentCharge, jobId: number): ChargeResult {
    const base = {
      reference: charge.reference,
      jobId,
      method: charge.methodType,
    };
    switch (charge.status) {
      case 'duplicate':
        return {
          ...base,
          status: 'succeeded',
          action: null,
          message: CHARGE_MESSAGES.DUPLICATE,
        };
      case 'expired':
      case 'cancelled':
        return {
          ...base,
          status: 'failed',
          action: null,
          message: charge.message ?? CHARGE_MESSAGES.NOT_APPROVED,
        };
      case 'hosted_open':
        return { ...base, status: 'pending', action: null, message: null };
      default:
        return {
          ...base,
          status: charge.status,
          action: (charge.action as ChargeAction | null) ?? null,
          message: charge.message ?? null,
        };
    }
  }

  /**
   * Starts a charge for the job's pending payment with one of the caller's
   * saved methods. While an attempt with this method is active, the same
   * attempt is returned instead of charging again; an attempt of another
   * kind is 409 `PAYMENT_ATTEMPT_ACTIVE`; a paid job is 409 `ALREADY_PAID`.
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

    const claim = await this.attempts.claim(
      customerId,
      jobId,
      { kind: method.type, paymentMethodId: method.id },
      this.settle,
      NO_PENDING_PAYMENT,
    );
    if (claim.outcome === 'existing') {
      return SavedMethodChargeService.toResult(claim.charge, jobId);
    }

    const { payment, charge } = claim;
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
    const method = charge.methodType === 'card' ? 'card' : 'mobile_money';
    const outcome = mapChargeReply(reply, method, { otpStep });
    // Only while still active: the webhook (or a release) wins.
    const res = await this.charges.update(
      { id: charge.id, status: In([...ACTIVE_CHARGE_STATUSES]) },
      {
        status: outcome.status,
        action: outcome.action,
        message: outcome.message,
      },
    );
    if ((res?.affected ?? 0) === 0) {
      const current = await this.charges.findOne({ where: { id: charge.id } });
      return SavedMethodChargeService.toResult(current ?? charge, jobId);
    }
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
  ): Promise<{
    charge: PaymentCharge;
    payment: Payment | null;
    jobId: number;
  }> {
    const charge = await this.charges.findOne({ where: { reference } });
    if (!charge || charge.customerId !== customerId) {
      throw new NotFoundException(CHARGE_NOT_FOUND);
    }
    const payment = await this.payments.findOne({
      where: { id: charge.paymentId },
    });
    return { charge, payment, jobId: payment?.jobId ?? 0 };
  }

  /** Sends the network's one-time code (Telecel) for a charge that asked for one. */
  async submitOtp(
    customerId: number,
    reference: string,
    otp: string,
  ): Promise<ChargeResult> {
    const { charge, payment, jobId } = await this.ownedCharge(
      customerId,
      reference,
    );
    // Paid is final, on every payment endpoint.
    if (payment && PaymentAttemptsService.isPaid(payment.status)) {
      throw PaymentAttemptsService.alreadyPaid(payment);
    }
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
   * `CHARGE_VERIFY_INTERVAL_MS`: a success goes through the same HELD path
   * as the webhook; a failure, or no success once the attempt is past its
   * window, releases it. Without an answer from Paystack it stays active.
   */
  async status(customerId: number, reference: string): Promise<ChargeResult> {
    const { charge, jobId } = await this.ownedCharge(customerId, reference);
    if (!isActiveCharge(charge.status)) {
      return SavedMethodChargeService.toResult(charge, jobId);
    }
    const outcome = await this.attempts.reconcile(charge, this.settle);
    if (outcome === 'active') {
      return SavedMethodChargeService.toResult(charge, jobId);
    }
    const fresh = await this.charges.findOne({ where: { id: charge.id } });
    return SavedMethodChargeService.toResult(fresh ?? charge, jobId);
  }
}

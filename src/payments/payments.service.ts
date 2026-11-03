import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  DataSource,
  EntityManager,
  In,
  LessThanOrEqual,
  Repository,
} from 'typeorm';
import { Payment } from './entities/payment.entity';
import { PaymentCharge } from './entities/payment-charge.entity';
import { CHARGE_MESSAGES } from './charge-outcome';
import { PaymentAttemptsService } from './payment-attempts.service';
import { DuplicateRefundService } from './duplicate-refund.service';
import {
  PaymentMethodsService,
  type PaystackAuthorization,
} from '../payment-methods/payment-methods.service';
import {
  maskForLog,
  PaystackService,
  type ResolveAccountResult,
} from './paystack.service';
import { Job } from '@jobs/entities/job.entity';
import { User } from '@users/entities/user.entity';
import { ArtisanProfile } from '@users/entities/artisan-profile.entity';
import {
  AdminActionTarget,
  AdminActionType,
  PaymentStatus,
  PayoutType,
} from '@common/types/enums';
import { AdminAuditService } from '../admin-audit/admin-audit.service';
import { CustomerPaymentSettings } from '../payment-settings/entities/customer-payment-settings.entity';
import { orderCheckoutChannels } from '../payment-settings/checkout-channels';
import { APP_EVENTS } from '@common/events/app.events';
import {
  ACCOUNT_NAME_NOT_FOUND,
  ACCOUNT_NAME_REQUIRED,
} from './payout-account';
import { payoutNamesMatch } from './payout-name-match';
import {
  ARTISAN_ACTION_HOLDS,
  needsArtisanAction,
  type PayoutHoldReason,
  nextPayoutCheckAt,
  PAYOUT_ACCOUNT_NOT_FOUND,
  PAYOUT_ACCOUNT_NOT_FOUND_MESSAGE,
  PAYOUT_CHECK_MAX_ATTEMPTS,
  PAYOUT_CHECK_PENDING,
  PAYOUT_CHECK_PENDING_MESSAGE,
  PAYOUT_NAME_MISMATCH,
  PAYOUT_NAME_MISMATCH_MESSAGE,
} from './payout-hold';
import type {
  PaymentReceiptPayload,
  PaymentSecuredPayload,
  PayoutReleasedPayload,
  PaymentRefundedPayload,
  PaymentTransferFailedPayload,
  PayoutOnHoldPayload,
} from '@common/events/app.events';

/** `POST /payments/initialize` when the job has no payment due. */
export const NO_PENDING_HOSTED_PAYMENT =
  'No pending payment found for this job. Has the artisan accepted yet?';

/** security-report.md finding #8: hard upper bound on admin list `limit`. */
const MAX_ADMIN_PAGE_LIMIT = 100;

/** Payout name check: how many due checks the scheduler retries per run. */
const PAYOUT_CHECK_BATCH = 50;
/** How many held payouts are retried when the artisan saves new details. */
const HELD_PAYOUT_RETRY_LIMIT = 20;

/**
 * The outcome of a payout name check, with the payout details it checked
 * (compared again under the lock). Never logged: it carries the full number.
 */
interface PayoutNameCheck {
  outcome: 'match' | 'mismatch' | 'not_found' | 'unavailable';
  /** Paystack's name for the account, when it named one. */
  resolvedName?: string;
  recipientCode: string | null;
  accountNumber: string | null;
  bankCode: string | null;
}

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  /**
   * security-report.md finding #9: read and range-validated once at startup
   * (fail fast on a misconfigured value) instead of re-read-and-trusted on
   * every `holdPayment` call.
   */
  private readonly platformFeePercent: number;

  constructor(
    @InjectRepository(Payment)
    private readonly repo: Repository<Payment>,
    @InjectRepository(Job)
    private readonly jobRepo: Repository<Job>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    @InjectRepository(ArtisanProfile)
    private readonly profileRepo: Repository<ArtisanProfile>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly paystack: PaystackService,
    private readonly config: ConfigService,
    /**
     * PD1–PD3: this module emitted nothing at all before this round, so the
     * customer `paymentReceipts` and artisan `paymentReleased` preference
     * toggles had no trigger behind them.
     */
    private readonly eventEmitter: EventEmitter2,
    /** AT5: audit rows for admin refunds and fraud flags. */
    private readonly auditService: AdminAuditService,
    /** Saved payment methods: direct charge attempts, each with its own reference. */
    @InjectRepository(PaymentCharge)
    private readonly chargeRepo: Repository<PaymentCharge>,
    /** Saved payment methods: saving the card from an opted-in hosted charge. */
    private readonly paymentMethods: PaymentMethodsService,
    /** Idempotent payments: one active attempt per job. */
    private readonly attempts: PaymentAttemptsService,
    /** Idempotent payments: automatic refund of a duplicate payment. */
    private readonly refunds: DuplicateRefundService,
  ) {
    // ConfigService.get() always returns environment variables as strings
    // (process.env is never coerced), whether the value comes from a .env
    // file, a shell export, or a container's env block — `<number>` here is
    // only a type hint, not a runtime cast. Coerce explicitly before
    // validating the range (qa-report.md BLOCKER-4: the old `typeof
    // feePercent !== 'number'` check was true for every real-world way to
    // set this variable, including a perfectly valid "5", and crashed the
    // whole Nest bootstrap).
    const raw = this.config.get<string | number>('PLATFORM_FEE_PERCENT', 5);
    const feePercent = Number(raw);
    if (Number.isNaN(feePercent) || feePercent < 0 || feePercent > 100) {
      throw new Error(
        `PLATFORM_FEE_PERCENT must be a number between 0 and 100 (got ${String(raw)}).`,
      );
    }
    this.platformFeePercent = feePercent;
  }

  /**
   * AT9: the platform fee percentage this service **actually applies** in
   * `holdPayment`, exposed so the admin Settings screen can stop displaying a
   * number that disagrees with production (it showed a hardcoded 15 against a
   * backend default of 5).
   *
   * Read-only on purpose: making the fee runtime-configurable has retroactive
   * -pricing consequences for in-flight jobs and is deliberately out of scope
   * (Open Question 11, resolved) — this only makes the displayed value true.
   */
  getPlatformFeePercent(): number {
    return this.platformFeePercent;
  }

  // ─── Notification emitters (PD1–PD3, PR3) ───────────────────────────────────
  //
  // Every emitter below is best-effort: a notification failure must never
  // roll back or fail a money movement that already succeeded, so each one
  // resolves its own context and swallows/logs its errors. They are always
  // called *after* the owning DB transaction has committed, never inside it.

  /**
   * Resolves the human-readable context a payment notification needs (job
   * title, the artisan's user id and display name) from a Payment row.
   * Returns `null` if the artisan side can't be resolved, which callers treat
   * as "skip the artisan-facing notification" rather than an error.
   */
  private async resolvePaymentContext(payment: Payment): Promise<{
    jobTitle: string;
    artisanUserId: number | null;
    artisanName: string;
  }> {
    const [job, profile] = await Promise.all([
      this.jobRepo.findOne({ where: { id: payment.jobId } }),
      this.profileRepo.findOne({
        where: { id: payment.artisanProfileId },
        relations: ['user'],
      }),
    ]);
    const user = profile?.user;
    return {
      jobTitle: job?.title ?? `Job #${payment.jobId}`,
      artisanUserId: user?.id ?? null,
      artisanName: user ? `${user.firstname} ${user.lastname}` : 'the artisan',
    };
  }

  /**
   * PD1 + PD2: a payment reaching HELD is a single state transition that owes
   * *two different* notifications — a receipt to the customer ("we got your
   * money") and a payment-secured notice to the artisan ("money is set aside
   * for this job"). Deliberately two events rather than one with two
   * recipients: the copy differs and each side is gated by its own role's
   * preference toggle.
   *
   * Callers must only invoke this on a genuine transition into HELD, so a
   * replayed `charge.success` webhook cannot double-notify.
   */
  private async emitPaymentHeld(payment: Payment): Promise<void> {
    try {
      const ctx = await this.resolvePaymentContext(payment);

      this.eventEmitter.emit(APP_EVENTS.PAYMENT_RECEIPT, {
        customerId: payment.customerId,
        jobId: payment.jobId,
        jobTitle: ctx.jobTitle,
        amount: Number(payment.amount),
        reference: payment.reference,
      } as PaymentReceiptPayload);

      if (ctx.artisanUserId) {
        this.eventEmitter.emit(APP_EVENTS.PAYMENT_SECURED, {
          artisanUserId: ctx.artisanUserId,
          jobId: payment.jobId,
          jobTitle: ctx.jobTitle,
          artisanAmount: Number(payment.artisanAmount),
        } as PaymentSecuredPayload);
      } else {
        this.logger.warn(
          `PAYMENT_SECURED not emitted for payment ${payment.id}: artisan profile ${payment.artisanProfileId} has no user.`,
        );
      }
    } catch (err) {
      this.logger.error(
        `Failed to emit payment-held notifications for payment ${payment.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** PD2: the payout actually left the platform (Paystack transfer.success). */
  private async emitPayoutReleased(payment: Payment): Promise<void> {
    try {
      const ctx = await this.resolvePaymentContext(payment);
      if (!ctx.artisanUserId) {
        this.logger.warn(
          `PAYOUT_RELEASED not emitted for payment ${payment.id}: artisan profile ${payment.artisanProfileId} has no user.`,
        );
        return;
      }
      this.eventEmitter.emit(APP_EVENTS.PAYOUT_RELEASED, {
        artisanUserId: ctx.artisanUserId,
        jobId: payment.jobId,
        jobTitle: ctx.jobTitle,
        artisanAmount: Number(payment.artisanAmount),
      } as PayoutReleasedPayload);
    } catch (err) {
      this.logger.error(
        `Failed to emit PAYOUT_RELEASED for payment ${payment.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** PD3: an admin refunded (part of) a payment. */
  private async emitPaymentRefunded(
    payment: Payment,
    refundedNow: number,
    fullyRefunded: boolean,
  ): Promise<void> {
    try {
      const ctx = await this.resolvePaymentContext(payment);
      this.eventEmitter.emit(APP_EVENTS.PAYMENT_REFUNDED, {
        customerId: payment.customerId,
        jobId: payment.jobId,
        jobTitle: ctx.jobTitle,
        refundedAmount: refundedNow,
        fullyRefunded,
      } as PaymentRefundedPayload);
    } catch (err) {
      this.logger.error(
        `Failed to emit PAYMENT_REFUNDED for payment ${payment.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * PR3: a failed payout is an *admin* problem, not something to tell the
   * artisan they can fix — it needs manual attention (stale recipient, bank
   * rejection). Routed to admins only.
   */
  private async emitTransferFailed(
    payment: Payment,
    reason: string,
  ): Promise<void> {
    try {
      const ctx = await this.resolvePaymentContext(payment);
      this.eventEmitter.emit(APP_EVENTS.PAYMENT_TRANSFER_FAILED, {
        paymentId: payment.id,
        jobId: payment.jobId,
        jobTitle: ctx.jobTitle,
        artisanName: ctx.artisanName,
        artisanAmount: Number(payment.artisanAmount),
        reason,
      } as PaymentTransferFailedPayload);
    } catch (err) {
      this.logger.error(
        `Failed to emit PAYMENT_TRANSFER_FAILED for payment ${payment.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Payout name check: tells the artisan their payout is on hold and what to
   * fix. Best-effort and after commit, like the other emitters.
   */
  private async emitPayoutOnHold(
    payment: Payment,
    reason: PayoutOnHoldPayload['reason'],
  ): Promise<void> {
    try {
      const ctx = await this.resolvePaymentContext(payment);
      if (ctx.artisanUserId === null) return;
      this.eventEmitter.emit(APP_EVENTS.PAYOUT_ON_HOLD, {
        artisanUserId: ctx.artisanUserId,
        paymentId: payment.id,
        jobId: payment.jobId,
        jobTitle: ctx.jobTitle,
        reason,
      } as PayoutOnHoldPayload);
    } catch (err) {
      this.logger.error(
        `Failed to emit PAYOUT_ON_HOLD for payment ${payment.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // ─── Called internally by JobsService ────────────────────────────────────────

  /**
   * Creates a PENDING payment record when an artisan accepts a job.
   * The customer then calls POST /payments/initialize to get the Paystack payment URL.
   *
   * `acceptedArtisanId` is passed explicitly by the caller (rather than read
   * off `job.acceptedArtisanId`) because `JobsService.acceptApplication`
   * calls this *before* the job's `acceptedArtisan` relation is saved — see
   * qa-report.md BLOCKER-1. Re-deriving it from a fresh DB read of the job
   * would always see the pre-acceptance state and always fail.
   *
   * QA JOB-22: `BookingsService.confirm` passes its transaction's `manager`,
   * so a booking's job and its payment are created together or not at all.
   */
  async holdPayment(
    jobId: number,
    customerId: number,
    acceptedArtisanId: number,
    amount?: number,
    manager?: EntityManager,
  ): Promise<string> {
    const jobRepo = manager?.getRepository(Job) ?? this.jobRepo;
    const profileRepo =
      manager?.getRepository(ArtisanProfile) ?? this.profileRepo;
    const paymentRepo = manager?.getRepository(Payment) ?? this.repo;
    const job = await jobRepo.findOne({ where: { id: jobId } });
    if (!job) throw new NotFoundException('Job not found.');

    if (!acceptedArtisanId) {
      throw new BadRequestException('Job has no accepted artisan yet.');
    }

    // Belt-and-suspenders: CreateJobDto/UpdateJobDto already reject non-GHS
    // currency at the API boundary, but holdPayment is the last line of
    // defense before a real Paystack charge is created — the entire Paystack
    // integration hardcodes GHS pesewas math, so a mismatched currency here
    // would silently charge the customer the numeric amount in the wrong
    // currency. Refuse rather than proceed if this ever slips through.
    if (job.currency !== 'GHS') {
      throw new BadRequestException(
        `Cannot hold payment: job currency is ${job.currency}, not GHS.`,
      );
    }

    const profile = await profileRepo.findOne({
      where: { user: { id: acceptedArtisanId } },
    });
    if (!profile)
      throw new NotFoundException('Artisan profile not found for this job.');

    const agreedAmount = +(amount ?? job.budgetMax ?? 0);
    // QA JOB-08: never create a payment nobody can pay. Runs before the
    // accept flow changes anything, so the application stays acceptable once
    // the artisan sends a real quote.
    if (!(agreedAmount > 0)) {
      throw new BadRequestException(
        'This application has no price yet. Ask the artisan to send a quote before accepting.',
      );
    }
    const platformFee = +(
      (agreedAmount * this.platformFeePercent) /
      100
    ).toFixed(2);
    const artisanAmt = +(agreedAmount - platformFee).toFixed(2);

    const reference = `jinva-${jobId}-${customerId}-${Date.now()}`;

    await paymentRepo.save(
      paymentRepo.create({
        jobId,
        customerId,
        artisanProfileId: profile.id,
        amount: agreedAmount,
        platformFee,
        artisanAmount: artisanAmt,
        currency: job.currency,
        status: PaymentStatus.PENDING,
        reference,
      }),
    );

    return reference;
  }

  /**
   * Payout name check, made **before** the capture's transaction so a slow
   * Paystack lookup never holds the payment row lock. Never throws: a lookup
   * that errors counts as unavailable. The account details it checked are
   * kept, so the transaction can tell if they changed in the meantime.
   */
  private async checkPayoutName(
    profile: ArtisanProfile,
  ): Promise<PayoutNameCheck> {
    const checked = {
      recipientCode: profile.paystackRecipientCode ?? null,
      accountNumber: profile.payoutAccountNumber ?? null,
      bankCode: profile.payoutBankCode ?? null,
    };
    // A recipient with no number or bank on file can't be checked against
    // anything: the artisan has to set their details again.
    if (!checked.accountNumber || !checked.bankCode) {
      return { ...checked, outcome: 'not_found' };
    }
    let result: ResolveAccountResult;
    try {
      result = await this.paystack.resolveAccount(
        checked.accountNumber,
        checked.bankCode,
      );
    } catch {
      result = { status: 'unavailable' };
    }
    if (result.status === 'unavailable') {
      return { ...checked, outcome: 'unavailable' };
    }
    if (result.status === 'unresolvable') {
      return { ...checked, outcome: 'not_found' };
    }
    return {
      ...checked,
      outcome: payoutNamesMatch(profile.payoutAccountName, result.accountName)
        ? 'match'
        : 'mismatch',
      resolvedName: result.accountName,
    };
  }

  /**
   * Initiates the Paystack transfer to the artisan. Every transfer attempt
   * goes through here: the client confirming completion and the 48 h
   * auto-complete (both via JobsService), the artisan's retry
   * ({@link retryPendingTransfer}), an admin/dispute release
   * ({@link releaseWithheldPayment}), the scheduler's retry of a pending name
   * check ({@link retryDuePayoutChecks}) and the retry after the artisan
   * fixes their payout details ({@link setupPayoutMethod}).
   *
   * Payout name check: before any transfer, the payout account is looked up
   * again with Paystack and its name compared with the saved one
   * ({@link payoutNamesMatch}). The lookup runs before the transaction; the
   * payment's state is then re-checked under the lock as before.
   * - match → transfer (an unverified or legacy method becomes verified, with
   *   Paystack's spelling of the name);
   * - name differs, or the account can't be found → no transfer: the payment
   *   is parked at PENDING_TRANSFER with a hold reason, the payout method is
   *   marked not verified and the artisan is told once;
   * - lookup unavailable → no transfer, PENDING_TRANSFER with
   *   `payout_check_pending`, retried by the scheduler with backoff; the
   *   artisan is not blamed or notified.
   *
   * security-report.md finding #3: wrapped in a transaction that takes a
   * `pessimistic_write` lock on the Payment row before reading its status,
   * so two near-simultaneous callers (double-click on "Retry Payout", a
   * flaky-network client auto-retry, or a scripted call) serialize instead
   * of interleaving and both firing a live Paystack transfer. The second
   * caller, once unblocked, re-reads the row as the first caller left it —
   * see the `alreadyCaptured` check below for why that alone isn't quite
   * enough and what closes the remaining gap.
   *
   * The Paystack transfer call is deliberately made *inside* this
   * transaction/lock (not after commit) specifically so a concurrent caller
   * cannot start a second attempt while the first is in flight. If the
   * transfer call itself throws, we still want the TRANSFER_FAILED status
   * write to persist, so the error is captured and re-thrown *after* the
   * transaction block resolves rather than thrown from inside it (which
   * would roll the status change back too).
   */
  async capturePayment(reference: string, jobId: number): Promise<void> {
    let captureError: Error | undefined;
    /**
     * PR3: set only when the transfer *initiation* itself failed, so the
     * admin-facing TRANSFER_FAILED notification is emitted after the
     * transaction commits (never from inside it — an emit that ran and then
     * got rolled back would notify about a state change that never persisted).
     */
    let failedPayment: Payment | undefined;
    /** Set when a hold needs the artisan told (first time for this payment). */
    let heldForArtisan:
      | { payment: Payment; reason: PayoutOnHoldPayload['reason'] }
      | undefined;
    /** Set when the scheduler has given up on a pending check. */
    let checkGaveUp: Payment | undefined;

    const check = await this.precheckPayoutName(reference);

    await this.dataSource.transaction(async (manager) => {
      const paymentRepo = manager.getRepository(Payment);
      const payment = await paymentRepo.findOne({
        where: { reference },
        lock: { mode: 'pessimistic_write' },
      });
      if (!payment) {
        this.logger.warn(`capturePayment: no payment for ref=${reference}`);
        return;
      }

      // HELD is reached two different ways: (1) fresh, right after
      // charge.success — no transfer attempted yet; (2) right after *this
      // method* already successfully called Paystack for this payment,
      // where it deliberately stays HELD (rather than flipping to a
      // terminal state) until the transfer.success webhook confirms
      // RELEASED. A payment already carrying a transferCode has already had
      // a transfer initiated for it — treat a second call as a no-op rather
      // than firing another live transfer while the first is still in
      // flight/awaiting webhook confirmation.
      if (payment.status === PaymentStatus.HELD && payment.transferCode) {
        this.logger.warn(
          `capturePayment: payment ${reference} already has an initiated transfer (${payment.transferCode}) — skipping duplicate capture.`,
        );
        return;
      }

      // Capturable from HELD (first attempt, right after job completion) or
      // from PENDING_TRANSFER / TRANSFER_FAILED (a retry once a payout method
      // exists or the previous transfer attempt's cause has been resolved).
      const capturable: PaymentStatus[] = [
        PaymentStatus.HELD,
        PaymentStatus.PENDING_TRANSFER,
        PaymentStatus.TRANSFER_FAILED,
      ];
      if (!capturable.includes(payment.status)) {
        this.logger.warn(
          `capturePayment: payment ${reference} is ${payment.status}, not capturable`,
        );
        return;
      }

      const profileRepo = manager.getRepository(ArtisanProfile);
      const profile = await profileRepo.findOne({
        where: { id: payment.artisanProfileId },
      });
      if (!profile?.paystackRecipientCode) {
        this.logger.warn(
          `Artisan ${payment.artisanProfileId} has no payout method — marking PENDING_TRANSFER`,
        );
        payment.status = PaymentStatus.PENDING_TRANSFER;
        this.clearPayoutHold(payment);
        await paymentRepo.save(payment);
        return;
      }

      // The check must be for the payout method on file now. If there was
      // none (the payment changed state between the check and the lock) or
      // the artisan changed their details in between, nothing is sent: the
      // payment waits for a fresh check like any unavailable lookup.
      const current =
        check &&
        check.recipientCode === profile.paystackRecipientCode &&
        check.accountNumber === (profile.payoutAccountNumber ?? null) &&
        check.bankCode === (profile.payoutBankCode ?? null);
      const outcome = current ? check.outcome : 'unavailable';
      const masked = maskForLog(profile.payoutAccountNumber);

      if (outcome === 'mismatch' || outcome === 'not_found') {
        const reason =
          outcome === 'mismatch'
            ? PAYOUT_NAME_MISMATCH
            : PAYOUT_ACCOUNT_NOT_FOUND;
        // Told once per payment, however often it is retried.
        const tell = !payment.payoutHoldNotifiedAt;
        payment.status = PaymentStatus.PENDING_TRANSFER;
        payment.payoutHoldReason = reason;
        payment.payoutCheckAttempts = 0;
        payment.payoutCheckNextAt = null;
        if (tell) payment.payoutHoldNotifiedAt = new Date();
        await paymentRepo.save(payment);
        // Only the method that was checked; one saved since is left alone.
        await profileRepo.update(
          {
            id: profile.id,
            payoutAccountNumber: profile.payoutAccountNumber,
            payoutBankCode: profile.payoutBankCode,
          },
          { payoutAccountNameVerified: false },
        );
        this.logger.warn(
          `Payout held: job=${jobId} payment=${payment.id} account=${masked} reason=${reason}`,
        );
        if (tell) heldForArtisan = { payment, reason };
        return;
      }

      if (outcome === 'unavailable') {
        const attempts =
          payment.payoutHoldReason === PAYOUT_CHECK_PENDING
            ? (payment.payoutCheckAttempts ?? 0) + 1
            : 1;
        payment.status = PaymentStatus.PENDING_TRANSFER;
        payment.payoutHoldReason = PAYOUT_CHECK_PENDING;
        payment.payoutCheckAttempts = attempts;
        payment.payoutCheckNextAt = nextPayoutCheckAt(attempts, new Date());
        await paymentRepo.save(payment);
        this.logger.warn(
          `Payout name check unavailable: job=${jobId} payment=${payment.id} account=${masked} attempt=${attempts}` +
            (payment.payoutCheckNextAt
              ? ` — retrying at ${payment.payoutCheckNextAt.toISOString()}`
              : ' — automatic retries stopped; needs an admin'),
        );
        if (attempts === PAYOUT_CHECK_MAX_ATTEMPTS) checkGaveUp = payment;
        return;
      }

      // Name matches. A method saved while the lookup was unavailable (or
      // before it existed) is now verified, with Paystack's spelling.
      if (profile.payoutAccountNameVerified !== true && check?.resolvedName) {
        await profileRepo.update(
          {
            id: profile.id,
            payoutAccountNumber: profile.payoutAccountNumber,
            payoutBankCode: profile.payoutBankCode,
          },
          {
            payoutAccountNameVerified: true,
            payoutAccountName: check.resolvedName,
          },
        );
      }

      // Reset to HELD before (re)attempting — this is the "transfer in flight"
      // base state; the webhook flips it to RELEASED on success or this method
      // flips it to TRANSFER_FAILED below if the attempt itself errors out.
      payment.status = PaymentStatus.HELD;
      this.clearPayoutHold(payment);
      const transferRef = `jinva-tr-${jobId}-${Date.now()}`;
      payment.transferReference = transferRef;
      await paymentRepo.save(payment);

      try {
        const transfer = await this.paystack.initiateTransfer({
          amountGhs: payment.artisanAmount,
          recipientCode: profile.paystackRecipientCode,
          reference: transferRef,
          reason: `JinVa payout for job #${jobId}`,
        });

        payment.transferCode = transfer.transfer_code;
        await paymentRepo.save(payment);
        this.logger.log(
          `Transfer initiated: job=${jobId} amount=${payment.artisanAmount} GHS code=${transfer.transfer_code}`,
        );
      } catch (err) {
        // The transfer API call itself failed (as opposed to a later async
        // transfer.failed webhook) — mark it retryable rather than leaving the
        // payment stuck at HELD with no transferCode and no path forward.
        payment.status = PaymentStatus.TRANSFER_FAILED;
        await paymentRepo.save(payment);
        this.logger.error(
          `Transfer initiation failed: job=${jobId} ref=${transferRef}: ${err instanceof Error ? err.message : String(err)}`,
        );
        captureError = err instanceof Error ? err : new Error(String(err));
        failedPayment = payment;
      }
    });

    if (heldForArtisan) {
      await this.emitPayoutOnHold(
        heldForArtisan.payment,
        heldForArtisan.reason,
      );
    }

    if (checkGaveUp) {
      await this.emitTransferFailed(
        checkGaveUp,
        `The payout account name couldn't be checked after ${PAYOUT_CHECK_MAX_ATTEMPTS} tries, so automatic retries have stopped. Release it again once the account lookup works.`,
      );
    }

    if (failedPayment) {
      await this.emitTransferFailed(
        failedPayment,
        captureError?.message ?? 'Transfer initiation failed.',
      );
    }

    if (captureError) throw captureError;
  }

  /**
   * Reads the payment and payout method without a lock and, when a transfer
   * could follow, runs the payout name check. Undefined when no transfer can
   * follow (unknown payment, not capturable, a transfer already in flight,
   * or no payout method); the transaction re-checks all of that anyway.
   */
  private async precheckPayoutName(
    reference: string,
  ): Promise<PayoutNameCheck | undefined> {
    const payment = await this.repo.findOne({ where: { reference } });
    if (!payment) return undefined;
    if (payment.status === PaymentStatus.HELD && payment.transferCode) {
      return undefined;
    }
    const capturable: PaymentStatus[] = [
      PaymentStatus.HELD,
      PaymentStatus.PENDING_TRANSFER,
      PaymentStatus.TRANSFER_FAILED,
    ];
    if (!capturable.includes(payment.status)) return undefined;
    const profile = await this.profileRepo.findOne({
      where: { id: payment.artisanProfileId },
    });
    if (!profile?.paystackRecipientCode) return undefined;
    return this.checkPayoutName(profile);
  }

  private clearPayoutHold(payment: Payment): void {
    payment.payoutHoldReason = null;
    payment.payoutCheckAttempts = 0;
    payment.payoutCheckNextAt = null;
  }

  /**
   * Refunds or cancels the payment when a job is cancelled.
   * If the customer already paid (HELD), a Paystack refund is issued.
   *
   * security-report.md finding #2: locked the same way as
   * {@link capturePayment} so a cancellation can never race a concurrent
   * completion-confirmation capture for the *same payment row* — whichever
   * of the two gets there first wins, and the other observes the row in its
   * post-write state (no longer HELD/PENDING) and safely no-ops instead of
   * also refunding or also transferring.
   */
  /** QA JOB-11: whether the customer's money for this job is held in escrow. */
  async isPaymentSecured(reference: string): Promise<boolean> {
    const payment = await this.repo.findOne({ where: { reference } });
    return payment?.status === PaymentStatus.HELD;
  }

  async cancelPayment(reference: string, _jobId: number): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const paymentRepo = manager.getRepository(Payment);
      const payment = await paymentRepo.findOne({
        where: { reference },
        lock: { mode: 'pessimistic_write' },
      });
      if (!payment) return;

      if (payment.status === PaymentStatus.HELD) {
        try {
          await this.paystack.createRefund(
            payment.paidReference ?? payment.reference,
            payment.amount,
          );
        } catch (err) {
          // QA JOB-18: the caller cancels the job only after this succeeds, so
          // a refused refund leaves both the job and the payment untouched.
          this.logger.error(
            `Refund for payment ${payment.id} failed: ${err instanceof Error ? err.message : String(err)}`,
          );
          throw new ServiceUnavailableException(
            "We couldn't refund your payment right now, so the job has not been cancelled. Please try again in a few minutes.",
          );
        }
        payment.status = PaymentStatus.REFUNDED;
        payment.refundedAmount = payment.amount;
      } else if (payment.status === PaymentStatus.PENDING) {
        payment.status = PaymentStatus.CANCELLED;
      } else {
        // Already captured/transferred/refunded by a concurrent operation on
        // this same payment (e.g. a capturePayment that won the race) —
        // nothing safe to do here; leave the payment's real state untouched.
        this.logger.warn(
          `cancelPayment: payment ${reference} is ${payment.status}, not cancellable/refundable — leaving as-is.`,
        );
        return;
      }
      await paymentRepo.save(payment);
    });
  }

  // ─── Customer-facing HTTP endpoints ──────────────────────────────────────────

  /**
   * Returns the Paystack authorization URL for the customer to complete payment.
   * The PENDING payment record must already exist (created by holdPayment).
   *
   * qa-report.md "NEW MAJOR" (round 4): this used to resend the same
   * `payment.reference` (set once, forever, by {@link holdPayment}) to
   * Paystack's `/transaction/initialize` on *every* call. Paystack rejects a
   * second `/transaction/initialize` for a reference it has already
   * accepted with a "Duplicate Transaction Reference" error, which the
   * wrapper (`PaystackService`) surfaced as a raw, generic
   * `InternalServerErrorException` — a dead-end 500 for any customer who
   * closed the tab or abandoned checkout on their first attempt and
   * returned to a still-`PENDING` payment to click "Pay Now" again. This is
   * the exact "customer closes the tab mid-payment" edge case
   * requirements.md names explicitly.
   *
   * Fix (suggested direction (a) from the QA report): never call Paystack's
   * initialize a second time for the same still-PENDING payment at all — if
   * we already have a live checkout session (an `authorizationUrl`/
   * `accessCode` Paystack already handed back), just return that same one
   * again. This is deliberately preferred over rotating `payment.reference`
   * on every call (suggested direction (b)): `reference` is the single key
   * every other lookup in this service depends on — `job.paymentIntentId`
   * (read by `JobsService` at completion/cancellation time to call
   * `capturePayment`/`cancelPayment`) is set to it exactly once at
   * `holdPayment` time and never re-synced, and the `charge.success`/
   * `transfer.*` webhook handlers key off whatever reference Paystack
   * reports back. Rotating it here would either require threading a
   * job-table write through this service on every retry (an extra
   * cross-entity write for what should be a a read-mostly endpoint) or risk
   * a customer completing checkout on an old, still-open tab against a
   * reference this row no longer recognizes — silently losing a real
   * payment. Reusing the existing session avoids both risks entirely and
   * keeps `reference` a true 1:1, immutable key for the life of the row.
   */
  /**
   * B5c: the checkout channels for the customer's stored preference, with the
   * preferred one first, or `undefined` when there is no preference. Reading
   * the preference must never stop a payment: any error is logged without
   * personal data and checkout proceeds as if nothing were saved (AC-5.6).
   */
  private async checkoutChannelsFor(
    customerId: number,
  ): Promise<string[] | undefined> {
    try {
      const settings = await this.dataSource
        .getRepository(CustomerPaymentSettings)
        .findOne({
          where: { userId: customerId },
          select: { id: true, preferredChannel: true },
        });
      return orderCheckoutChannels(settings?.preferredChannel ?? null);
    } catch (err) {
      this.logger.warn(
        `Could not read checkout preference; using the default channels (${
          (err as Error)?.name ?? 'Error'
        })`,
      );
      return undefined;
    }
  }

  async initializePayment(
    customerId: number,
    jobId: number,
    opts: { saveCard?: boolean } = {},
  ) {
    // Idempotent payments: one active attempt per job. The same hosted
    // attempt comes back while it is open (Paystack refuses a reused
    // reference, so its session is stored on the attempt); a paid job is
    // 409 ALREADY_PAID; an active saved-method charge is 409
    // PAYMENT_ATTEMPT_ACTIVE.
    const claim = await this.attempts.claim(
      customerId,
      jobId,
      { kind: 'hosted' },
      this.settle,
      NO_PENDING_HOSTED_PAYMENT,
    );
    const { payment } = claim;
    let charge = claim.charge;

    // Saved payment methods: the customer's "Save this card for next time"
    // choice, recorded on the payment row by the server. Only this allows
    // the card from this payment's charge.success to be saved; webhook
    // metadata is never trusted alone. The latest choice wins.
    const wantSave = opts.saveCard === true;
    if (wantSave !== (payment.saveCardRequested === true)) {
      payment.saveCardRequested = wantSave;
      await this.repo.update(
        { id: payment.id },
        { saveCardRequested: wantSave },
      );
    }

    const session = (c: PaymentCharge, again: boolean) => ({
      message: again
        ? 'Payment already initialized. Redirect the customer to the authorization URL.'
        : 'Payment initialized. Redirect the customer to the authorization URL.',
      data: {
        reference: c.reference,
        authorizationUrl: c.authorizationUrl as string,
        accessCode: c.accessCode as string,
        amount: payment.amount,
        currency: payment.currency,
      },
    });

    if (claim.outcome === 'existing') {
      // A concurrent initialise may still be waiting for Paystack's answer.
      for (let i = 0; i < 10 && !charge.authorizationUrl; i++) {
        await new Promise((r) => setTimeout(r, 300));
        charge =
          (await this.chargeRepo.findOne({ where: { id: charge.id } })) ??
          charge;
      }
      if (charge.authorizationUrl && charge.accessCode) {
        return session(charge, true);
      }
      throw PaymentAttemptsService.attemptActive(charge, jobId);
    }

    const customer = await this.userRepo.findOneOrFail({
      where: { id: customerId },
    });
    const channels = await this.checkoutChannelsFor(customerId);

    let result: { authorization_url: string; access_code: string };
    try {
      result = await this.paystack.initializeTransaction({
        email: customer.email,
        amountGhs: payment.amount,
        reference: charge.reference,
        callbackUrl: this.paymentCallbackUrl(payment.jobId),
        metadata: {
          jobId: payment.jobId,
          customerId,
          paymentId: payment.id,
          chargeId: charge.id,
          ...(wantSave ? { save_card: true } : {}),
        },
        // B5c: only when the customer saved a preference. Without one the
        // Paystack payload carries no `channels` key, exactly as before.
        ...(channels ? { channels } : {}),
      });
    } catch (err) {
      // A checkout opened before attempts were tracked keeps its session on
      // the payment row: Paystack refuses its reference again, so reuse it.
      if (
        err instanceof Error &&
        /duplicate transaction reference/i.test(err.message) &&
        charge.reference === payment.reference &&
        payment.authorizationUrl &&
        payment.accessCode
      ) {
        result = {
          authorization_url: payment.authorizationUrl,
          access_code: payment.accessCode,
        };
      } else {
        // Nothing was opened: release the attempt so the customer can retry.
        await this.chargeRepo.update(
          { id: charge.id, status: 'hosted_open' },
          { status: 'failed', action: null },
        );
        throw err;
      }
    }

    await this.chargeRepo.update(
      { id: charge.id },
      {
        authorizationUrl: result.authorization_url,
        accessCode: result.access_code,
      },
    );
    charge = {
      ...charge,
      authorizationUrl: result.authorization_url,
      accessCode: result.access_code,
    } as PaymentCharge;
    if (charge.reference === payment.reference) {
      // Kept on the payment row too, for anything still reading it there.
      await this.repo.update(
        { id: payment.id },
        {
          authorizationUrl: result.authorization_url,
          accessCode: result.access_code,
        },
      );
    }
    return session(charge, false);
  }

  /**
   * `GET /payments/jobs/:jobId/attempt`: whether the job is paid, the active
   * attempt to resume, and duplicate payments refunded for it.
   */
  getJobPaymentState(customerId: number, jobId: number) {
    return this.attempts.jobState(customerId, jobId, this.settle);
  }

  /** The verified-success path every caller shares (webhook, verify, status). */
  private readonly settle = (
    chargeId: number,
    data: Record<string, unknown>,
  ): Promise<void> => this.applyChargeSuccess(chargeId, data);

  /**
   * security-report.md finding #5: previously returned the raw `Payment`
   * entity, leaking Paystack-internal fields (`transferCode`,
   * `transferReference`, `accessCode`, `authorizationUrl`), the platform's
   * fee take (`platformFee`), and the artisan's payout amount
   * (`artisanAmount`) to the paying customer. Given the same explicit
   * minimal-shape treatment as {@link getMyEarnings}: job, amount, status,
   * date, and the customer's own reference — no provider-internal or
   * artisan-payout-side fields.
   */
  async getMyHistory(customerId: number) {
    const payments = await this.repo.find({
      where: { customerId },
      relations: ['job'],
      order: { createdAt: 'DESC' },
    });

    const data = payments.map((p) => ({
      id: p.id,
      reference: p.reference,
      // `jobId` sits beside `job` for the job and pay pages, which look the
      // payment up by job (QA PAY-01: they matched on a field the API never sent).
      jobId: p.job?.id ?? p.jobId,
      job: { id: p.job?.id ?? p.jobId, title: p.job?.title ?? null },
      amount: p.amount,
      currency: p.currency,
      status: p.status,
      refundedAmount: p.refundedAmount ?? 0,
      paidAt: p.paidAt ?? null,
      // QA PAY-20: the customer's "Paid on" line needs when the payout landed.
      releasedAt: p.releasedAt ?? null,
      date: p.createdAt,
    }));

    return { message: 'Payment history retrieved.', data };
  }

  /**
   * Reconciles a payment reference against Paystack directly — a
   * belt-and-suspenders check for the customer's redirect-back landing page,
   * since the charge.success webhook can lag by a few seconds (or, rarely,
   * never arrive). Ownership-checked: a customer can only verify their own
   * payment's reference.
   */
  /**
   * Where Paystack sends the customer after the hosted checkout: the job's own
   * pay page on the frontend, which reads `?reference=` and confirms the
   * payment. Built per job, because that page's path carries the job id; a
   * single fixed PAYSTACK_CALLBACK_URL can't. PAYSTACK_CALLBACK_URL is only
   * the fallback when FRONTEND_URL isn't set.
   */
  paymentCallbackUrl(jobId: number): string | undefined {
    const frontend = (this.config.get<string>('FRONTEND_URL') ?? '')
      .trim()
      .replace(/\/+$/, '');
    if (frontend) return `${frontend}/dashboard/user/jobs/${jobId}/pay`;
    return this.config.get<string>('PAYSTACK_CALLBACK_URL') || undefined;
  }

  /**
   * Safety net for checkouts started while PAYSTACK_CALLBACK_URL pointed at
   * the backend (`/payments/callback`): where to send that browser. The job's
   * pay page when the reference is ours, otherwise the client's jobs list.
   * Reveals nothing about the payment beyond the job id the reference was
   * issued for; the pay page itself checks the signed-in owner.
   */
  async callbackRedirectUrl(reference: string | undefined): Promise<string> {
    const frontend = (this.config.get<string>('FRONTEND_URL') ?? '')
      .trim()
      .replace(/\/+$/, '');
    const fallback = `${frontend}/dashboard/user/jobs`;
    const ref = (reference ?? '').trim();
    if (!/^[A-Za-z0-9_-]{6,100}$/.test(ref)) return fallback;

    const payment =
      (await this.repo.findOne({ where: { reference: ref } })) ??
      (await this.repo.findOne({ where: { paidReference: ref } }));
    let jobId = payment?.jobId;
    if (!jobId) {
      const charge = await this.chargeRepo.findOne({
        where: { reference: ref },
      });
      if (charge?.paymentId) {
        const viaCharge = await this.repo.findOne({
          where: { id: charge.paymentId },
        });
        jobId = viaCharge?.jobId;
      }
    }
    if (!jobId) return fallback;
    return `${frontend}/dashboard/user/jobs/${jobId}/pay?reference=${encodeURIComponent(ref)}`;
  }

  async verifyPayment(customerId: number, reference: string) {
    // Any attempt's reference (hosted or saved), or the payment's own.
    let charge = await this.chargeRepo.findOne({ where: { reference } });
    let payment = charge
      ? await this.repo.findOne({ where: { id: charge.paymentId } })
      : await this.repo.findOne({ where: { reference } });
    if (!payment || payment.customerId !== customerId) {
      throw new NotFoundException('Payment not found.');
    }

    const remote = await this.paystack.verifyTransaction(reference);

    // Reconcile: if Paystack confirms success and our webhook hasn't landed
    // yet, settle it now through the same locked transition as the webhook
    // (HELD, or a refunded duplicate when another payment already holds the
    // job). A failed/abandoned remote status changes nothing here; the
    // attempt is released by the attempt rules, and the customer can pay
    // again. security-report.md finding #6: the amount and currency are
    // checked inside the transition; a mismatch is left for manual review.
    if (remote.status === 'success') {
      charge ??= await this.linkPaymentReference(payment);
      await this.applyChargeSuccess(charge.id, {
        reference,
        amount: remote.amount,
        currency: remote.currency,
        channel: remote.channel,
        paid_at: remote.paid_at,
      });
      payment =
        (await this.repo.findOne({ where: { id: payment.id } })) ?? payment;
    }

    return {
      message: 'Payment verification complete.',
      data: {
        reference,
        jobId: payment.jobId,
        status: payment.status,
        remoteStatus: remote.status,
        amount: payment.amount,
        currency: payment.currency,
      },
    };
  }

  /**
   * A2: the artisan-facing equivalent of getMyHistory — scoped strictly to
   * the authenticated artisan's own artisanProfileId. Deliberately returns a
   * minimal shape rather than the raw Payment entity: never
   * paystackRecipientCode, transferCode, transferReference, or the
   * customer's contact details — only what's needed to render earnings and
   * drive the retry-transfer action.
   */
  async getMyEarnings(artisanUserId: number) {
    const profile = await this.profileRepo.findOne({
      where: { user: { id: artisanUserId } },
    });
    if (!profile) throw new NotFoundException('Artisan profile not found.');

    const payments = await this.repo.find({
      where: { artisanProfileId: profile.id },
      relations: ['job'],
      order: { createdAt: 'DESC' },
    });

    const data = payments.map((p) => ({
      id: p.id,
      jobId: p.jobId,
      job: { id: p.job?.id ?? p.jobId, title: p.job?.title ?? null },
      artisanAmount: p.artisanAmount,
      status: p.status,
      date: p.createdAt,
      // QA PAY-20: when the customer paid and when it reached the artisan.
      paidAt: p.paidAt ?? null,
      releasedAt: p.releasedAt ?? null,
    }));

    return { message: 'Earnings history retrieved.', data };
  }

  // ─── Admin-facing ─────────────────────────────────────────────────────────────

  /**
   * QA PAY-21: whole-ledger totals for the Transactions page, whose tiles
   * were sums over the loaded page only.
   */
  async getAdminSummary() {
    const [row]: Array<Record<string, string>> = await this.repo.query(
      `SELECT
         COALESCE(SUM(amount) FILTER (WHERE status = ANY($1)), 0) AS revenue,
         COALESCE(SUM(platform_fee) FILTER (WHERE status = ANY($1)), 0) AS fees,
         COALESCE(SUM(artisan_amount) FILTER (WHERE status = $2), 0) AS payouts,
         COUNT(*) FILTER (WHERE status = ANY($3)) AS needs_review,
         COUNT(*) AS total
       FROM payments`,
      [
        [PaymentStatus.HELD, PaymentStatus.RELEASED],
        PaymentStatus.RELEASED,
        [PaymentStatus.PENDING_TRANSFER, PaymentStatus.TRANSFER_FAILED],
      ],
    );
    return {
      message: 'Payment summary retrieved.',
      data: {
        totalRevenue: Number(row.revenue),
        totalFees: Number(row.fees),
        totalPayouts: Number(row.payouts),
        needsReview: Number(row.needs_review),
        totalPayments: Number(row.total),
      },
    };
  }

  async getAllPayments(
    page = 1,
    limit = 20,
    filters: { search?: string; status?: PaymentStatus } = {},
  ) {
    // security-report.md finding #8: clamp regardless of what's requested —
    // an admin session (or a compromised admin token) could otherwise force
    // an unbounded `findAndCount`.
    const safePage = Math.max(1, page || 1);
    const safeLimit = Math.min(Math.max(1, limit || 20), MAX_ADMIN_PAGE_LIMIT);
    // QA PAY-21: search and status now cover the whole ledger, not just the
    // page the admin happens to have loaded.
    const qb = this.repo
      .createQueryBuilder('p')
      .leftJoinAndSelect('p.job', 'job')
      .leftJoinAndSelect('p.customer', 'customer')
      .orderBy('p.createdAt', 'DESC')
      .skip((safePage - 1) * safeLimit)
      .take(safeLimit);
    if (filters.status)
      qb.andWhere('p.status = :status', { status: filters.status });
    const term = filters.search?.trim().toLowerCase();
    if (term) {
      qb.andWhere(
        `(LOWER(p.reference) LIKE :like
          OR LOWER(customer.firstname || ' ' || customer.lastname) LIKE :like
          OR LOWER(customer.email) LIKE :like
          OR LOWER(COALESCE(job.title, '')) LIKE :like
          OR CAST(p.jobId AS text) = :exact)`,
        { like: `%${term}%`, exact: term.replace(/^#/, '') },
      );
    }
    const [records, total] = await qb.getManyAndCount();
    return {
      message: 'Payments retrieved.',
      data: records,
      pagination: {
        total,
        page: safePage,
        limit: safeLimit,
        totalPages: Math.ceil(total / safeLimit),
      },
    };
  }

  /**
   * security-report.md finding #4: locked (same pattern as capturePayment/
   * cancelPayment) so two concurrent refund requests for the same payment
   * (double-submitted dialog, retried request after a client timeout, two
   * admins acting on the same ticket) serialize instead of both passing the
   * status/amount check before either commits. The amount check is now
   * against the *remaining* refundable balance (`amount - refundedAmount`),
   * not the original total, so two legitimate partial refunds can't each
   * independently be approved for up to the full original amount.
   */
  /**
   * DR2: the release-of-a-withheld-payment path, made reachable from a dispute
   * ruling ("rule for the artisan").
   *
   * Deliberately a thin wrapper over the existing {@link capturePayment} —
   * that method already owns the pessimistic row lock, the duplicate-transfer
   * guard and the Paystack transfer call, and re-implementing any of it here
   * would fork the platform's only payout path.
   *
   * What this adds is a **truthful outcome**, which the dispute flow depends
   * on: `capturePayment` intentionally *no-ops* in several situations (no
   * payout method on file → the payment is parked at `PENDING_TRANSFER`, an
   * already-initiated transfer → skipped) and returns without throwing. A
   * dispute resolution must never tell both parties that money moved when it
   * did not, so those cases are re-read after the call and turned into
   * explicit errors for the caller to surface.
   */
  /** Payout name check: why an admin/dispute release sent nothing. */
  private static adminHoldMessage(reason: PayoutHoldReason): string {
    if (reason === PAYOUT_CHECK_PENDING) {
      return (
        "The artisan's payout account couldn't be checked right now, so nothing was transferred. " +
        'It stays withheld and the check is retried automatically.'
      );
    }
    const cause =
      reason === PAYOUT_NAME_MISMATCH
        ? "the name on the artisan's payout account doesn't match the name they saved"
        : "the artisan's payout account couldn't be found";
    return (
      `Nothing was transferred because ${cause}. ` +
      'It stays withheld and is sent once they update their payment details.'
    );
  }

  async releaseWithheldPayment(paymentId: number) {
    const payment = await this.repo.findOne({ where: { id: paymentId } });
    if (!payment) {
      throw new NotFoundException(`Payment ${paymentId} not found.`);
    }
    if (payment.status === PaymentStatus.RELEASED) {
      throw new BadRequestException(
        'This payment has already been released to the artisan.',
      );
    }

    const releasable: PaymentStatus[] = [
      PaymentStatus.HELD,
      PaymentStatus.PENDING_TRANSFER,
      PaymentStatus.TRANSFER_FAILED,
    ];
    if (!releasable.includes(payment.status)) {
      throw new BadRequestException(
        `Cannot release a payment with status ${payment.status}.`,
      );
    }
    if (payment.status === PaymentStatus.HELD && payment.transferCode) {
      throw new BadRequestException(
        'A payout for this payment has already been initiated and is awaiting confirmation.',
      );
    }

    await this.capturePayment(payment.reference, payment.jobId);

    const after = await this.repo.findOne({ where: { id: paymentId } });
    if (
      after?.status === PaymentStatus.PENDING_TRANSFER &&
      after.payoutHoldReason
    ) {
      throw new BadRequestException(
        PaymentsService.adminHoldMessage(after.payoutHoldReason),
      );
    }
    if (after?.status === PaymentStatus.PENDING_TRANSFER) {
      throw new BadRequestException(
        'The artisan has no payout method registered, so the withheld amount could not be transferred. ' +
          'It stays withheld and will transfer once they add one.',
      );
    }
    if (after?.status !== PaymentStatus.RELEASED && !after?.transferCode) {
      throw new BadRequestException(
        'The transfer could not be initiated. The payment is unchanged — retry once the cause is resolved.',
      );
    }

    return {
      message: 'Withheld payment released to the artisan.',
      data: {
        paymentId: payment.id,
        artisanAmount: Number(payment.artisanAmount),
        status: after?.status ?? payment.status,
      },
    };
  }

  // ─── AT7: fraud flagging ──────────────────────────────────────────────────────

  /**
   * AT7: marks a transaction for fraud review with a mandatory reason.
   *
   * Marking, visibility and auditing only — the flag deliberately has **no**
   * enforcement effect on payouts, refunds or the account (Open Question 9,
   * resolved). It is also kept entirely separate from `Payment.status`, so a
   * payment can be both `RELEASED` and flagged and the settled payment-status
   * vocabulary is never forked.
   */
  async setFraudFlag(admin: User, paymentId: number, reason: string) {
    const payment = await this.repo.findOne({ where: { id: paymentId } });
    if (!payment) {
      throw new NotFoundException(`Payment ${paymentId} not found.`);
    }
    if (payment.fraudFlagged) {
      throw new BadRequestException(
        'This transaction is already flagged for fraud review.',
      );
    }

    payment.fraudFlagged = true;
    payment.fraudFlagReason = reason;
    payment.fraudFlaggedAt = new Date();
    payment.fraudFlaggedById = admin.id;
    await this.repo.save(payment);

    await this.auditService.record({
      action: AdminActionType.PAYMENT_FRAUD_FLAG,
      targetType: AdminActionTarget.PAYMENT,
      targetId: payment.id,
      targetLabel: `Payment ${payment.reference}`,
      reason,
      actorId: admin.id,
      actorName: `${admin.firstname} ${admin.lastname}`,
      actorEmail: admin.email,
      amount: Number(payment.amount),
      metadata: { jobId: payment.jobId, status: payment.status },
    });

    return { message: 'Transaction flagged for fraud review.' };
  }

  /** AT7: clears the flag, with its own mandatory reason and audit row. */
  async clearFraudFlag(admin: User, paymentId: number, reason: string) {
    const payment = await this.repo.findOne({ where: { id: paymentId } });
    if (!payment) {
      throw new NotFoundException(`Payment ${paymentId} not found.`);
    }
    if (!payment.fraudFlagged) {
      throw new BadRequestException(
        'This transaction is not currently flagged.',
      );
    }

    payment.fraudFlagged = false;
    // Must be `null`, not `undefined`, for TypeORM's save() to actually clear
    // the column in Postgres.
    payment.fraudFlagReason = null;
    payment.fraudFlaggedAt = null;
    payment.fraudFlaggedById = null;
    await this.repo.save(payment);

    await this.auditService.record({
      action: AdminActionType.PAYMENT_FRAUD_FLAG_CLEARED,
      targetType: AdminActionTarget.PAYMENT,
      targetId: payment.id,
      targetLabel: `Payment ${payment.reference}`,
      reason,
      actorId: admin.id,
      actorName: `${admin.firstname} ${admin.lastname}`,
      actorEmail: admin.email,
      metadata: { jobId: payment.jobId, status: payment.status },
    });

    return { message: 'Fraud flag cleared.' };
  }

  async adminRefund(paymentId: number, amountGhs?: number, actor?: User) {
    /**
     * PD3: captured inside the transaction, emitted after it commits — the
     * customer must never be told their money is coming back on the strength
     * of a write that then rolled back.
     */
    let refundOutcome:
      | { payment: Payment; refundedNow: number; fullyRefunded: boolean }
      | undefined;

    const result = await this.dataSource.transaction(async (manager) => {
      const paymentRepo = manager.getRepository(Payment);
      const payment = await paymentRepo.findOne({
        where: { id: paymentId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!payment) {
        throw new NotFoundException(`Payment ${paymentId} not found.`);
      }
      if (
        payment.status !== PaymentStatus.HELD &&
        payment.status !== PaymentStatus.RELEASED
      ) {
        throw new BadRequestException(
          `Cannot refund a payment with status ${payment.status}.`,
        );
      }

      const alreadyRefunded = Number(payment.refundedAmount ?? 0);
      const remaining = +(Number(payment.amount) - alreadyRefunded).toFixed(2);
      if (remaining <= 0) {
        throw new BadRequestException(
          'This payment has already been fully refunded.',
        );
      }

      const refundAmount = amountGhs ?? remaining;
      if (refundAmount <= 0) {
        throw new BadRequestException(
          'Refund amount must be a positive number.',
        );
      }
      // Server-side security boundary: a (partial) refund can never exceed
      // the *remaining* refundable balance, regardless of what the frontend
      // sends or validates.
      if (refundAmount > remaining) {
        throw new BadRequestException(
          `Refund amount (GH₵${refundAmount}) cannot exceed the remaining refundable balance (GH₵${remaining}).`,
        );
      }

      // The reference whose money the payment holds (a saved-method charge
      // has its own); the payment's own reference for older payments.
      await this.paystack.createRefund(
        payment.paidReference ?? payment.reference,
        refundAmount,
      );
      payment.refundedAmount = +(alreadyRefunded + refundAmount).toFixed(2);
      const fullyRefunded = payment.refundedAmount >= Number(payment.amount);
      if (fullyRefunded) {
        payment.status = PaymentStatus.REFUNDED;
      }
      await paymentRepo.save(payment);
      refundOutcome = { payment, refundedNow: refundAmount, fullyRefunded };
      return { message: 'Refund initiated.' };
    });

    if (refundOutcome) {
      await this.emitPaymentRefunded(
        refundOutcome.payment,
        refundOutcome.refundedNow,
        refundOutcome.fullyRefunded,
      );

      // AT5: refunds are one of the actions the audit log exists for. `actor`
      // is optional only because the refund path predates the log; every
      // caller in this codebase passes it (the admin endpoint and the dispute
      // ruling both do), so a refund with no recorded actor would be a bug.
      if (actor) {
        await this.auditService.record({
          action: AdminActionType.PAYMENT_REFUND,
          targetType: AdminActionTarget.PAYMENT,
          targetId: refundOutcome.payment.id,
          targetLabel: `Payment ${refundOutcome.payment.reference}`,
          actorId: actor.id,
          actorName: `${actor.firstname} ${actor.lastname}`,
          actorEmail: actor.email,
          amount: refundOutcome.refundedNow,
          moneyAction: 'REFUND',
          metadata: {
            jobId: refundOutcome.payment.jobId,
            fullyRefunded: refundOutcome.fullyRefunded,
          },
        });
      } else {
        this.logger.warn(
          `Refund on payment ${refundOutcome.payment.id} was recorded with no acting admin — no audit row written.`,
        );
      }
    }

    return result;
  }

  // ─── Paystack webhook processor ──────────────────────────────────────────────

  async processWebhook(rawBody: string, signature: string): Promise<void> {
    if (!this.paystack.verifyWebhookSignature(rawBody, signature)) {
      this.logger.warn('Paystack webhook: invalid signature — ignored');
      return;
    }

    const event = JSON.parse(rawBody) as {
      event: string;
      data: Record<string, unknown>;
    };
    this.logger.log(`Paystack webhook: ${event.event}`);

    switch (event.event) {
      case 'charge.success':
        return this.onChargeSuccess(event.data);
      case 'transfer.success':
        return this.onTransferSuccess(event.data);
      case 'transfer.failed':
      case 'transfer.reversed':
        return this.onTransferFailed(event.event, event.data);
      case 'refund.pending':
      case 'refund.processing':
      case 'refund.processed':
      case 'refund.failed':
        return this.refunds.onRefundWebhook(event.event, event.data ?? {});
    }
  }

  /**
   * Every successful charge (hosted or saved method) resolves to its
   * attempt row and goes through {@link applyChargeSuccess}: one locked
   * transition, idempotent on Paystack's retries.
   */
  private async onChargeSuccess(data: Record<string, unknown>) {
    const reference = typeof data.reference === 'string' ? data.reference : '';
    let charge = reference
      ? await this.chargeRepo.findOne({ where: { reference } })
      : null;
    if (!charge) {
      const payment = reference
        ? await this.repo.findOne({ where: { reference } })
        : null;
      if (!payment) {
        this.logger.warn(
          `charge.success: no payment for reference ${reference}`,
        );
        return;
      }
      // A hosted checkout opened before attempts were tracked.
      charge = await this.linkPaymentReference(payment);
    }
    await this.applyChargeSuccess(charge.id, data);
  }

  /**
   * The attempt row for a payment's own reference, created (not active) when
   * a checkout from before attempts were tracked reports back.
   */
  private async linkPaymentReference(payment: Payment): Promise<PaymentCharge> {
    const existing = await this.chargeRepo.findOne({
      where: { reference: payment.reference },
    });
    if (existing) return existing;
    try {
      await this.chargeRepo.insert({
        paymentId: payment.id,
        customerId: payment.customerId,
        reference: payment.reference,
        methodType: 'hosted',
        paymentMethodId: null,
        status: 'expired',
        action: null,
        message: null,
        authorizationUrl: payment.authorizationUrl ?? null,
        accessCode: payment.accessCode ?? null,
      });
    } catch {
      // A concurrent delivery inserted it first.
    }
    return this.chargeRepo.findOneOrFail({
      where: { reference: payment.reference },
    });
  }

  /**
   * Saved payment methods: keeps the card from an opted-in hosted charge.
   * Never fails the webhook; logs the outcome without any card data.
   */
  private async saveCardBestEffort(
    payment: Payment,
    authorization: PaystackAuthorization | undefined,
  ): Promise<void> {
    try {
      const outcome = await this.paymentMethods.saveCardFromAuthorization(
        payment.customerId,
        authorization,
      );
      this.logger.log(`Card save for payment ${payment.id}: ${outcome}`);
    } catch (err) {
      this.logger.warn(
        `Card save for payment ${payment.id} failed: ${(err as Error)?.name ?? 'Error'}`,
      );
    }
  }

  /**
   * A charge succeeded (webhook or verify), whichever way it was paid. Under
   * a lock on the payment row:
   *
   * - The attempt already succeeded or was already handled as a duplicate:
   *   nothing (a redelivered webhook, or a verify after it).
   * - Paystack's amount or currency differs: left for manual review.
   * - The payment is PENDING: PENDING → HELD, recording this reference as
   *   the one holding the money; notified once.
   * - The job is already paid by another reference (or no longer due): this
   *   is a duplicate. It is marked so and refunded automatically
   *   ({@link DuplicateRefundService}); the reference holding the job's
   *   money is never refunded.
   */
  async applyChargeSuccess(
    chargeId: number,
    data: Record<string, unknown>,
  ): Promise<void> {
    const reference = typeof data.reference === 'string' ? data.reference : '';
    const result = await this.dataSource.transaction(async (manager) => {
      const charges = manager.getRepository(PaymentCharge);
      const first = await charges.findOne({ where: { id: chargeId } });
      if (!first) return null;
      const payment = await manager.getRepository(Payment).findOne({
        where: { id: first.paymentId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!payment) return null;
      // Re-read under the payment lock: a concurrent delivery may have won.
      const charge =
        (await charges.findOne({ where: { id: chargeId } })) ?? first;
      if (charge.status === 'succeeded' || charge.status === 'duplicate') {
        return null;
      }

      const paidAmountPesewas = Number(data.amount);
      const paidCurrency = (data.currency as string | undefined) ?? 'GHS';
      const expectedPesewas = Math.round(Number(payment.amount) * 100);
      if (paidAmountPesewas !== expectedPesewas || paidCurrency !== 'GHS') {
        this.logger.error(
          `charge.success: amount/currency mismatch for ref=${reference} — ` +
            `Paystack reports ${paidAmountPesewas} ${paidCurrency}, expected ${expectedPesewas} GHS pesewas. ` +
            `Refusing to auto-reconcile; needs manual review.`,
        );
        return null;
      }
      const channel =
        (data.channel as string | undefined) ??
        (charge.methodType === 'hosted' ? null : charge.methodType);

      if (payment.status !== PaymentStatus.PENDING) {
        if (DuplicateRefundService.holdsMoney(payment, charge.reference)) {
          // This reference already holds the job's money (a checkout from
          // before attempts were tracked): record it, never refund it.
          await charges.update(
            { id: charge.id },
            { status: 'succeeded', action: null, message: null, channel },
          );
          return null;
        }
        await charges.update(
          { id: charge.id },
          {
            status: 'duplicate',
            action: null,
            message: CHARGE_MESSAGES.DUPLICATE,
            channel,
            refundStatus: 'pending',
            refundAmount: +(paidAmountPesewas / 100).toFixed(2),
            refundNextAt: new Date(),
          },
        );
        this.logger.error(
          `charge.success: payment ${payment.id} (job ${payment.jobId}) is ${payment.status}; ` +
            `ref=${reference} is a second payment and is being refunded automatically.`,
        );
        return { kind: 'duplicate' as const, payment, charge };
      }

      payment.status = PaymentStatus.HELD;
      payment.channel = channel ?? payment.channel;
      payment.paidAt = data.paid_at
        ? new Date(data.paid_at as string)
        : new Date();
      payment.paidReference = charge.reference;
      await manager.getRepository(Payment).save(payment);
      await charges.update(
        { id: charge.id },
        { status: 'succeeded', action: null, message: null, channel },
      );
      return { kind: 'held' as const, payment, charge };
    });

    if (!result) return;
    if (result.kind === 'duplicate') {
      try {
        await this.refunds.process(result.charge.id);
      } catch (err) {
        // Still `pending`: the scheduler retries it.
        this.logger.error(
          `Refund of duplicate ${reference} not started: ${(err as Error)?.message ?? 'Error'}`,
        );
      }
      return;
    }

    const held = result.payment;
    this.logger.log(`Payment HELD: ref=${reference} channel=${held.channel}`);
    await this.emitPaymentHeld(held);
    if (result.charge.methodType === 'hosted' && held.saveCardRequested) {
      await this.saveCardBestEffort(
        held,
        data.authorization as PaystackAuthorization | undefined,
      );
    }
  }

  /** Kept for callers of the saved-method path. */
  applySavedChargeSuccess(
    chargeId: number,
    data: Record<string, unknown>,
  ): Promise<void> {
    return this.applyChargeSuccess(chargeId, data);
  }

  private async onTransferSuccess(data: Record<string, unknown>) {
    const reference = data.reference as string;
    const payment = await this.repo.findOne({
      where: { transferReference: reference },
    });
    if (!payment) return;

    // PD2: same redelivery guard as onChargeSuccess — only a genuine
    // transition into RELEASED announces a payout to the artisan.
    const isFirstRelease = payment.status !== PaymentStatus.RELEASED;

    payment.status = PaymentStatus.RELEASED;
    payment.releasedAt = new Date();
    await this.repo.save(payment);
    this.logger.log(`Payment RELEASED: job=${payment.jobId}`);

    if (isFirstRelease) await this.emitPayoutReleased(payment);
  }

  private async onTransferFailed(event: string, data: Record<string, unknown>) {
    this.logger.error(`Transfer ${event}: ${JSON.stringify(data)}`);

    const reference = data.reference as string | undefined;
    if (!reference) return;

    const payment = await this.repo.findOne({
      where: { transferReference: reference },
    });
    if (!payment) {
      this.logger.warn(
        `${event}: no payment for transferReference=${reference}`,
      );
      return;
    }

    const isFirstFailure = payment.status !== PaymentStatus.TRANSFER_FAILED;

    payment.status = PaymentStatus.TRANSFER_FAILED;
    await this.repo.save(payment);
    this.logger.warn(
      `Payment marked TRANSFER_FAILED: job=${payment.jobId} ref=${reference} — retryable via retry-transfer.`,
    );

    if (isFirstFailure) {
      const providerReason =
        typeof data.reason === 'string' && data.reason.length > 0
          ? data.reason
          : `Paystack reported ${event}`;
      await this.emitTransferFailed(payment, providerReason);
    }
  }

  // ─── Artisan payout setup ─────────────────────────────────────────────────────

  /**
   * Registers the artisan's mobile money or bank account with Paystack and
   * stores the recipient_code on their profile for future payouts.
   *
   * The account name is looked up on the server and the looked-up name is
   * what is stored (never the client's): a number Paystack can't resolve is
   * refused with 422; when the lookup is unavailable the typed name is used,
   * stored as not verified, so a Paystack outage never blocks the save.
   */
  async setupPayoutMethod(
    artisanUserId: number,
    dto: {
      type: 'mobile_money' | 'bank';
      accountName?: string;
      accountNumber: string;
      bankCode: string;
    },
  ) {
    const profile = await this.profileRepo.findOne({
      where: { user: { id: artisanUserId } },
    });
    if (!profile) throw new NotFoundException('Artisan profile not found.');

    const lookup = await this.paystack.resolveAccount(
      dto.accountNumber,
      dto.bankCode,
    );
    if (lookup.status === 'unresolvable') {
      throw new UnprocessableEntityException(ACCOUNT_NAME_NOT_FOUND);
    }
    const verified = lookup.status === 'resolved';
    const accountName = verified
      ? lookup.accountName
      : (dto.accountName ?? '').trim();
    if (accountName.length < 2) {
      throw new BadRequestException(ACCOUNT_NAME_REQUIRED);
    }

    const paystackType =
      dto.type === 'mobile_money' ? 'mobile_money' : 'ghipss';
    const recipient = await this.paystack.createTransferRecipient({
      type: paystackType,
      name: accountName,
      accountNumber: dto.accountNumber,
      bankCode: dto.bankCode,
    });

    profile.payoutType =
      dto.type === 'mobile_money' ? PayoutType.MOBILE_MONEY : PayoutType.BANK;
    profile.paystackRecipientCode = recipient.recipient_code;
    profile.payoutAccountName = accountName;
    profile.payoutAccountNameVerified = verified;
    profile.payoutAccountNumber = dto.accountNumber;
    profile.payoutBankCode = dto.bankCode;
    await this.profileRepo.save(profile);

    const held = await this.retryHeldPayouts(profile.id);

    return {
      message: 'Payout method registered successfully.',
      data: {
        accountName,
        accountNameVerified: verified,
        payoutsRetried: held.retried,
        payoutsStillOnHold: held.stillOnHold,
      },
    };
  }

  /**
   * Payout name check: once the artisan saves new payout details, retries
   * their payouts held for a name that didn't match or an account that
   * couldn't be found. Each goes through {@link capturePayment}, so the new
   * details are checked again before anything is sent. Best-effort: a
   * failure here never fails the save (the artisan can still retry).
   */
  private async retryHeldPayouts(
    artisanProfileId: number,
  ): Promise<{ retried: number; stillOnHold: number }> {
    let held: Payment[];
    try {
      held = await this.repo.find({
        where: {
          artisanProfileId,
          status: PaymentStatus.PENDING_TRANSFER,
          payoutHoldReason: In([...ARTISAN_ACTION_HOLDS]),
        },
        order: { id: 'ASC' },
        take: HELD_PAYOUT_RETRY_LIMIT,
      });
    } catch (err) {
      this.logger.error(
        `Could not list held payouts for artisan ${artisanProfileId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { retried: 0, stillOnHold: 0 };
    }
    let stillOnHold = 0;
    for (const p of held) {
      try {
        await this.capturePayment(p.reference, p.jobId);
      } catch (err) {
        this.logger.error(
          `Retry of held payout ${p.id} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      const after = await this.repo
        .findOne({ where: { id: p.id } })
        .catch(() => null);
      if (after && needsArtisanAction(after.payoutHoldReason)) stillOnHold++;
    }
    if (held.length > 0) {
      this.logger.log(
        `Retried ${held.length} held payout(s) for artisan ${artisanProfileId}; ${stillOnHold} still on hold.`,
      );
    }
    return { retried: held.length, stillOnHold };
  }

  /**
   * Payout name check: the scheduler's retry of payouts whose check couldn't
   * be made (Paystack unavailable), once each one's backoff has passed. Each
   * goes through {@link capturePayment}, which re-checks the state under the
   * lock, so a payout already sent or retried elsewhere is left alone.
   */
  async retryDuePayoutChecks(
    now: Date = new Date(),
  ): Promise<{ candidates: number; sent: number; failed: number }> {
    const due = await this.repo.find({
      where: {
        status: PaymentStatus.PENDING_TRANSFER,
        payoutHoldReason: PAYOUT_CHECK_PENDING,
        payoutCheckNextAt: LessThanOrEqual(now),
      },
      order: { payoutCheckNextAt: 'ASC' },
      take: PAYOUT_CHECK_BATCH,
    });
    let sent = 0;
    let failed = 0;
    for (const p of due) {
      try {
        await this.capturePayment(p.reference, p.jobId);
        const after = await this.repo.findOne({ where: { id: p.id } });
        if (after?.transferCode && after.status === PaymentStatus.HELD) sent++;
      } catch (err) {
        failed++;
        this.logger.error(
          `Payout check retry for payment ${p.id} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return { candidates: due.length, sent, failed };
  }

  async retryPendingTransfer(artisanUserId: number, jobId: number) {
    const profile = await this.profileRepo.findOne({
      where: { user: { id: artisanUserId } },
    });
    if (!profile) throw new NotFoundException('Artisan profile not found.');

    // Retryable from PENDING_TRANSFER (no payout method was on file at
    // completion time) or TRANSFER_FAILED (a transfer was attempted but
    // Paystack reported transfer.failed/transfer.reversed, or the initiate
    // call itself errored).
    const payment = await this.repo.findOne({
      where: {
        jobId,
        artisanProfileId: profile.id,
        status: In([
          PaymentStatus.PENDING_TRANSFER,
          PaymentStatus.TRANSFER_FAILED,
        ]),
      },
    });
    if (!payment)
      throw new NotFoundException(
        'No retryable transfer for this job on your account.',
      );
    await this.capturePayment(payment.reference, jobId);

    // Payout name check: say so when nothing was sent, rather than "retry
    // initiated" for a payout that is still on hold.
    const after = await this.repo.findOne({ where: { id: payment.id } });
    if (after?.status === PaymentStatus.PENDING_TRANSFER) {
      if (after.payoutHoldReason === PAYOUT_NAME_MISMATCH) {
        throw new UnprocessableEntityException(PAYOUT_NAME_MISMATCH_MESSAGE);
      }
      if (after.payoutHoldReason === PAYOUT_ACCOUNT_NOT_FOUND) {
        throw new UnprocessableEntityException(
          PAYOUT_ACCOUNT_NOT_FOUND_MESSAGE,
        );
      }
      if (after.payoutHoldReason === PAYOUT_CHECK_PENDING) {
        throw new ServiceUnavailableException(PAYOUT_CHECK_PENDING_MESSAGE);
      }
    }
    return { message: 'Transfer retry initiated.' };
  }
}

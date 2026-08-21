import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { DataSource, In, Repository } from 'typeorm';
import { Payment } from './entities/payment.entity';
import { PaystackService } from './paystack.service';
import { Job } from '@jobs/entities/job.entity';
import { User } from '@users/entities/user.entity';
import { ArtisanProfile } from '@users/entities/artisan-profile.entity';
import { PaymentStatus, PayoutType } from '@common/types/enums';

/** security-report.md finding #8: hard upper bound on admin list `limit`. */
const MAX_ADMIN_PAGE_LIMIT = 100;

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
   */
  async holdPayment(
    jobId: number,
    customerId: number,
    acceptedArtisanId: number,
    amount?: number,
  ): Promise<string> {
    const job = await this.jobRepo.findOne({ where: { id: jobId } });
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

    const profile = await this.profileRepo.findOne({
      where: { user: { id: acceptedArtisanId } },
    });
    if (!profile)
      throw new NotFoundException('Artisan profile not found for this job.');

    const agreedAmount = +(amount ?? job.budgetMax ?? 0);
    const platformFee = +(
      (agreedAmount * this.platformFeePercent) /
      100
    ).toFixed(2);
    const artisanAmt = +(agreedAmount - platformFee).toFixed(2);

    const reference = `jinva-${jobId}-${customerId}-${Date.now()}`;

    await this.repo.save(
      this.repo.create({
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
   * Initiates the Paystack transfer to the artisan.
   * Called by JobsService when the customer confirms job completion, and by
   * {@link retryPendingTransfer} for an artisan-triggered retry.
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
   * The Paystack call is deliberately made *inside* this transaction/lock
   * (not after commit) specifically so a concurrent caller cannot start a
   * second attempt while the first is in flight. If the transfer call
   * itself throws, we still want the TRANSFER_FAILED status write to
   * persist, so the error is captured and re-thrown *after* the transaction
   * block resolves rather than thrown from inside it (which would roll the
   * status change back too).
   */
  async capturePayment(reference: string, jobId: number): Promise<void> {
    let captureError: Error | undefined;

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

      const profile = await manager.getRepository(ArtisanProfile).findOne({
        where: { id: payment.artisanProfileId },
      });
      if (!profile?.paystackRecipientCode) {
        this.logger.warn(
          `Artisan ${payment.artisanProfileId} has no payout method — marking PENDING_TRANSFER`,
        );
        payment.status = PaymentStatus.PENDING_TRANSFER;
        await paymentRepo.save(payment);
        return;
      }

      // Reset to HELD before (re)attempting — this is the "transfer in flight"
      // base state; the webhook flips it to RELEASED on success or this method
      // flips it to TRANSFER_FAILED below if the attempt itself errors out.
      payment.status = PaymentStatus.HELD;
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
      }
    });

    if (captureError) throw captureError;
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
  async cancelPayment(reference: string, _jobId: number): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const paymentRepo = manager.getRepository(Payment);
      const payment = await paymentRepo.findOne({
        where: { reference },
        lock: { mode: 'pessimistic_write' },
      });
      if (!payment) return;

      if (payment.status === PaymentStatus.HELD) {
        await this.paystack.createRefund(payment.reference, payment.amount);
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
  async initializePayment(customerId: number, jobId: number) {
    const payment = await this.repo.findOne({
      where: { jobId, customerId, status: PaymentStatus.PENDING },
    });
    if (!payment) {
      throw new NotFoundException(
        'No pending payment found for this job. Has the artisan accepted yet?',
      );
    }

    if (payment.authorizationUrl && payment.accessCode) {
      return {
        message:
          'Payment already initialized. Redirect the customer to the authorization URL.',
        data: {
          reference: payment.reference,
          authorizationUrl: payment.authorizationUrl,
          accessCode: payment.accessCode,
          amount: payment.amount,
          currency: payment.currency,
        },
      };
    }

    const customer = await this.userRepo.findOneOrFail({
      where: { id: customerId },
    });

    let result: {
      authorization_url: string;
      access_code: string;
      reference: string;
    };
    try {
      result = await this.paystack.initializeTransaction({
        email: customer.email,
        amountGhs: payment.amount,
        reference: payment.reference,
        callbackUrl: this.config.get('PAYSTACK_CALLBACK_URL'),
        metadata: { jobId: payment.jobId, customerId, paymentId: payment.id },
      });
    } catch (err) {
      // requirements.md API-needs item #7 / qa-report.md's own suggested
      // direction: translate Paystack's specific "duplicate reference"
      // rejection into a clean, customer-facing error instead of the
      // generic InternalServerErrorException PaystackService throws on any
      // non-`status:true` response. This can still happen even with the
      // reuse-check above on a genuine race — two near-simultaneous
      // `initialize` calls for the same payment, both reading a still-empty
      // `authorizationUrl` before either has saved. Re-check the row first:
      // the racing call may have already won and persisted a usable session.
      if (
        err instanceof Error &&
        /duplicate transaction reference/i.test(err.message)
      ) {
        const refreshed = await this.repo.findOne({
          where: { id: payment.id },
        });
        if (refreshed?.authorizationUrl && refreshed?.accessCode) {
          return {
            message:
              'Payment already initialized. Redirect the customer to the authorization URL.',
            data: {
              reference: refreshed.reference,
              authorizationUrl: refreshed.authorizationUrl,
              accessCode: refreshed.accessCode,
              amount: refreshed.amount,
              currency: refreshed.currency,
            },
          };
        }
        throw new BadRequestException(
          'A payment attempt for this job is already being processed. Please wait a moment and try again.',
        );
      }
      throw err;
    }

    payment.authorizationUrl = result.authorization_url;
    payment.accessCode = result.access_code;
    await this.repo.save(payment);

    return {
      message:
        'Payment initialized. Redirect the customer to the authorization URL.',
      data: {
        reference: payment.reference,
        authorizationUrl: result.authorization_url,
        accessCode: result.access_code,
        amount: payment.amount,
        currency: payment.currency,
      },
    };
  }

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
      job: { id: p.job?.id ?? p.jobId, title: p.job?.title ?? null },
      amount: p.amount,
      currency: p.currency,
      status: p.status,
      refundedAmount: p.refundedAmount ?? 0,
      paidAt: p.paidAt ?? null,
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
  async verifyPayment(customerId: number, reference: string) {
    const payment = await this.repo.findOne({ where: { reference } });
    if (!payment || payment.customerId !== customerId) {
      throw new NotFoundException('Payment not found.');
    }

    const remote = await this.paystack.verifyTransaction(reference);

    // Reconcile: if Paystack confirms success and our webhook hasn't landed
    // yet, flip to HELD right now instead of leaving the customer staring at
    // a stale PENDING. We deliberately do NOT set a FAILED/CANCELLED state on
    // a failed/abandoned remote status — the payment stays PENDING so the
    // customer can simply try "Pay Now" again (matching the documented
    // mid-flow-failure behavior).
    if (
      remote.status === 'success' &&
      payment.status === PaymentStatus.PENDING
    ) {
      // security-report.md finding #6: never trust a reference match alone —
      // confirm Paystack actually reports the same amount/currency we
      // recorded at holdPayment time before flipping to HELD. A mismatch is
      // logged and routed to manual review (payment left PENDING) instead of
      // being auto-reconciled.
      const expectedPesewas = Math.round(Number(payment.amount) * 100);
      if (remote.amount !== expectedPesewas || remote.currency !== 'GHS') {
        this.logger.error(
          `verifyPayment: amount/currency mismatch for ref=${reference} — ` +
            `Paystack reports ${remote.amount} ${remote.currency}, expected ${expectedPesewas} GHS pesewas. ` +
            `Leaving PENDING for manual review instead of auto-reconciling.`,
        );
      } else {
        payment.status = PaymentStatus.HELD;
        payment.channel = remote.channel;
        payment.paidAt = remote.paid_at ? new Date(remote.paid_at) : new Date();
        await this.repo.save(payment);
      }
    }

    return {
      message: 'Payment verification complete.',
      data: {
        reference: payment.reference,
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
    }));

    return { message: 'Earnings history retrieved.', data };
  }

  // ─── Admin-facing ─────────────────────────────────────────────────────────────

  async getAllPayments(page = 1, limit = 20) {
    // security-report.md finding #8: clamp regardless of what's requested —
    // an admin session (or a compromised admin token) could otherwise force
    // an unbounded `findAndCount`.
    const safePage = Math.max(1, page || 1);
    const safeLimit = Math.min(Math.max(1, limit || 20), MAX_ADMIN_PAGE_LIMIT);
    const [records, total] = await this.repo.findAndCount({
      relations: ['job', 'customer'],
      order: { createdAt: 'DESC' },
      skip: (safePage - 1) * safeLimit,
      take: safeLimit,
    });
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
  async adminRefund(paymentId: number, amountGhs?: number) {
    return this.dataSource.transaction(async (manager) => {
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

      await this.paystack.createRefund(payment.reference, refundAmount);
      payment.refundedAmount = +(alreadyRefunded + refundAmount).toFixed(2);
      if (payment.refundedAmount >= Number(payment.amount)) {
        payment.status = PaymentStatus.REFUNDED;
      }
      await paymentRepo.save(payment);
      return { message: 'Refund initiated.' };
    });
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
    }
  }

  private async onChargeSuccess(data: Record<string, unknown>) {
    const reference = data.reference as string;
    const payment = await this.repo.findOne({ where: { reference } });
    if (!payment) {
      this.logger.warn(`charge.success: no payment for reference ${reference}`);
      return;
    }

    // security-report.md finding #6: cross-check the amount/currency
    // Paystack reports as paid against what we recorded at holdPayment time
    // before trusting "success" — a reference match alone isn't a
    // sufficient guarantee the correct amount was actually charged.
    const paidAmountPesewas = Number(data.amount);
    const paidCurrency = (data.currency as string | undefined) ?? 'GHS';
    const expectedPesewas = Math.round(Number(payment.amount) * 100);
    if (paidAmountPesewas !== expectedPesewas || paidCurrency !== 'GHS') {
      this.logger.error(
        `charge.success: amount/currency mismatch for ref=${reference} — ` +
          `Paystack reports ${paidAmountPesewas} ${paidCurrency}, expected ${expectedPesewas} GHS pesewas. ` +
          `Refusing to auto-reconcile; needs manual review.`,
      );
      return;
    }

    payment.status = PaymentStatus.HELD;
    payment.channel = data.channel as string;
    payment.paidAt = new Date(data.paid_at as string);
    await this.repo.save(payment);
    this.logger.log(
      `Payment HELD: ref=${reference} channel=${payment.channel}`,
    );
  }

  private async onTransferSuccess(data: Record<string, unknown>) {
    const reference = data.reference as string;
    const payment = await this.repo.findOne({
      where: { transferReference: reference },
    });
    if (!payment) return;
    payment.status = PaymentStatus.RELEASED;
    payment.releasedAt = new Date();
    await this.repo.save(payment);
    this.logger.log(`Payment RELEASED: job=${payment.jobId}`);
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

    payment.status = PaymentStatus.TRANSFER_FAILED;
    await this.repo.save(payment);
    this.logger.warn(
      `Payment marked TRANSFER_FAILED: job=${payment.jobId} ref=${reference} — retryable via retry-transfer.`,
    );
  }

  // ─── Artisan payout setup ─────────────────────────────────────────────────────

  /**
   * Registers the artisan's mobile money or bank account with Paystack and
   * stores the recipient_code on their profile for future payouts.
   */
  async setupPayoutMethod(
    artisanUserId: number,
    dto: {
      type: 'mobile_money' | 'bank';
      accountName: string;
      accountNumber: string;
      bankCode: string;
    },
  ) {
    const profile = await this.profileRepo.findOne({
      where: { user: { id: artisanUserId } },
    });
    if (!profile) throw new NotFoundException('Artisan profile not found.');

    const paystackType =
      dto.type === 'mobile_money' ? 'mobile_money' : 'ghipss';
    const recipient = await this.paystack.createTransferRecipient({
      type: paystackType,
      name: dto.accountName,
      accountNumber: dto.accountNumber,
      bankCode: dto.bankCode,
    });

    profile.payoutType =
      dto.type === 'mobile_money' ? PayoutType.MOBILE_MONEY : PayoutType.BANK;
    profile.paystackRecipientCode = recipient.recipient_code;
    profile.payoutAccountName = dto.accountName;
    profile.payoutAccountNumber = dto.accountNumber;
    profile.payoutBankCode = dto.bankCode;
    await this.profileRepo.save(profile);

    return { message: 'Payout method registered successfully.' };
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
    return { message: 'Transfer retry initiated.' };
  }
}

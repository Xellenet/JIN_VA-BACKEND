import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { Repository } from 'typeorm';
import { Payment } from './entities/payment.entity';
import { PaystackService } from './paystack.service';
import { Job } from '@jobs/entities/job.entity';
import { User } from '@users/entities/user.entity';
import { ArtisanProfile } from '@users/entities/artisan-profile.entity';
import { PaymentStatus, PayoutType } from '@common/types/enums';

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    @InjectRepository(Payment)
    private readonly repo: Repository<Payment>,
    @InjectRepository(Job)
    private readonly jobRepo: Repository<Job>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    @InjectRepository(ArtisanProfile)
    private readonly profileRepo: Repository<ArtisanProfile>,
    private readonly paystack: PaystackService,
    private readonly config: ConfigService,
  ) {}

  // ─── Called internally by JobsService ────────────────────────────────────────

  /**
   * Creates a PENDING payment record when an artisan accepts a job.
   * The customer then calls POST /payments/initialize to get the Paystack payment URL.
   */
  async holdPayment(jobId: number, customerId: number, amount?: number): Promise<string> {
    const job = await this.jobRepo.findOne({ where: { id: jobId } });
    if (!job) throw new NotFoundException('Job not found.');

    if (!job.acceptedArtisanId) {
      throw new BadRequestException('Job has no accepted artisan yet.');
    }

    const profile = await this.profileRepo.findOne({
      where: { user: { id: job.acceptedArtisanId } },
    });
    if (!profile) throw new NotFoundException('Artisan profile not found for this job.');

    const feePercent  = this.config.get<number>('PLATFORM_FEE_PERCENT', 5);
    const agreedAmount = +(amount ?? job.budgetMax ?? 0);
    const platformFee  = +(agreedAmount * feePercent / 100).toFixed(2);
    const artisanAmt   = +(agreedAmount - platformFee).toFixed(2);

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
   * Called by JobsService when the customer confirms job completion.
   */
  async capturePayment(reference: string, jobId: number): Promise<void> {
    const payment = await this.repo.findOne({ where: { reference } });
    if (!payment) {
      this.logger.warn(`capturePayment: no payment for ref=${reference}`);
      return;
    }
    if (payment.status !== PaymentStatus.HELD) {
      this.logger.warn(`capturePayment: payment ${reference} is ${payment.status}, not HELD`);
      return;
    }

    const profile = await this.profileRepo.findOne({ where: { id: payment.artisanProfileId } });
    if (!profile?.paystackRecipientCode) {
      this.logger.warn(`Artisan ${payment.artisanProfileId} has no payout method — marking PENDING_TRANSFER`);
      payment.status = PaymentStatus.PENDING_TRANSFER;
      await this.repo.save(payment);
      return;
    }

    const transferRef = `jinva-tr-${jobId}-${Date.now()}`;
    payment.transferReference = transferRef;
    await this.repo.save(payment);

    const transfer = await this.paystack.initiateTransfer({
      amountGhs: payment.artisanAmount,
      recipientCode: profile.paystackRecipientCode,
      reference: transferRef,
      reason: `JinVa payout for job #${jobId}`,
    });

    payment.transferCode = transfer.transfer_code;
    await this.repo.save(payment);
    this.logger.log(`Transfer initiated: job=${jobId} amount=${payment.artisanAmount} GHS code=${transfer.transfer_code}`);
  }

  /**
   * Refunds or cancels the payment when a job is cancelled.
   * If the customer already paid (HELD), a Paystack refund is issued.
   */
  async cancelPayment(reference: string, jobId: number): Promise<void> {
    const payment = await this.repo.findOne({ where: { reference } });
    if (!payment) return;

    if (payment.status === PaymentStatus.HELD) {
      await this.paystack.createRefund(payment.reference, payment.amount);
      payment.status = PaymentStatus.REFUNDED;
    } else if (payment.status === PaymentStatus.PENDING) {
      payment.status = PaymentStatus.CANCELLED;
    }
    await this.repo.save(payment);
  }

  // ─── Customer-facing HTTP endpoints ──────────────────────────────────────────

  /**
   * Returns the Paystack authorization URL for the customer to complete payment.
   * The PENDING payment record must already exist (created by holdPayment).
   */
  async initializePayment(customerId: number, jobId: number) {
    const payment = await this.repo.findOne({
      where: { jobId, customerId, status: PaymentStatus.PENDING },
    });
    if (!payment) {
      throw new NotFoundException('No pending payment found for this job. Has the artisan accepted yet?');
    }

    const customer = await this.userRepo.findOneOrFail({ where: { id: customerId } });

    const result = await this.paystack.initializeTransaction({
      email: customer.email,
      amountGhs: payment.amount,
      reference: payment.reference,
      callbackUrl: this.config.get('PAYSTACK_CALLBACK_URL'),
      metadata: { jobId: payment.jobId, customerId, paymentId: payment.id },
    });

    payment.authorizationUrl = result.authorization_url;
    payment.accessCode       = result.access_code;
    await this.repo.save(payment);

    return {
      message: 'Payment initialized. Redirect the customer to the authorization URL.',
      data: {
        reference:        payment.reference,
        authorizationUrl: result.authorization_url,
        accessCode:       result.access_code,
        amount:           payment.amount,
        currency:         payment.currency,
      },
    };
  }

  async getMyHistory(customerId: number) {
    const payments = await this.repo.find({
      where: { customerId },
      relations: ['job'],
      order: { createdAt: 'DESC' },
    });
    return { message: 'Payment history retrieved.', data: payments };
  }

  // ─── Admin-facing ─────────────────────────────────────────────────────────────

  async getAllPayments(page = 1, limit = 20) {
    const [records, total] = await this.repo.findAndCount({
      relations: ['job', 'customer'],
      order: { createdAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });
    return {
      message: 'Payments retrieved.',
      data: records,
      pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  async adminRefund(paymentId: number, amountGhs?: number) {
    const payment = await this.repo.findOneOrFail({ where: { id: paymentId } });
    if (payment.status !== PaymentStatus.HELD && payment.status !== PaymentStatus.RELEASED) {
      throw new BadRequestException(`Cannot refund a payment with status ${payment.status}.`);
    }
    await this.paystack.createRefund(payment.reference, amountGhs);
    payment.status = PaymentStatus.REFUNDED;
    await this.repo.save(payment);
    return { message: 'Refund initiated.' };
  }

  // ─── Paystack webhook processor ──────────────────────────────────────────────

  async processWebhook(rawBody: string, signature: string): Promise<void> {
    if (!this.paystack.verifyWebhookSignature(rawBody, signature)) {
      this.logger.warn('Paystack webhook: invalid signature — ignored');
      return;
    }

    const event = JSON.parse(rawBody) as { event: string; data: Record<string, unknown> };
    this.logger.log(`Paystack webhook: ${event.event}`);

    switch (event.event) {
      case 'charge.success':     return this.onChargeSuccess(event.data);
      case 'transfer.success':   return this.onTransferSuccess(event.data);
      case 'transfer.failed':
      case 'transfer.reversed':  return this.onTransferFailed(event.event, event.data);
    }
  }

  private async onChargeSuccess(data: Record<string, unknown>) {
    const reference = data.reference as string;
    const payment = await this.repo.findOne({ where: { reference } });
    if (!payment) {
      this.logger.warn(`charge.success: no payment for reference ${reference}`);
      return;
    }
    payment.status    = PaymentStatus.HELD;
    payment.channel   = data.channel as string;
    payment.paidAt    = new Date(data.paid_at as string);
    await this.repo.save(payment);
    this.logger.log(`Payment HELD: ref=${reference} channel=${payment.channel}`);
  }

  private async onTransferSuccess(data: Record<string, unknown>) {
    const reference = data.reference as string;
    const payment = await this.repo.findOne({ where: { transferReference: reference } });
    if (!payment) return;
    payment.status     = PaymentStatus.RELEASED;
    payment.releasedAt = new Date();
    await this.repo.save(payment);
    this.logger.log(`Payment RELEASED: job=${payment.jobId}`);
  }

  private async onTransferFailed(event: string, data: Record<string, unknown>) {
    this.logger.error(`Transfer ${event}: ${JSON.stringify(data)}`);
  }

  // ─── Artisan payout setup ─────────────────────────────────────────────────────

  /**
   * Registers the artisan's mobile money or bank account with Paystack and
   * stores the recipient_code on their profile for future payouts.
   */
  async setupPayoutMethod(artisanUserId: number, dto: {
    type: 'mobile_money' | 'bank';
    accountName: string;
    accountNumber: string;
    bankCode: string;
  }) {
    const profile = await this.profileRepo.findOne({ where: { user: { id: artisanUserId } } });
    if (!profile) throw new NotFoundException('Artisan profile not found.');

    const paystackType = dto.type === 'mobile_money' ? 'mobile_money' : 'ghipss';
    const recipient = await this.paystack.createTransferRecipient({
      type: paystackType,
      name: dto.accountName,
      accountNumber: dto.accountNumber,
      bankCode: dto.bankCode,
    });

    profile.payoutType             = dto.type === 'mobile_money' ? PayoutType.MOBILE_MONEY : PayoutType.BANK;
    profile.paystackRecipientCode  = recipient.recipient_code;
    profile.payoutAccountName      = dto.accountName;
    profile.payoutAccountNumber    = dto.accountNumber;
    profile.payoutBankCode         = dto.bankCode;
    await this.profileRepo.save(profile);

    return { message: 'Payout method registered successfully.' };
  }

  async retryPendingTransfer(jobId: number) {
    const payment = await this.repo.findOne({
      where: { jobId, status: PaymentStatus.PENDING_TRANSFER },
    });
    if (!payment) throw new NotFoundException('No pending transfer for this job.');
    await this.capturePayment(payment.reference, jobId);
    return { message: 'Transfer retry initiated.' };
  }
}

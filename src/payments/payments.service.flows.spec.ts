import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  BadRequestException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { PaymentsService } from './payments.service';
import { Payment } from './entities/payment.entity';
import { Job } from '@jobs/entities/job.entity';
import { User } from '@users/entities/user.entity';
import { ArtisanProfile } from '@users/entities/artisan-profile.entity';
import { PaystackService } from './paystack.service';
import { AdminAuditService } from '../admin-audit/admin-audit.service';
import {
  AdminActionType,
  PaymentStatus,
  PayoutType,
} from '@common/types/enums';
import { APP_EVENTS } from '@common/events/app.events';

/**
 * Decision branches of PaymentsService beyond initializePayment's happy path:
 * escrow holds, captures/transfers, cancellations, refunds, webhooks and the
 * admin tools. Every collaborator is mocked; transactions run their callback
 * against an in-memory manager whose repositories are the mocks below.
 */
describe('PaymentsService (flows)', () => {
  let service: PaymentsService;

  const mockRepo = () => ({
    create: jest.fn((x: unknown) => x),
    save: jest.fn((x: unknown) => Promise.resolve(x)),
    find: jest.fn(),
    findOne: jest.fn(),
    findOneOrFail: jest.fn(),
    query: jest.fn(),
    createQueryBuilder: jest.fn(),
  });

  let paymentRepo: ReturnType<typeof mockRepo>;
  let jobRepo: ReturnType<typeof mockRepo>;
  let userRepo: ReturnType<typeof mockRepo>;
  let profileRepo: ReturnType<typeof mockRepo>;
  /** Repositories handed out by the transaction's EntityManager. */
  let txPaymentRepo: ReturnType<typeof mockRepo>;
  let txProfileRepo: ReturnType<typeof mockRepo>;
  let manager: { getRepository: jest.Mock };

  const paystack = {
    initializeTransaction: jest.fn(),
    verifyTransaction: jest.fn(),
    createRefund: jest.fn(),
    createTransferRecipient: jest.fn(),
    initiateTransfer: jest.fn(),
    verifyWebhookSignature: jest.fn(),
  };
  let feeSetting: unknown;
  const config = {
    get: jest.fn((key: string, fallback?: unknown) => {
      if (key === 'PLATFORM_FEE_PERCENT') return feeSetting;
      if (key === 'PAYSTACK_CALLBACK_URL') return 'https://app.example.com/pay';
      return fallback;
    }),
  };
  const dataSource = { transaction: jest.fn() };
  const events = { emit: jest.fn() };
  const audit = { record: jest.fn() };

  const admin = {
    id: 1,
    firstname: 'Ada',
    lastname: 'Admin',
    email: 'admin@example.com',
  } as User;

  const payment = (overrides: Partial<Payment> = {}) =>
    ({
      id: 7,
      jobId: 35,
      customerId: 22,
      artisanProfileId: 4,
      amount: 100,
      platformFee: 5,
      artisanAmount: 95,
      currency: 'GHS',
      reference: 'jinva-35-22-111',
      status: PaymentStatus.HELD,
      refundedAmount: 0,
      fraudFlagged: false,
      ...overrides,
    }) as Payment;

  const build = async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentsService,
        { provide: getRepositoryToken(Payment), useValue: paymentRepo },
        { provide: getRepositoryToken(Job), useValue: jobRepo },
        { provide: getRepositoryToken(User), useValue: userRepo },
        { provide: getRepositoryToken(ArtisanProfile), useValue: profileRepo },
        { provide: getDataSourceToken(), useValue: dataSource },
        { provide: PaystackService, useValue: paystack },
        { provide: ConfigService, useValue: config },
        { provide: EventEmitter2, useValue: events },
        { provide: AdminAuditService, useValue: audit },
      ],
    }).compile();
    return module.get(PaymentsService);
  };

  /** Make the artisan resolvable for notification payloads. */
  const withArtisanContext = (artisanUser: Partial<User> | null) => {
    jobRepo.findOne.mockResolvedValue({ id: 35, title: 'Fix kitchen sink' });
    profileRepo.findOne.mockResolvedValue({ id: 4, user: artisanUser });
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    feeSetting = 5;
    paymentRepo = mockRepo();
    jobRepo = mockRepo();
    userRepo = mockRepo();
    profileRepo = mockRepo();
    txPaymentRepo = mockRepo();
    txProfileRepo = mockRepo();
    manager = {
      getRepository: jest.fn((entity: unknown) =>
        entity === Payment ? txPaymentRepo : txProfileRepo,
      ),
    };
    dataSource.transaction.mockImplementation(
      (cb: (m: typeof manager) => unknown) => cb(manager),
    );
    audit.record.mockResolvedValue(undefined);
    service = await build();
  });

  describe('platform fee configuration', () => {
    it('coerces a string env value and exposes it', async () => {
      feeSetting = '7.5';
      service = await build();
      expect(service.getPlatformFeePercent()).toBe(7.5);
    });

    it.each(['abc', -1, 101])(
      'refuses to start with PLATFORM_FEE_PERCENT=%p',
      async (value) => {
        feeSetting = value;
        await expect(build()).rejects.toThrow(
          'PLATFORM_FEE_PERCENT must be a number between 0 and 100',
        );
      },
    );
  });

  describe('holdPayment', () => {
    const ghsJob = { id: 35, currency: 'GHS', budgetMax: 200 };

    it('throws NotFoundException when the job does not exist', async () => {
      jobRepo.findOne.mockResolvedValue(null);
      await expect(service.holdPayment(35, 22, 9)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('refuses a job with no accepted artisan', async () => {
      jobRepo.findOne.mockResolvedValue(ghsJob);
      await expect(service.holdPayment(35, 22, 0)).rejects.toThrow(
        'Job has no accepted artisan yet.',
      );
    });

    it('refuses a non-GHS job rather than charging the wrong currency', async () => {
      jobRepo.findOne.mockResolvedValue({ ...ghsJob, currency: 'USD' });
      await expect(service.holdPayment(35, 22, 9)).rejects.toThrow(
        'job currency is USD, not GHS',
      );
    });

    it('throws NotFoundException when the artisan has no profile', async () => {
      jobRepo.findOne.mockResolvedValue(ghsJob);
      profileRepo.findOne.mockResolvedValue(null);
      await expect(service.holdPayment(35, 22, 9)).rejects.toThrow(
        'Artisan profile not found for this job.',
      );
    });

    it('refuses a zero price so no unpayable payment is created', async () => {
      jobRepo.findOne.mockResolvedValue({ ...ghsJob, budgetMax: null });
      profileRepo.findOne.mockResolvedValue({ id: 4 });
      await expect(service.holdPayment(35, 22, 9)).rejects.toThrow(
        BadRequestException,
      );
      expect(paymentRepo.save).not.toHaveBeenCalled();
    });

    it('creates a PENDING payment with the fee split, falling back to budgetMax', async () => {
      jobRepo.findOne.mockResolvedValue(ghsJob);
      profileRepo.findOne.mockResolvedValue({ id: 4 });

      const ref = await service.holdPayment(35, 22, 9);

      expect(ref).toMatch(/^jinva-35-22-\d+$/);
      expect(paymentRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          jobId: 35,
          customerId: 22,
          artisanProfileId: 4,
          amount: 200,
          platformFee: 10,
          artisanAmount: 190,
          currency: 'GHS',
          status: PaymentStatus.PENDING,
          reference: ref,
        }),
      );
    });

    it("uses the caller's transaction manager and the agreed amount", async () => {
      // Job and ArtisanProfile share one mock here: job lookup, then profile.
      const jobAndProfile = mockRepo();
      jobAndProfile.findOne
        .mockResolvedValueOnce(ghsJob)
        .mockResolvedValueOnce({ id: 4 });
      const txPayments = mockRepo();
      const txManager = {
        getRepository: jest.fn((e: unknown) =>
          e === Payment ? txPayments : jobAndProfile,
        ),
      } as unknown as EntityManager;

      await service.holdPayment(35, 22, 9, 80.5, txManager);

      expect(jobRepo.findOne).not.toHaveBeenCalled();
      expect(paymentRepo.save).not.toHaveBeenCalled();
      expect(txPayments.save).toHaveBeenCalledWith(
        expect.objectContaining({
          amount: 80.5,
          platformFee: 4.03,
          artisanAmount: 76.47,
        }),
      );
    });
  });

  describe('capturePayment', () => {
    it('does nothing when the reference is unknown', async () => {
      txPaymentRepo.findOne.mockResolvedValue(null);
      await service.capturePayment('jinva-missing', 35);
      expect(txPaymentRepo.save).not.toHaveBeenCalled();
      expect(paystack.initiateTransfer).not.toHaveBeenCalled();
    });

    it('skips a duplicate capture when a transfer is already in flight', async () => {
      txPaymentRepo.findOne.mockResolvedValue(
        payment({ transferCode: 'TRF_existing' }),
      );
      await service.capturePayment('jinva-35-22-111', 35);
      expect(paystack.initiateTransfer).not.toHaveBeenCalled();
      expect(txPaymentRepo.save).not.toHaveBeenCalled();
    });

    it.each([
      PaymentStatus.PENDING,
      PaymentStatus.RELEASED,
      PaymentStatus.REFUNDED,
    ])('does not capture a %s payment', async (status) => {
      txPaymentRepo.findOne.mockResolvedValue(payment({ status }));
      await service.capturePayment('jinva-35-22-111', 35);
      expect(paystack.initiateTransfer).not.toHaveBeenCalled();
    });

    it('parks the payment as PENDING_TRANSFER when the artisan has no payout method', async () => {
      const p = payment();
      txPaymentRepo.findOne.mockResolvedValue(p);
      txProfileRepo.findOne.mockResolvedValue({ id: 4 });

      await service.capturePayment(p.reference, 35);

      expect(p.status).toBe(PaymentStatus.PENDING_TRANSFER);
      expect(txPaymentRepo.save).toHaveBeenCalledWith(p);
      expect(paystack.initiateTransfer).not.toHaveBeenCalled();
    });

    it('initiates the transfer and records the transfer code, staying HELD', async () => {
      const p = payment({ status: PaymentStatus.TRANSFER_FAILED });
      txPaymentRepo.findOne.mockResolvedValue(p);
      txProfileRepo.findOne.mockResolvedValue({
        id: 4,
        paystackRecipientCode: 'RCP_unit',
      });
      paystack.initiateTransfer.mockResolvedValue({
        transfer_code: 'TRF_new',
      });

      await service.capturePayment(p.reference, 35);

      expect(paystack.initiateTransfer).toHaveBeenCalledWith({
        amountGhs: 95,
        recipientCode: 'RCP_unit',
        reference: expect.stringMatching(/^jinva-tr-35-\d+$/) as string,
        reason: 'JinVa payout for job #35',
      });
      expect(p.status).toBe(PaymentStatus.HELD);
      expect(p.transferCode).toBe('TRF_new');
      expect(p.transferReference).toMatch(/^jinva-tr-35-/);
      expect(events.emit).not.toHaveBeenCalled();
    });

    it('marks TRANSFER_FAILED, alerts admins after commit, and rethrows when the transfer call fails', async () => {
      const p = payment();
      txPaymentRepo.findOne.mockResolvedValue(p);
      txProfileRepo.findOne.mockResolvedValue({
        id: 4,
        paystackRecipientCode: 'RCP_unit',
      });
      paystack.initiateTransfer.mockRejectedValue(
        new Error('Insufficient balance'),
      );
      withArtisanContext({ id: 9, firstname: 'Kofi', lastname: 'Mensah' });

      await expect(service.capturePayment(p.reference, 35)).rejects.toThrow(
        'Insufficient balance',
      );

      expect(p.status).toBe(PaymentStatus.TRANSFER_FAILED);
      expect(p.transferCode).toBeUndefined();
      expect(events.emit).toHaveBeenCalledWith(
        APP_EVENTS.PAYMENT_TRANSFER_FAILED,
        {
          paymentId: 7,
          jobId: 35,
          jobTitle: 'Fix kitchen sink',
          artisanName: 'Kofi Mensah',
          artisanAmount: 95,
          reason: 'Insufficient balance',
        },
      );
    });

    it('wraps a non-Error rejection so callers still get an Error', async () => {
      txPaymentRepo.findOne.mockResolvedValue(payment());
      txProfileRepo.findOne.mockResolvedValue({
        id: 4,
        paystackRecipientCode: 'RCP_unit',
      });
      paystack.initiateTransfer.mockRejectedValue('gateway down');
      // Notification context lookup fails too; that must not mask the error.
      jobRepo.findOne.mockRejectedValue(new Error('db gone'));

      await expect(
        service.capturePayment('jinva-35-22-111', 35),
      ).rejects.toThrow(new Error('gateway down'));
      expect(events.emit).not.toHaveBeenCalled();
    });
  });

  describe('isPaymentSecured', () => {
    it('is true only for a HELD payment', async () => {
      paymentRepo.findOne.mockResolvedValueOnce(payment());
      await expect(service.isPaymentSecured('r')).resolves.toBe(true);
      paymentRepo.findOne.mockResolvedValueOnce(
        payment({ status: PaymentStatus.PENDING }),
      );
      await expect(service.isPaymentSecured('r')).resolves.toBe(false);
      paymentRepo.findOne.mockResolvedValueOnce(null);
      await expect(service.isPaymentSecured('r')).resolves.toBe(false);
    });
  });

  describe('cancelPayment', () => {
    it('does nothing when the payment is missing', async () => {
      txPaymentRepo.findOne.mockResolvedValue(null);
      await service.cancelPayment('r', 35);
      expect(txPaymentRepo.save).not.toHaveBeenCalled();
    });

    it('refunds a HELD payment in full', async () => {
      const p = payment();
      txPaymentRepo.findOne.mockResolvedValue(p);
      paystack.createRefund.mockResolvedValue({});

      await service.cancelPayment(p.reference, 35);

      expect(paystack.createRefund).toHaveBeenCalledWith(p.reference, 100);
      expect(txPaymentRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          status: PaymentStatus.REFUNDED,
          refundedAmount: 100,
        }),
      );
    });

    it('leaves everything untouched and returns a 503 when the refund is refused', async () => {
      const p = payment();
      txPaymentRepo.findOne.mockResolvedValue(p);
      paystack.createRefund.mockRejectedValue(new Error('Paystack down'));

      await expect(service.cancelPayment(p.reference, 35)).rejects.toThrow(
        ServiceUnavailableException,
      );
      expect(p.status).toBe(PaymentStatus.HELD);
      expect(txPaymentRepo.save).not.toHaveBeenCalled();
    });

    it('cancels an unpaid PENDING payment without calling Paystack', async () => {
      txPaymentRepo.findOne.mockResolvedValue(
        payment({ status: PaymentStatus.PENDING }),
      );

      await service.cancelPayment('r', 35);

      expect(paystack.createRefund).not.toHaveBeenCalled();
      expect(txPaymentRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: PaymentStatus.CANCELLED }),
      );
    });

    it('leaves an already-released payment as it is', async () => {
      txPaymentRepo.findOne.mockResolvedValue(
        payment({ status: PaymentStatus.RELEASED }),
      );
      await service.cancelPayment('r', 35);
      expect(txPaymentRepo.save).not.toHaveBeenCalled();
      expect(paystack.createRefund).not.toHaveBeenCalled();
    });
  });

  describe('initializePayment', () => {
    it('rethrows a Paystack error that is not a duplicate reference', async () => {
      paymentRepo.findOne.mockResolvedValue(
        payment({ status: PaymentStatus.PENDING }),
      );
      userRepo.findOneOrFail.mockResolvedValue({ email: 'ama@example.com' });
      paystack.initializeTransaction.mockRejectedValue(
        new Error('Invalid key'),
      );

      await expect(service.initializePayment(22, 35)).rejects.toThrow(
        'Invalid key',
      );
      expect(paystack.initializeTransaction).toHaveBeenCalledWith(
        expect.objectContaining({
          email: 'ama@example.com',
          amountGhs: 100,
          callbackUrl: 'https://app.example.com/pay',
          metadata: { jobId: 35, customerId: 22, paymentId: 7 },
        }),
      );
    });
  });

  describe('getMyHistory', () => {
    it('maps payments, falling back when the job relation is missing', async () => {
      const created = new Date('2026-01-01T00:00:00Z');
      paymentRepo.find.mockResolvedValue([
        {
          ...payment(),
          job: { id: 35, title: 'Fix sink' },
          createdAt: created,
        },
        {
          ...payment({ id: 8, jobId: 36, refundedAmount: undefined }),
          createdAt: created,
        },
      ]);

      const res = await service.getMyHistory(22);

      expect(paymentRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({ where: { customerId: 22 } }),
      );
      expect(res.data[0]).toMatchObject({
        jobId: 35,
        job: { id: 35, title: 'Fix sink' },
        refundedAmount: 0,
        paidAt: null,
        releasedAt: null,
        date: created,
      });
      expect(res.data[1]).toMatchObject({
        jobId: 36,
        job: { id: 36, title: null },
        refundedAmount: 0,
      });
    });
  });

  describe('verifyPayment', () => {
    const remote = (overrides: Record<string, unknown> = {}) => ({
      status: 'success',
      amount: 10000,
      currency: 'GHS',
      channel: 'mobile_money',
      paid_at: '2026-02-01T10:00:00Z',
      ...overrides,
    });

    it("hides another customer's payment as not found", async () => {
      paymentRepo.findOne.mockResolvedValue(payment({ customerId: 99 }));
      await expect(service.verifyPayment(22, 'r')).rejects.toThrow(
        NotFoundException,
      );
      expect(paystack.verifyTransaction).not.toHaveBeenCalled();
    });

    it('throws NotFoundException for an unknown reference', async () => {
      paymentRepo.findOne.mockResolvedValue(null);
      await expect(service.verifyPayment(22, 'r')).rejects.toThrow(
        'Payment not found.',
      );
    });

    it('reconciles a matching success into HELD and notifies both sides', async () => {
      const p = payment({ status: PaymentStatus.PENDING });
      paymentRepo.findOne.mockResolvedValue(p);
      paystack.verifyTransaction.mockResolvedValue(remote());
      withArtisanContext({ id: 9, firstname: 'Kofi', lastname: 'Mensah' });

      const res = await service.verifyPayment(22, p.reference);

      expect(res.data).toMatchObject({
        status: PaymentStatus.HELD,
        remoteStatus: 'success',
      });
      expect(p.channel).toBe('mobile_money');
      expect(p.paidAt).toEqual(new Date('2026-02-01T10:00:00Z'));
      expect(paymentRepo.save).toHaveBeenCalledWith(p);
      expect(events.emit).toHaveBeenCalledWith(APP_EVENTS.PAYMENT_RECEIPT, {
        customerId: 22,
        jobId: 35,
        jobTitle: 'Fix kitchen sink',
        amount: 100,
        reference: p.reference,
      });
      expect(events.emit).toHaveBeenCalledWith(APP_EVENTS.PAYMENT_SECURED, {
        artisanUserId: 9,
        jobId: 35,
        jobTitle: 'Fix kitchen sink',
        artisanAmount: 95,
      });
    });

    it('uses now as paidAt when Paystack omits it', async () => {
      const p = payment({ status: PaymentStatus.PENDING });
      paymentRepo.findOne.mockResolvedValue(p);
      paystack.verifyTransaction.mockResolvedValue(remote({ paid_at: null }));
      withArtisanContext(null);

      await service.verifyPayment(22, p.reference);

      expect(p.paidAt).toBeInstanceOf(Date);
      // Artisan without a user: receipt still goes out, secured notice is skipped.
      expect(events.emit).toHaveBeenCalledTimes(1);
      expect(events.emit).toHaveBeenCalledWith(
        APP_EVENTS.PAYMENT_RECEIPT,
        expect.objectContaining({ jobTitle: 'Fix kitchen sink' }),
      );
    });

    it.each([
      ['amount', { amount: 5000 }],
      ['currency', { currency: 'NGN' }],
    ])(
      'leaves the payment PENDING on a %s mismatch',
      async (_label, overrides) => {
        const p = payment({ status: PaymentStatus.PENDING });
        paymentRepo.findOne.mockResolvedValue(p);
        paystack.verifyTransaction.mockResolvedValue(remote(overrides));

        const res = await service.verifyPayment(22, p.reference);

        expect(res.data.status).toBe(PaymentStatus.PENDING);
        expect(paymentRepo.save).not.toHaveBeenCalled();
        expect(events.emit).not.toHaveBeenCalled();
      },
    );

    it('does not touch an already-HELD payment', async () => {
      paymentRepo.findOne.mockResolvedValue(payment());
      paystack.verifyTransaction.mockResolvedValue(remote());

      const res = await service.verifyPayment(22, 'r');

      expect(res.data.status).toBe(PaymentStatus.HELD);
      expect(paymentRepo.save).not.toHaveBeenCalled();
    });
  });

  describe('getMyEarnings', () => {
    it('throws NotFoundException without an artisan profile', async () => {
      profileRepo.findOne.mockResolvedValue(null);
      await expect(service.getMyEarnings(9)).rejects.toThrow(
        'Artisan profile not found.',
      );
    });

    it("lists only the artisan's own payouts without provider fields", async () => {
      profileRepo.findOne.mockResolvedValue({ id: 4 });
      paymentRepo.find.mockResolvedValue([
        {
          ...payment(),
          job: { id: 35, title: 'Fix sink' },
          transferCode: 'TRF_x',
        },
        payment({ jobId: 36 }),
      ]);

      const res = await service.getMyEarnings(9);

      expect(paymentRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({ where: { artisanProfileId: 4 } }),
      );
      expect(res.data[0]).toEqual({
        id: 7,
        jobId: 35,
        job: { id: 35, title: 'Fix sink' },
        artisanAmount: 95,
        status: PaymentStatus.HELD,
        date: undefined,
        paidAt: null,
        releasedAt: null,
      });
      expect(res.data[1].job).toEqual({ id: 36, title: null });
    });
  });

  describe('getAdminSummary', () => {
    it('converts the aggregate row to numbers', async () => {
      paymentRepo.query.mockResolvedValue([
        {
          revenue: '1200.50',
          fees: '60.03',
          payouts: '900',
          needs_review: '2',
          total: '15',
        },
      ]);

      await expect(service.getAdminSummary()).resolves.toEqual({
        message: 'Payment summary retrieved.',
        data: {
          totalRevenue: 1200.5,
          totalFees: 60.03,
          totalPayouts: 900,
          needsReview: 2,
          totalPayments: 15,
        },
      });
    });
  });

  describe('getAllPayments', () => {
    let qb: Record<string, jest.Mock>;

    beforeEach(() => {
      qb = {};
      for (const m of [
        'leftJoinAndSelect',
        'orderBy',
        'skip',
        'take',
        'andWhere',
      ]) {
        qb[m] = jest.fn(() => qb);
      }
      qb.getManyAndCount = jest.fn().mockResolvedValue([[payment()], 45]);
      paymentRepo.createQueryBuilder.mockReturnValue(qb);
    });

    it('clamps the limit and applies status and search filters', async () => {
      const res = await service.getAllPayments(3, 500, {
        status: PaymentStatus.HELD,
        search: '  #35 ',
      });

      expect(qb.take).toHaveBeenCalledWith(100);
      expect(qb.skip).toHaveBeenCalledWith(200);
      expect(qb.andWhere).toHaveBeenCalledWith('p.status = :status', {
        status: PaymentStatus.HELD,
      });
      expect(qb.andWhere).toHaveBeenCalledWith(expect.any(String), {
        like: '%#35%',
        exact: '35',
      });
      expect(res.pagination).toEqual({
        total: 45,
        page: 3,
        limit: 100,
        totalPages: 1,
      });
    });

    it('defaults page and limit and skips empty filters', async () => {
      const res = await service.getAllPayments(0, 0, { search: '   ' });

      expect(qb.skip).toHaveBeenCalledWith(0);
      expect(qb.take).toHaveBeenCalledWith(20);
      expect(qb.andWhere).not.toHaveBeenCalled();
      expect(res.pagination).toMatchObject({
        page: 1,
        limit: 20,
        totalPages: 3,
      });
    });

    it('works with no arguments at all', async () => {
      await service.getAllPayments();
      expect(qb.take).toHaveBeenCalledWith(20);
    });
  });

  describe('releaseWithheldPayment', () => {
    let capture: jest.SpyInstance;

    beforeEach(() => {
      capture = jest
        .spyOn(service, 'capturePayment')
        .mockResolvedValue(undefined);
    });

    it('throws NotFoundException for an unknown payment', async () => {
      paymentRepo.findOne.mockResolvedValue(null);
      await expect(service.releaseWithheldPayment(7)).rejects.toThrow(
        'Payment 7 not found.',
      );
    });

    it('refuses an already-released payment', async () => {
      paymentRepo.findOne.mockResolvedValue(
        payment({ status: PaymentStatus.RELEASED }),
      );
      await expect(service.releaseWithheldPayment(7)).rejects.toThrow(
        'already been released',
      );
      expect(capture).not.toHaveBeenCalled();
    });

    it('refuses a payment that is not withheld', async () => {
      paymentRepo.findOne.mockResolvedValue(
        payment({ status: PaymentStatus.REFUNDED }),
      );
      await expect(service.releaseWithheldPayment(7)).rejects.toThrow(
        'Cannot release a payment with status REFUNDED.',
      );
    });

    it('refuses while a transfer is already awaiting confirmation', async () => {
      paymentRepo.findOne.mockResolvedValue(payment({ transferCode: 'TRF_x' }));
      await expect(service.releaseWithheldPayment(7)).rejects.toThrow(
        'already been initiated',
      );
    });

    it('explains a missing payout method after capture', async () => {
      paymentRepo.findOne
        .mockResolvedValueOnce(
          payment({ status: PaymentStatus.PENDING_TRANSFER }),
        )
        .mockResolvedValueOnce(
          payment({ status: PaymentStatus.PENDING_TRANSFER }),
        );
      await expect(service.releaseWithheldPayment(7)).rejects.toThrow(
        'no payout method registered',
      );
      expect(capture).toHaveBeenCalledWith('jinva-35-22-111', 35);
    });

    it('reports a transfer that could not be initiated', async () => {
      paymentRepo.findOne
        .mockResolvedValueOnce(
          payment({ status: PaymentStatus.TRANSFER_FAILED }),
        )
        .mockResolvedValueOnce(
          payment({ status: PaymentStatus.TRANSFER_FAILED }),
        );
      await expect(service.releaseWithheldPayment(7)).rejects.toThrow(
        'could not be initiated',
      );
    });

    it('returns the released amount once a transfer is in flight', async () => {
      paymentRepo.findOne
        .mockResolvedValueOnce(payment())
        .mockResolvedValueOnce(payment({ transferCode: 'TRF_new' }));

      await expect(service.releaseWithheldPayment(7)).resolves.toEqual({
        message: 'Withheld payment released to the artisan.',
        data: { paymentId: 7, artisanAmount: 95, status: PaymentStatus.HELD },
      });
    });
  });

  describe('fraud flags', () => {
    it('flags a payment and writes an audit row', async () => {
      const p = payment();
      paymentRepo.findOne.mockResolvedValue(p);

      await expect(
        service.setFraudFlag(admin, 7, 'Card reported stolen'),
      ).resolves.toEqual({ message: 'Transaction flagged for fraud review.' });

      expect(p).toMatchObject({
        fraudFlagged: true,
        fraudFlagReason: 'Card reported stolen',
        fraudFlaggedById: 1,
      });
      expect(p.fraudFlaggedAt).toBeInstanceOf(Date);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AdminActionType.PAYMENT_FRAUD_FLAG,
          targetId: 7,
          actorName: 'Ada Admin',
          actorEmail: 'admin@example.com',
          amount: 100,
        }),
      );
    });

    it('refuses to flag twice or flag an unknown payment', async () => {
      paymentRepo.findOne.mockResolvedValueOnce(
        payment({ fraudFlagged: true }),
      );
      await expect(service.setFraudFlag(admin, 7, 'again')).rejects.toThrow(
        'already flagged',
      );
      paymentRepo.findOne.mockResolvedValueOnce(null);
      await expect(service.setFraudFlag(admin, 7, 'x')).rejects.toThrow(
        NotFoundException,
      );
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('clears a flag and writes an audit row', async () => {
      const p = payment({ fraudFlagged: true, fraudFlagReason: 'x' });
      paymentRepo.findOne.mockResolvedValue(p);

      await expect(
        service.clearFraudFlag(admin, 7, 'Verified with bank'),
      ).resolves.toEqual({ message: 'Fraud flag cleared.' });

      expect(p).toMatchObject({
        fraudFlagged: false,
        fraudFlagReason: null,
        fraudFlaggedAt: null,
        fraudFlaggedById: null,
      });
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AdminActionType.PAYMENT_FRAUD_FLAG_CLEARED,
          reason: 'Verified with bank',
        }),
      );
    });

    it('refuses to clear an unflagged or unknown payment', async () => {
      paymentRepo.findOne.mockResolvedValueOnce(payment());
      await expect(service.clearFraudFlag(admin, 7, 'x')).rejects.toThrow(
        'not currently flagged',
      );
      paymentRepo.findOne.mockResolvedValueOnce(null);
      await expect(service.clearFraudFlag(admin, 7, 'x')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('adminRefund', () => {
    beforeEach(() => {
      paystack.createRefund.mockResolvedValue({});
      withArtisanContext({ id: 9, firstname: 'Kofi', lastname: 'Mensah' });
    });

    it('throws NotFoundException for an unknown payment', async () => {
      txPaymentRepo.findOne.mockResolvedValue(null);
      await expect(service.adminRefund(7)).rejects.toThrow(NotFoundException);
    });

    it.each([PaymentStatus.PENDING, PaymentStatus.REFUNDED])(
      'refuses to refund a %s payment',
      async (status) => {
        txPaymentRepo.findOne.mockResolvedValue(payment({ status }));
        await expect(service.adminRefund(7, 10, admin)).rejects.toThrow(
          `Cannot refund a payment with status ${status}.`,
        );
        expect(paystack.createRefund).not.toHaveBeenCalled();
      },
    );

    it('refuses when nothing is left to refund', async () => {
      txPaymentRepo.findOne.mockResolvedValue(
        payment({ status: PaymentStatus.RELEASED, refundedAmount: 100 }),
      );
      await expect(service.adminRefund(7, 1, admin)).rejects.toThrow(
        'already been fully refunded',
      );
    });

    it('rejects a non-positive amount', async () => {
      txPaymentRepo.findOne.mockResolvedValue(payment());
      await expect(service.adminRefund(7, 0, admin)).rejects.toThrow(
        'must be a positive number',
      );
    });

    it('rejects an amount above the remaining balance', async () => {
      txPaymentRepo.findOne.mockResolvedValue(payment({ refundedAmount: 70 }));
      await expect(service.adminRefund(7, 40, admin)).rejects.toThrow(
        'cannot exceed the remaining refundable balance (GH₵30)',
      );
      expect(paystack.createRefund).not.toHaveBeenCalled();
    });

    it('records a partial refund, keeps the status, notifies and audits', async () => {
      const p = payment();
      txPaymentRepo.findOne.mockResolvedValue(p);

      await expect(service.adminRefund(7, 40, admin)).resolves.toEqual({
        message: 'Refund initiated.',
      });

      expect(paystack.createRefund).toHaveBeenCalledWith(p.reference, 40);
      expect(p.refundedAmount).toBe(40);
      expect(p.status).toBe(PaymentStatus.HELD);
      expect(events.emit).toHaveBeenCalledWith(APP_EVENTS.PAYMENT_REFUNDED, {
        customerId: 22,
        jobId: 35,
        jobTitle: 'Fix kitchen sink',
        refundedAmount: 40,
        fullyRefunded: false,
      });
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AdminActionType.PAYMENT_REFUND,
          actorId: 1,
          amount: 40,
          moneyAction: 'REFUND',
          metadata: { jobId: 35, fullyRefunded: false },
        }),
      );
    });

    it('refunds the remaining balance by default and marks it REFUNDED', async () => {
      const p = payment({ status: PaymentStatus.RELEASED, refundedAmount: 25 });
      txPaymentRepo.findOne.mockResolvedValue(p);

      await service.adminRefund(7);

      expect(paystack.createRefund).toHaveBeenCalledWith(p.reference, 75);
      expect(p.refundedAmount).toBe(100);
      expect(p.status).toBe(PaymentStatus.REFUNDED);
      // No acting admin: still refunded and notified, but no audit row.
      expect(events.emit).toHaveBeenCalledWith(
        APP_EVENTS.PAYMENT_REFUNDED,
        expect.objectContaining({ refundedAmount: 75, fullyRefunded: true }),
      );
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('does not save or notify when Paystack refuses the refund', async () => {
      txPaymentRepo.findOne.mockResolvedValue(payment());
      paystack.createRefund.mockRejectedValue(new Error('refused'));

      await expect(service.adminRefund(7, 10, admin)).rejects.toThrow(
        'refused',
      );
      expect(txPaymentRepo.save).not.toHaveBeenCalled();
      expect(events.emit).not.toHaveBeenCalled();
    });

    it('still succeeds when the refund notification fails', async () => {
      txPaymentRepo.findOne.mockResolvedValue(payment());
      jobRepo.findOne.mockRejectedValue('lookup failed');

      await expect(service.adminRefund(7, 10, admin)).resolves.toEqual({
        message: 'Refund initiated.',
      });
      expect(events.emit).not.toHaveBeenCalled();
      expect(audit.record).toHaveBeenCalled();
    });
  });

  describe('processWebhook', () => {
    const send = (event: string, data: Record<string, unknown>) =>
      service.processWebhook(JSON.stringify({ event, data }), 'sig');

    beforeEach(() => {
      paystack.verifyWebhookSignature.mockReturnValue(true);
    });

    it('ignores a payload with an invalid signature', async () => {
      paystack.verifyWebhookSignature.mockReturnValue(false);
      await service.processWebhook('not json', 'bad');
      expect(paymentRepo.findOne).not.toHaveBeenCalled();
    });

    it('ignores events it does not handle', async () => {
      await send('subscription.create', {});
      expect(paymentRepo.findOne).not.toHaveBeenCalled();
    });

    describe('charge.success', () => {
      const charge = {
        reference: 'jinva-35-22-111',
        amount: 10000,
        currency: 'GHS',
        channel: 'card',
        paid_at: '2026-02-01T10:00:00Z',
      };

      it('ignores an unknown reference', async () => {
        paymentRepo.findOne.mockResolvedValue(null);
        await send('charge.success', charge);
        expect(paymentRepo.save).not.toHaveBeenCalled();
      });

      it.each([
        ['amount', { amount: 9999 }],
        ['currency', { currency: 'USD' }],
      ])('refuses to reconcile a %s mismatch', async (_l, overrides) => {
        paymentRepo.findOne.mockResolvedValue(
          payment({ status: PaymentStatus.PENDING }),
        );
        await send('charge.success', { ...charge, ...overrides });
        expect(paymentRepo.save).not.toHaveBeenCalled();
      });

      it('marks the payment HELD and notifies on the first delivery', async () => {
        const p = payment({ status: PaymentStatus.PENDING });
        paymentRepo.findOne.mockResolvedValue(p);
        withArtisanContext({ id: 9, firstname: 'Kofi', lastname: 'Mensah' });
        const { currency: _c, ...noCurrency } = charge;

        await send('charge.success', noCurrency);

        expect(p.status).toBe(PaymentStatus.HELD);
        expect(p.channel).toBe('card');
        expect(p.paidAt).toEqual(new Date('2026-02-01T10:00:00Z'));
        expect(events.emit).toHaveBeenCalledTimes(2);
      });

      it('does not notify again on a redelivered webhook', async () => {
        paymentRepo.findOne.mockResolvedValue(payment());
        await send('charge.success', charge);
        expect(paymentRepo.save).toHaveBeenCalled();
        expect(events.emit).not.toHaveBeenCalled();
      });

      it('falls back to a generic job title when the job is gone', async () => {
        paymentRepo.findOne.mockResolvedValue(
          payment({ status: PaymentStatus.PENDING }),
        );
        jobRepo.findOne.mockResolvedValue(null);
        profileRepo.findOne.mockResolvedValue(null);

        await send('charge.success', charge);

        expect(events.emit).toHaveBeenCalledTimes(1);
        expect(events.emit).toHaveBeenCalledWith(
          APP_EVENTS.PAYMENT_RECEIPT,
          expect.objectContaining({ jobTitle: 'Job #35' }),
        );
      });
    });

    describe('transfer.success', () => {
      it('ignores an unknown transfer reference', async () => {
        paymentRepo.findOne.mockResolvedValue(null);
        await send('transfer.success', { reference: 'jinva-tr-x' });
        expect(paymentRepo.save).not.toHaveBeenCalled();
      });

      it('marks RELEASED and tells the artisan once', async () => {
        const p = payment({ transferReference: 'jinva-tr-35-1' });
        paymentRepo.findOne.mockResolvedValue(p);
        withArtisanContext({ id: 9, firstname: 'Kofi', lastname: 'Mensah' });

        await send('transfer.success', { reference: 'jinva-tr-35-1' });

        expect(paymentRepo.findOne).toHaveBeenCalledWith({
          where: { transferReference: 'jinva-tr-35-1' },
        });
        expect(p.status).toBe(PaymentStatus.RELEASED);
        expect(p.releasedAt).toBeInstanceOf(Date);
        expect(events.emit).toHaveBeenCalledWith(APP_EVENTS.PAYOUT_RELEASED, {
          artisanUserId: 9,
          jobId: 35,
          jobTitle: 'Fix kitchen sink',
          artisanAmount: 95,
        });
      });

      it('does not notify on a redelivered success', async () => {
        paymentRepo.findOne.mockResolvedValue(
          payment({ status: PaymentStatus.RELEASED }),
        );
        await send('transfer.success', { reference: 'jinva-tr-35-1' });
        expect(events.emit).not.toHaveBeenCalled();
      });

      it('skips the payout notice when the artisan has no user', async () => {
        paymentRepo.findOne.mockResolvedValue(payment());
        withArtisanContext(null);
        await send('transfer.success', { reference: 'jinva-tr-35-1' });
        expect(paymentRepo.save).toHaveBeenCalled();
        expect(events.emit).not.toHaveBeenCalled();
      });

      it('swallows a notification failure after the release is saved', async () => {
        paymentRepo.findOne.mockResolvedValue(payment());
        jobRepo.findOne.mockRejectedValue(new Error('db gone'));
        await expect(
          send('transfer.success', { reference: 'jinva-tr-35-1' }),
        ).resolves.toBeUndefined();
        expect(paymentRepo.save).toHaveBeenCalled();
      });
    });

    describe.each(['transfer.failed', 'transfer.reversed'])('%s', (event) => {
      it('ignores a payload without a reference', async () => {
        await send(event, {});
        expect(paymentRepo.findOne).not.toHaveBeenCalled();
      });

      it('ignores an unknown transfer reference', async () => {
        paymentRepo.findOne.mockResolvedValue(null);
        await send(event, { reference: 'jinva-tr-x' });
        expect(paymentRepo.save).not.toHaveBeenCalled();
      });

      it('marks TRANSFER_FAILED and alerts admins with the provider reason', async () => {
        const p = payment();
        paymentRepo.findOne.mockResolvedValue(p);
        withArtisanContext({ id: 9, firstname: 'Kofi', lastname: 'Mensah' });

        await send(event, {
          reference: 'jinva-tr-35-1',
          reason: 'Account closed',
        });

        expect(p.status).toBe(PaymentStatus.TRANSFER_FAILED);
        expect(events.emit).toHaveBeenCalledWith(
          APP_EVENTS.PAYMENT_TRANSFER_FAILED,
          expect.objectContaining({
            reason: 'Account closed',
            artisanName: 'Kofi Mensah',
          }),
        );
      });

      it('uses a generic reason and the fallback artisan name', async () => {
        paymentRepo.findOne.mockResolvedValue(payment());
        withArtisanContext(null);

        await send(event, { reference: 'jinva-tr-35-1', reason: '' });

        expect(events.emit).toHaveBeenCalledWith(
          APP_EVENTS.PAYMENT_TRANSFER_FAILED,
          expect.objectContaining({
            reason: `Paystack reported ${event}`,
            artisanName: 'the artisan',
          }),
        );
      });

      it('does not alert again on a redelivered failure', async () => {
        paymentRepo.findOne.mockResolvedValue(
          payment({ status: PaymentStatus.TRANSFER_FAILED }),
        );
        await send(event, { reference: 'jinva-tr-35-1' });
        expect(paymentRepo.save).toHaveBeenCalled();
        expect(events.emit).not.toHaveBeenCalled();
      });
    });
  });

  describe('setupPayoutMethod', () => {
    const momo = {
      type: 'mobile_money' as const,
      accountName: 'Kofi Mensah',
      accountNumber: '0240000000',
      bankCode: 'MTN',
    };

    it('throws NotFoundException without an artisan profile', async () => {
      profileRepo.findOne.mockResolvedValue(null);
      await expect(service.setupPayoutMethod(9, momo)).rejects.toThrow(
        NotFoundException,
      );
      expect(paystack.createTransferRecipient).not.toHaveBeenCalled();
    });

    it('registers mobile money as a Paystack recipient and saves it', async () => {
      const profile: Record<string, unknown> = { id: 4 };
      profileRepo.findOne.mockResolvedValue(profile);
      paystack.createTransferRecipient.mockResolvedValue({
        recipient_code: 'RCP_momo',
      });

      await expect(service.setupPayoutMethod(9, momo)).resolves.toEqual({
        message: 'Payout method registered successfully.',
      });

      expect(paystack.createTransferRecipient).toHaveBeenCalledWith({
        type: 'mobile_money',
        name: 'Kofi Mensah',
        accountNumber: '0240000000',
        bankCode: 'MTN',
      });
      expect(profileRepo.save).toHaveBeenCalledWith({
        id: 4,
        payoutType: PayoutType.MOBILE_MONEY,
        paystackRecipientCode: 'RCP_momo',
        payoutAccountName: 'Kofi Mensah',
        payoutAccountNumber: '0240000000',
        payoutBankCode: 'MTN',
      });
    });

    it('maps a bank account to a ghipss recipient', async () => {
      profileRepo.findOne.mockResolvedValue({ id: 4 });
      paystack.createTransferRecipient.mockResolvedValue({
        recipient_code: 'RCP_bank',
      });

      await service.setupPayoutMethod(9, {
        ...momo,
        type: 'bank',
        accountNumber: '1234567890',
        bankCode: '280100',
      });

      expect(paystack.createTransferRecipient).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'ghipss' }),
      );
      expect(profileRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ payoutType: PayoutType.BANK }),
      );
    });
  });

  describe('retryPendingTransfer', () => {
    it('throws NotFoundException without an artisan profile', async () => {
      profileRepo.findOne.mockResolvedValue(null);
      await expect(service.retryPendingTransfer(9, 35)).rejects.toThrow(
        'Artisan profile not found.',
      );
    });

    it('throws NotFoundException when nothing is retryable', async () => {
      profileRepo.findOne.mockResolvedValue({ id: 4 });
      paymentRepo.findOne.mockResolvedValue(null);
      await expect(service.retryPendingTransfer(9, 35)).rejects.toThrow(
        'No retryable transfer for this job on your account.',
      );
    });

    it('re-runs the capture for the artisan’s retryable payment', async () => {
      profileRepo.findOne.mockResolvedValue({ id: 4 });
      paymentRepo.findOne.mockResolvedValue(
        payment({ status: PaymentStatus.PENDING_TRANSFER }),
      );
      const capture = jest
        .spyOn(service, 'capturePayment')
        .mockResolvedValue(undefined);

      await expect(service.retryPendingTransfer(9, 35)).resolves.toEqual({
        message: 'Transfer retry initiated.',
      });
      expect(capture).toHaveBeenCalledWith('jinva-35-22-111', 35);
    });
  });
});

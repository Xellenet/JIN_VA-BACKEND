import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { getDataSourceToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { BadGatewayException, NotFoundException } from '@nestjs/common';
import { PaymentsService } from './payments.service';
import { Payment } from './entities/payment.entity';
import { Job } from '@jobs/entities/job.entity';
import { User } from '@users/entities/user.entity';
import { ArtisanProfile } from '@users/entities/artisan-profile.entity';
import { PaystackService } from './paystack.service';
import { AdminAuditService } from '../admin-audit/admin-audit.service';
import { PaymentCharge } from './entities/payment-charge.entity';
import { PaymentMethodsService } from '../payment-methods/payment-methods.service';
import { PaymentStatus } from '@common/types/enums';
import {
  PAYMENT_ATTEMPT_ACTIVE,
  PaymentAttemptsService,
} from './payment-attempts.service';
import { DuplicateRefundService } from './duplicate-refund.service';

describe('PaymentsService', () => {
  let service: PaymentsService;

  const mockRepo = () => ({
    create: jest.fn(),
    save: jest.fn(),
    find: jest.fn(),
    findOne: jest.fn(),
    findAndCount: jest.fn(),
  });

  let paymentRepo: ReturnType<typeof mockRepo> & { update: jest.Mock };
  let userRepo: { findOneOrFail: jest.Mock };
  let chargeRepo: { findOne: jest.Mock; count: jest.Mock; update: jest.Mock };
  /** Idempotent payments: the attempt rules are their own service. */
  const attempts = { claim: jest.fn(), jobState: jest.fn() };

  const mockPaystack = {
    initializeTransaction: jest.fn(),
  };
  const mockConfig = {
    get: jest.fn((key: string, fallback?: unknown) => {
      if (key === 'PLATFORM_FEE_PERCENT') return 5;
      return fallback;
    }),
  };
  /** B5c: the checkout preference is read through `getRepository`. */
  const mockSettingsRepo = { findOne: jest.fn() };
  const mockDataSource = {
    transaction: jest.fn(),
    getRepository: jest.fn(() => mockSettingsRepo),
  };
  /** PD1–PD3: PaymentsService now emits notification events. */
  const mockEventEmitter = { emit: jest.fn() };
  /** AT5: admin refunds and fraud flags now append an admin audit row. */
  const mockAuditService = { record: jest.fn().mockResolvedValue(undefined) };

  beforeEach(async () => {
    paymentRepo = { ...mockRepo(), update: jest.fn() };
    userRepo = { findOneOrFail: jest.fn() };
    chargeRepo = {
      findOne: jest.fn().mockResolvedValue(null),
      count: jest.fn().mockResolvedValue(0),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentsService,
        { provide: getRepositoryToken(Payment), useValue: paymentRepo },
        { provide: getRepositoryToken(Job), useValue: mockRepo() },
        { provide: getRepositoryToken(User), useValue: userRepo },
        { provide: getRepositoryToken(ArtisanProfile), useValue: mockRepo() },
        { provide: getDataSourceToken(), useValue: mockDataSource },
        { provide: PaystackService, useValue: mockPaystack },
        { provide: ConfigService, useValue: mockConfig },
        { provide: EventEmitter2, useValue: mockEventEmitter },
        { provide: AdminAuditService, useValue: mockAuditService },
        // Saved payment methods: no card saving here.
        { provide: getRepositoryToken(PaymentCharge), useValue: chargeRepo },
        {
          provide: PaymentMethodsService,
          useValue: { saveCardFromAuthorization: jest.fn() },
        },
        { provide: PaymentAttemptsService, useValue: attempts },
        { provide: DuplicateRefundService, useValue: { process: jest.fn() } },
      ],
    }).compile();

    service = module.get<PaymentsService>(PaymentsService);
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('initializePayment', () => {
    const basePayment = () =>
      ({
        id: 1,
        jobId: 35,
        customerId: 22,
        amount: 150,
        currency: 'GHS',
        reference: 'jinva-35-22-111',
        status: PaymentStatus.PENDING,
        authorizationUrl: null as string | null,
        accessCode: null as string | null,
        saveCardRequested: false,
      }) as unknown as Payment;
    const attempt = (over: Partial<PaymentCharge> = {}) =>
      ({
        id: 9,
        paymentId: 1,
        reference: 'jinva-35-22-111',
        methodType: 'hosted',
        status: 'hosted_open',
        authorizationUrl: null,
        accessCode: null,
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 30 * 60_000),
        ...over,
      }) as PaymentCharge;

    /** A new hosted attempt on the payment's own reference. */
    const fresh = (payment = basePayment(), charge = attempt()) => {
      attempts.claim.mockResolvedValueOnce({
        outcome: 'created',
        payment,
        charge,
      });
      userRepo.findOneOrFail.mockResolvedValueOnce({
        id: 22,
        email: 'ama@example.com',
      });
      mockPaystack.initializeTransaction.mockResolvedValueOnce({
        authorization_url: 'https://checkout.paystack.com/abc',
        access_code: 'code_abc',
        reference: charge.reference,
      });
      return { payment, charge };
    };

    it('claims a hosted attempt, calls Paystack with its reference and stores the session', async () => {
      const { charge } = fresh();

      const result = await service.initializePayment(22, 35);

      expect(attempts.claim).toHaveBeenCalledWith(
        22,
        35,
        { kind: 'hosted' },
        expect.any(Function),
        expect.stringMatching(/No pending payment/),
      );
      expect(mockPaystack.initializeTransaction).toHaveBeenCalledWith(
        expect.objectContaining({
          reference: charge.reference,
          metadata: expect.objectContaining({ chargeId: 9 }) as unknown,
        }),
      );
      expect(chargeRepo.update).toHaveBeenCalledWith(
        { id: 9 },
        {
          authorizationUrl: 'https://checkout.paystack.com/abc',
          accessCode: 'code_abc',
        },
      );
      // The first attempt uses the payment's own reference: kept there too.
      expect(paymentRepo.update).toHaveBeenCalledWith(
        { id: 1 },
        {
          authorizationUrl: 'https://checkout.paystack.com/abc',
          accessCode: 'code_abc',
        },
      );
      expect(result.data).toMatchObject({
        reference: 'jinva-35-22-111',
        authorizationUrl: 'https://checkout.paystack.com/abc',
        accessCode: 'code_abc',
      });
    });

    it('a later attempt with its own reference does not touch the payment row session', async () => {
      fresh(basePayment(), attempt({ reference: 'jinva-ho-1-2-abc' }));
      const result = await service.initializePayment(22, 35);
      expect(result.data.reference).toBe('jinva-ho-1-2-abc');
      expect(paymentRepo.update).not.toHaveBeenCalledWith(
        { id: 1 },
        expect.objectContaining({
          authorizationUrl: expect.any(String) as unknown,
        }),
      );
    });

    describe('B5c checkout channel order', () => {
      it('puts the preferred channel first (E-5.8 at unit level)', async () => {
        fresh();
        mockSettingsRepo.findOne.mockResolvedValueOnce({
          id: 1,
          preferredChannel: 'mobile_money',
        });

        await service.initializePayment(22, 35);

        expect(mockSettingsRepo.findOne).toHaveBeenCalledWith(
          expect.objectContaining({ where: { userId: 22 } }),
        );
        const params = (
          mockPaystack.initializeTransaction.mock.calls as unknown[][]
        )[0][0] as {
          channels?: string[];
        };
        expect(params.channels?.[0]).toBe('mobile_money');
        expect(params.channels).toEqual(
          expect.arrayContaining(['card', 'bank', 'ussd']),
        );
      });

      it('sends no channels key without a preference (E-5.9)', async () => {
        fresh();
        mockSettingsRepo.findOne.mockResolvedValueOnce(null);

        await service.initializePayment(22, 35);

        const params = (
          mockPaystack.initializeTransaction.mock.calls as unknown[][]
        )[0][0] as Record<string, unknown>;
        expect(Object.keys(params)).not.toContain('channels');
      });

      it('BU-5.2: still initialises when the settings read fails', async () => {
        fresh();
        mockSettingsRepo.findOne.mockRejectedValueOnce(
          new Error('relation does not exist'),
        );

        const result = await service.initializePayment(22, 35);

        expect(result.data.authorizationUrl).toBe(
          'https://checkout.paystack.com/abc',
        );
        const params = (
          mockPaystack.initializeTransaction.mock.calls as unknown[][]
        )[0][0] as Record<string, unknown>;
        expect(Object.keys(params)).not.toContain('channels');
      });
    });

    it('returns the open attempt and never re-calls Paystack (the reference is used up)', async () => {
      attempts.claim.mockResolvedValueOnce({
        outcome: 'existing',
        payment: basePayment(),
        charge: attempt({
          authorizationUrl: 'https://checkout.paystack.com/existing',
          accessCode: 'code_existing',
        }),
      });

      const result = await service.initializePayment(22, 35);

      expect(mockPaystack.initializeTransaction).not.toHaveBeenCalled();
      expect(result.data).toMatchObject({
        reference: 'jinva-35-22-111',
        authorizationUrl: 'https://checkout.paystack.com/existing',
        accessCode: 'code_existing',
      });
    });

    it('waits for a concurrent initialise to store its session, then returns it', async () => {
      jest.useFakeTimers();
      try {
        attempts.claim.mockResolvedValueOnce({
          outcome: 'existing',
          payment: basePayment(),
          charge: attempt(),
        });
        chargeRepo.findOne
          .mockResolvedValueOnce(attempt())
          .mockResolvedValueOnce(
            attempt({
              authorizationUrl: 'https://checkout.paystack.com/racer',
              accessCode: 'code_racer',
            }),
          );
        const pending = service.initializePayment(22, 35);
        await jest.advanceTimersByTimeAsync(1_000);
        const result = await pending;
        expect(result.data.authorizationUrl).toBe(
          'https://checkout.paystack.com/racer',
        );
        expect(mockPaystack.initializeTransaction).not.toHaveBeenCalled();
      } finally {
        jest.useRealTimers();
      }
    });

    it('409 PAYMENT_ATTEMPT_ACTIVE when the concurrent initialise never stores a session', async () => {
      jest.useFakeTimers();
      try {
        attempts.claim.mockResolvedValueOnce({
          outcome: 'existing',
          payment: basePayment(),
          charge: attempt(),
        });
        chargeRepo.findOne.mockResolvedValue(attempt());
        const pending = service.initializePayment(22, 35);
        const check = expect(pending).rejects.toMatchObject({
          response: expect.objectContaining({
            errorCode: PAYMENT_ATTEMPT_ACTIVE,
          }) as unknown,
        });
        await jest.advanceTimersByTimeAsync(5_000);
        await check;
      } finally {
        jest.useRealTimers();
      }
    });

    it('passes on the 404 / 409 the attempt rules raise', async () => {
      attempts.claim.mockRejectedValueOnce(
        new NotFoundException('nothing due'),
      );
      await expect(service.initializePayment(22, 35)).rejects.toThrow(
        NotFoundException,
      );
      expect(mockPaystack.initializeTransaction).not.toHaveBeenCalled();
    });

    it('records the save-card opt-in on the payment row (latest choice wins)', async () => {
      fresh();
      await service.initializePayment(22, 35, { saveCard: true });
      expect(paymentRepo.update).toHaveBeenCalledWith(
        { id: 1 },
        { saveCardRequested: true },
      );
    });

    it('reuses a checkout opened before attempts were tracked when Paystack refuses its reference', async () => {
      const payment = basePayment();
      payment.authorizationUrl = 'https://checkout.paystack.com/legacy';
      payment.accessCode = 'code_legacy';
      attempts.claim.mockResolvedValueOnce({
        outcome: 'created',
        payment,
        charge: attempt(),
      });
      userRepo.findOneOrFail.mockResolvedValueOnce({ id: 22, email: 'a@x' });
      mockPaystack.initializeTransaction.mockRejectedValueOnce(
        new Error('Payment provider error: Duplicate Transaction Reference'),
      );

      const result = await service.initializePayment(22, 35);

      expect(result.data.authorizationUrl).toBe(
        'https://checkout.paystack.com/legacy',
      );
      expect(chargeRepo.update).toHaveBeenCalledWith(
        { id: 9 },
        {
          authorizationUrl: 'https://checkout.paystack.com/legacy',
          accessCode: 'code_legacy',
        },
      );
    });

    it('releases the attempt and rethrows when Paystack refuses to open a checkout', async () => {
      attempts.claim.mockResolvedValueOnce({
        outcome: 'created',
        payment: basePayment(),
        charge: attempt({ reference: 'jinva-ho-1-2-abc' }),
      });
      userRepo.findOneOrFail.mockResolvedValueOnce({ id: 22, email: 'a@x' });
      mockPaystack.initializeTransaction.mockRejectedValueOnce(
        new BadGatewayException('nope'),
      );

      await expect(service.initializePayment(22, 35)).rejects.toThrow(
        BadGatewayException,
      );
      expect(chargeRepo.update).toHaveBeenCalledWith(
        { id: 9, status: 'hosted_open' },
        { status: 'failed', action: null },
      );
    });
  });

  describe('getJobPaymentState', () => {
    it('reads the state through the attempt rules with the shared success path', async () => {
      attempts.jobState.mockResolvedValueOnce({ jobId: 35, paid: false });
      await expect(service.getJobPaymentState(22, 35)).resolves.toEqual({
        jobId: 35,
        paid: false,
      });
      const settle = (attempts.jobState.mock.calls[0] as unknown[])[2] as (
        id: number,
        d: Record<string, unknown>,
      ) => Promise<void>;
      const apply = jest
        .spyOn(service, 'applyChargeSuccess')
        .mockResolvedValue(undefined);
      await settle(9, { reference: 'r' });
      expect(apply).toHaveBeenCalledWith(9, { reference: 'r' });
    });
  });
});

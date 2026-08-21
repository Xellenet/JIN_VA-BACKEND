import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { getDataSourceToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PaymentsService } from './payments.service';
import { Payment } from './entities/payment.entity';
import { Job } from '@jobs/entities/job.entity';
import { User } from '@users/entities/user.entity';
import { ArtisanProfile } from '@users/entities/artisan-profile.entity';
import { PaystackService } from './paystack.service';
import { PaymentStatus } from '@common/types/enums';

describe('PaymentsService', () => {
  let service: PaymentsService;

  const mockRepo = () => ({
    create: jest.fn(),
    save: jest.fn(),
    find: jest.fn(),
    findOne: jest.fn(),
    findAndCount: jest.fn(),
  });

  let paymentRepo: ReturnType<typeof mockRepo>;
  let userRepo: { findOneOrFail: jest.Mock };

  const mockPaystack = {
    initializeTransaction: jest.fn(),
  };
  const mockConfig = {
    get: jest.fn((key: string, fallback?: unknown) => {
      if (key === 'PLATFORM_FEE_PERCENT') return 5;
      return fallback;
    }),
  };
  const mockDataSource = { transaction: jest.fn() };

  beforeEach(async () => {
    paymentRepo = mockRepo();
    userRepo = { findOneOrFail: jest.fn() };

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
      ],
    }).compile();

    service = module.get<PaymentsService>(PaymentsService);
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('initializePayment', () => {
    const basePayment = () => ({
      id: 1,
      jobId: 35,
      customerId: 22,
      amount: 150,
      currency: 'GHS',
      reference: 'jinva-35-22-111',
      status: PaymentStatus.PENDING,
      authorizationUrl: undefined as string | undefined,
      accessCode: undefined as string | undefined,
    });

    it('calls Paystack and persists the session on a fresh PENDING payment', async () => {
      const payment = basePayment();
      paymentRepo.findOne.mockResolvedValueOnce(payment);
      userRepo.findOneOrFail.mockResolvedValueOnce({
        id: 22,
        email: 'ama@example.com',
      });
      mockPaystack.initializeTransaction.mockResolvedValueOnce({
        authorization_url: 'https://checkout.paystack.com/abc',
        access_code: 'code_abc',
        reference: payment.reference,
      });

      const result = await service.initializePayment(22, 35);

      expect(mockPaystack.initializeTransaction).toHaveBeenCalledTimes(1);
      expect(paymentRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          authorizationUrl: 'https://checkout.paystack.com/abc',
          accessCode: 'code_abc',
        }),
      );
      expect(result.data.authorizationUrl).toBe(
        'https://checkout.paystack.com/abc',
      );
    });

    it('reuses the existing session and never re-calls Paystack when one already exists (the qa-report.md fix)', async () => {
      const payment = basePayment();
      payment.authorizationUrl = 'https://checkout.paystack.com/existing';
      payment.accessCode = 'code_existing';
      paymentRepo.findOne.mockResolvedValueOnce(payment);

      const result = await service.initializePayment(22, 35);

      expect(mockPaystack.initializeTransaction).not.toHaveBeenCalled();
      expect(paymentRepo.save).not.toHaveBeenCalled();
      expect(result.data.authorizationUrl).toBe(
        'https://checkout.paystack.com/existing',
      );
      expect(result.data.reference).toBe(payment.reference);
    });

    it('throws NotFoundException when no PENDING payment exists for the job', async () => {
      paymentRepo.findOne.mockResolvedValueOnce(null);

      await expect(service.initializePayment(22, 35)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('translates a Paystack "Duplicate Transaction Reference" error into a clean BadRequestException instead of a raw 500', async () => {
      const payment = basePayment();
      paymentRepo.findOne
        .mockResolvedValueOnce(payment) // initial PENDING lookup
        .mockResolvedValueOnce({ ...payment, authorizationUrl: undefined }); // re-check after the error — still no session
      userRepo.findOneOrFail.mockResolvedValueOnce({
        id: 22,
        email: 'ama@example.com',
      });
      mockPaystack.initializeTransaction.mockRejectedValueOnce(
        new Error('Payment provider error: Duplicate Transaction Reference'),
      );

      await expect(service.initializePayment(22, 35)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('recovers a race by returning the session a concurrent call already saved, instead of erroring', async () => {
      const payment = basePayment();
      const wonByRacingCall = {
        ...payment,
        authorizationUrl: 'https://checkout.paystack.com/racer',
        accessCode: 'code_racer',
      };
      paymentRepo.findOne
        .mockResolvedValueOnce(payment) // initial PENDING lookup — no session yet
        .mockResolvedValueOnce(wonByRacingCall); // re-check after the error — racing call already saved one
      userRepo.findOneOrFail.mockResolvedValueOnce({
        id: 22,
        email: 'ama@example.com',
      });
      mockPaystack.initializeTransaction.mockRejectedValueOnce(
        new Error('Payment provider error: Duplicate Transaction Reference'),
      );

      const result = await service.initializePayment(22, 35);

      expect(result.data.authorizationUrl).toBe(
        'https://checkout.paystack.com/racer',
      );
      expect(paymentRepo.save).not.toHaveBeenCalled();
    });
  });
});

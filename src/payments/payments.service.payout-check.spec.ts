import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  Logger,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { PaymentsService } from './payments.service';
import { Payment } from './entities/payment.entity';
import { Job } from '@jobs/entities/job.entity';
import { User } from '@users/entities/user.entity';
import { ArtisanProfile } from '@users/entities/artisan-profile.entity';
import { PaystackService } from './paystack.service';
import { AdminAuditService } from '../admin-audit/admin-audit.service';
import { PaymentCharge } from './entities/payment-charge.entity';
import { PaymentMethodsService } from '../payment-methods/payment-methods.service';
import { PaymentAttemptsService } from './payment-attempts.service';
import { DuplicateRefundService } from './duplicate-refund.service';
import { PaymentStatus } from '@common/types/enums';
import { APP_EVENTS } from '@common/events/app.events';
import {
  PAYOUT_ACCOUNT_NOT_FOUND_MESSAGE,
  PAYOUT_CHECK_MAX_ATTEMPTS,
  PAYOUT_CHECK_PENDING_MESSAGE,
  PAYOUT_CHECK_RETRY_BASE_MS,
  PAYOUT_NAME_MISMATCH_MESSAGE,
} from './payout-hold';

/**
 * Payout name check: before every transfer the payout account is looked up
 * again with Paystack and its name compared with the saved one. Every
 * collaborator is mocked; Paystack is never called for real.
 */
describe('PaymentsService (payout name check)', () => {
  let service: PaymentsService;

  const mockRepo = () => ({
    create: jest.fn((x: unknown) => x),
    save: jest.fn((x: unknown) => Promise.resolve(x)),
    find: jest.fn<Promise<unknown>, [unknown]>(),
    findOne: jest.fn(),
    update: jest.fn(() => Promise.resolve({ affected: 1 })),
  });

  let paymentRepo: ReturnType<typeof mockRepo>;
  let jobRepo: ReturnType<typeof mockRepo>;
  let profileRepo: ReturnType<typeof mockRepo>;
  let txPaymentRepo: ReturnType<typeof mockRepo>;
  let txProfileRepo: ReturnType<typeof mockRepo>;

  const paystack = {
    resolveAccount: jest.fn(),
    initiateTransfer: jest.fn(),
    createTransferRecipient: jest.fn(),
  };
  const config = { get: jest.fn((_k: string, fallback?: unknown) => fallback) };
  const dataSource = { transaction: jest.fn() };
  const events = { emit: jest.fn<boolean, [string, unknown]>() };

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
      payoutHoldReason: null,
      payoutCheckAttempts: 0,
      payoutCheckNextAt: null,
      payoutHoldNotifiedAt: null,
      ...overrides,
    }) as Payment;

  // Fictional details only.
  const payoutProfile = (overrides: Record<string, unknown> = {}) => ({
    id: 4,
    paystackRecipientCode: 'RCP_unit',
    payoutAccountName: 'Kofi Mensah',
    payoutAccountNumber: '0240000000',
    payoutBankCode: 'MTN',
    payoutAccountNameVerified: true,
    ...overrides,
  });

  const resolved = (accountName: string) =>
    paystack.resolveAccount.mockResolvedValue({
      status: 'resolved',
      accountName,
    });

  /**
   * The unlocked pre-check and the locked read see the same rows unless a
   * test passes a different `locked` view. The artisan context (for
   * notifications) comes from profileRepo after the pre-check.
   */
  const arrange = (
    p: Payment,
    profile: Record<string, unknown> | null,
    locked?: { payment?: Payment; profile?: Record<string, unknown> | null },
  ) => {
    paymentRepo.findOne.mockImplementation(() => Promise.resolve(p));
    profileRepo.findOne.mockImplementation((opts: { relations?: string[] }) =>
      Promise.resolve(
        opts?.relations
          ? { id: 4, user: { id: 9, firstname: 'Kofi', lastname: 'Mensah' } }
          : profile,
      ),
    );
    txPaymentRepo.findOne.mockResolvedValue(locked?.payment ?? p);
    txProfileRepo.findOne.mockResolvedValue(
      locked && 'profile' in locked ? locked.profile : profile,
    );
  };

  const onHoldEmits = () =>
    events.emit.mock.calls.filter(([e]) => e === APP_EVENTS.PAYOUT_ON_HOLD);

  beforeEach(async () => {
    jest.clearAllMocks();
    paymentRepo = mockRepo();
    jobRepo = mockRepo();
    profileRepo = mockRepo();
    txPaymentRepo = mockRepo();
    txProfileRepo = mockRepo();
    const manager = {
      getRepository: jest.fn((entity: unknown) =>
        entity === Payment ? txPaymentRepo : txProfileRepo,
      ),
    };
    dataSource.transaction.mockImplementation(
      (cb: (m: typeof manager) => unknown) => cb(manager),
    );
    jobRepo.findOne.mockResolvedValue({ id: 35, title: 'Fix kitchen sink' });
    paystack.initiateTransfer.mockResolvedValue({ transfer_code: 'TRF_new' });
    resolved('KOFI MENSAH');

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentsService,
        { provide: getRepositoryToken(Payment), useValue: paymentRepo },
        { provide: getRepositoryToken(Job), useValue: jobRepo },
        { provide: getRepositoryToken(User), useValue: mockRepo() },
        { provide: getRepositoryToken(ArtisanProfile), useValue: profileRepo },
        { provide: getDataSourceToken(), useValue: dataSource },
        { provide: PaystackService, useValue: paystack },
        { provide: ConfigService, useValue: config },
        { provide: EventEmitter2, useValue: events },
        { provide: AdminAuditService, useValue: { record: jest.fn() } },
        // Saved payment methods: no charge attempts, no card saving here.
        {
          provide: getRepositoryToken(PaymentCharge),
          useValue: {
            findOne: jest.fn().mockResolvedValue(null),
            count: jest.fn().mockResolvedValue(0),
          },
        },
        {
          provide: PaymentMethodsService,
          useValue: { saveCardFromAuthorization: jest.fn() },
        },
        { provide: PaymentAttemptsService, useValue: {} },
        { provide: DuplicateRefundService, useValue: {} },
      ],
    }).compile();
    service = module.get(PaymentsService);
  });

  afterEach(() => jest.restoreAllMocks());

  describe('match', () => {
    it('looks the account up before the transaction, then transfers', async () => {
      const p = payment({ status: PaymentStatus.HELD });
      arrange(p, payoutProfile());

      await service.capturePayment(p.reference, 35);

      expect(paystack.resolveAccount).toHaveBeenCalledWith('0240000000', 'MTN');
      expect(paystack.resolveAccount.mock.invocationCallOrder[0]).toBeLessThan(
        dataSource.transaction.mock.invocationCallOrder[0],
      );
      expect(paystack.initiateTransfer).toHaveBeenCalledTimes(1);
      expect(p.status).toBe(PaymentStatus.HELD);
      expect(p.transferCode).toBe('TRF_new');
      // A verified method is left as it is.
      expect(txProfileRepo.update).not.toHaveBeenCalled();
      expect(onHoldEmits()).toHaveLength(0);
    });

    it('accepts a bank record that adds a middle name and reorders it', async () => {
      const p = payment();
      arrange(p, payoutProfile());
      resolved('MENSAH KOFI ASANTE');

      await service.capturePayment(p.reference, 35);

      expect(paystack.initiateTransfer).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['unverified (typed while the lookup was down)', false],
      ['legacy (saved before the lookup existed)', null],
    ])(
      'verifies an %s method with Paystack’s spelling, then transfers',
      async (_label, verified) => {
        const p = payment();
        arrange(
          p,
          payoutProfile({
            payoutAccountName: 'kofi  mensah',
            payoutAccountNameVerified: verified,
          }),
        );

        await service.capturePayment(p.reference, 35);

        expect(txProfileRepo.update).toHaveBeenCalledWith(
          { id: 4, payoutAccountNumber: '0240000000', payoutBankCode: 'MTN' },
          { payoutAccountNameVerified: true, payoutAccountName: 'KOFI MENSAH' },
        );
        expect(paystack.initiateTransfer).toHaveBeenCalledTimes(1);
      },
    );

    it('clears an earlier hold when the transfer starts', async () => {
      const p = payment({
        status: PaymentStatus.PENDING_TRANSFER,
        payoutHoldReason: 'payout_check_pending',
        payoutCheckAttempts: 3,
        payoutCheckNextAt: new Date(),
      });
      arrange(p, payoutProfile());

      await service.capturePayment(p.reference, 35);

      expect(p).toMatchObject({
        status: PaymentStatus.HELD,
        transferCode: 'TRF_new',
        payoutHoldReason: null,
        payoutCheckAttempts: 0,
        payoutCheckNextAt: null,
      });
    });
  });

  describe('blocked', () => {
    it('holds a payout whose name differs, marks the method unverified and tells the artisan once', async () => {
      const p = payment({ status: PaymentStatus.HELD });
      arrange(p, payoutProfile());
      resolved('AMA SERWAA BOATENG');

      await service.capturePayment(p.reference, 35);

      expect(paystack.initiateTransfer).not.toHaveBeenCalled();
      expect(p).toMatchObject({
        status: PaymentStatus.PENDING_TRANSFER,
        payoutHoldReason: 'payout_name_mismatch',
        payoutCheckNextAt: null,
      });
      expect(p.payoutHoldNotifiedAt).toBeInstanceOf(Date);
      expect(p.transferReference).toBeUndefined();
      expect(txProfileRepo.update).toHaveBeenCalledWith(
        { id: 4, payoutAccountNumber: '0240000000', payoutBankCode: 'MTN' },
        { payoutAccountNameVerified: false },
      );
      expect(onHoldEmits()).toEqual([
        [
          APP_EVENTS.PAYOUT_ON_HOLD,
          {
            artisanUserId: 9,
            paymentId: 7,
            jobId: 35,
            jobTitle: 'Fix kitchen sink',
            reason: 'payout_name_mismatch',
          },
        ],
      ]);

      // Retried (scheduler, artisan or admin): still held, not told again.
      await service.capturePayment(p.reference, 35);
      await service.capturePayment(p.reference, 35);
      expect(paystack.initiateTransfer).not.toHaveBeenCalled();
      expect(onHoldEmits()).toHaveLength(1);
    });

    it('holds a payout whose account Paystack can no longer find', async () => {
      const p = payment({ status: PaymentStatus.TRANSFER_FAILED });
      arrange(p, payoutProfile());
      paystack.resolveAccount.mockResolvedValue({ status: 'unresolvable' });

      await service.capturePayment(p.reference, 35);

      expect(paystack.initiateTransfer).not.toHaveBeenCalled();
      expect(p).toMatchObject({
        status: PaymentStatus.PENDING_TRANSFER,
        payoutHoldReason: 'payout_account_not_found',
      });
      expect(txProfileRepo.update).toHaveBeenCalledWith(expect.anything(), {
        payoutAccountNameVerified: false,
      });
      expect(onHoldEmits()[0][1]).toMatchObject({
        reason: 'payout_account_not_found',
      });
    });

    it('holds a legacy method with no number on file without calling Paystack', async () => {
      const p = payment();
      arrange(p, payoutProfile({ payoutAccountNumber: null }));

      await service.capturePayment(p.reference, 35);

      expect(paystack.resolveAccount).not.toHaveBeenCalled();
      expect(paystack.initiateTransfer).not.toHaveBeenCalled();
      expect(p.payoutHoldReason).toBe('payout_account_not_found');
    });

    it('does not tell the artisan again after a pending check in between', async () => {
      const p = payment();
      arrange(p, payoutProfile());
      resolved('AMA BOATENG');
      await service.capturePayment(p.reference, 35);
      paystack.resolveAccount.mockResolvedValue({ status: 'unavailable' });
      await service.capturePayment(p.reference, 35);
      expect(p.payoutHoldReason).toBe('payout_check_pending');
      resolved('AMA BOATENG');
      await service.capturePayment(p.reference, 35);

      expect(p.payoutHoldReason).toBe('payout_name_mismatch');
      expect(onHoldEmits()).toHaveLength(1);
    });

    it('never logs the name or the full number', async () => {
      const spies = (['log', 'warn', 'error'] as const).map((level) =>
        jest.spyOn(Logger.prototype, level).mockImplementation(),
      );
      const p = payment();
      arrange(p, payoutProfile());
      resolved('AMA BOATENG');
      await service.capturePayment(p.reference, 35);
      paystack.resolveAccount.mockResolvedValue({ status: 'unavailable' });
      await service.capturePayment(p.reference, 35);

      const logged = spies
        .flatMap((s) => s.mock.calls)
        .map((c) => String(c[0]))
        .join('\n');
      expect(logged).toContain('••••0000');
      expect(logged).not.toMatch(/0240000000|Kofi|KOFI|Mensah|AMA|Boateng/i);
    });
  });

  describe('check pending', () => {
    it('sends nothing, blames no one and schedules a retry when Paystack is unavailable', async () => {
      const p = payment();
      arrange(p, payoutProfile());
      paystack.resolveAccount.mockResolvedValue({ status: 'unavailable' });
      const before = Date.now();

      await service.capturePayment(p.reference, 35);

      expect(paystack.initiateTransfer).not.toHaveBeenCalled();
      expect(p).toMatchObject({
        status: PaymentStatus.PENDING_TRANSFER,
        payoutHoldReason: 'payout_check_pending',
        payoutCheckAttempts: 1,
      });
      const next = p.payoutCheckNextAt!.getTime();
      expect(next).toBeGreaterThanOrEqual(before + PAYOUT_CHECK_RETRY_BASE_MS);
      expect(next).toBeLessThanOrEqual(Date.now() + PAYOUT_CHECK_RETRY_BASE_MS);
      // The method's verification is untouched and nobody is notified.
      expect(txProfileRepo.update).not.toHaveBeenCalled();
      expect(events.emit).not.toHaveBeenCalled();
    });

    it('treats a lookup that throws as unavailable', async () => {
      const p = payment();
      arrange(p, payoutProfile());
      paystack.resolveAccount.mockRejectedValue(new Error('socket hang up'));

      await expect(
        service.capturePayment(p.reference, 35),
      ).resolves.toBeUndefined();
      expect(p.payoutHoldReason).toBe('payout_check_pending');
      expect(paystack.initiateTransfer).not.toHaveBeenCalled();
    });

    it('backs off on each pending check and alerts admins once at the cap', async () => {
      const p = payment();
      arrange(p, payoutProfile());
      paystack.resolveAccount.mockResolvedValue({ status: 'unavailable' });

      const delays: Array<number | null> = [];
      for (let i = 0; i < PAYOUT_CHECK_MAX_ATTEMPTS + 1; i++) {
        const t = Date.now();
        await service.capturePayment(p.reference, 35);
        delays.push(
          p.payoutCheckNextAt
            ? Math.round((p.payoutCheckNextAt.getTime() - t) / 60_000)
            : null,
        );
      }

      expect(delays).toEqual([30, 60, 120, 240, 480, 720, 720, null, null]);
      expect(p.payoutCheckAttempts).toBe(PAYOUT_CHECK_MAX_ATTEMPTS + 1);
      const adminAlerts = events.emit.mock.calls.filter(
        ([e]) => e === APP_EVENTS.PAYMENT_TRANSFER_FAILED,
      );
      expect(adminAlerts).toHaveLength(1);
      expect(adminAlerts[0][1]).toMatchObject({
        paymentId: 7,
        reason: expect.stringContaining("couldn't be checked") as string,
      });
      expect(onHoldEmits()).toHaveLength(0);
    });

    it('sends nothing when the payout details changed between the check and the lock', async () => {
      const p = payment();
      arrange(p, payoutProfile(), {
        profile: payoutProfile({ payoutAccountNumber: '0550000000' }),
      });

      await service.capturePayment(p.reference, 35);

      expect(paystack.initiateTransfer).not.toHaveBeenCalled();
      expect(p.payoutHoldReason).toBe('payout_check_pending');
    });
  });

  describe('idempotency', () => {
    it('skips the lookup and the transfer when a transfer is already in flight', async () => {
      const p = payment({ transferCode: 'TRF_existing' });
      arrange(p, payoutProfile());

      await service.capturePayment(p.reference, 35);

      expect(paystack.resolveAccount).not.toHaveBeenCalled();
      expect(paystack.initiateTransfer).not.toHaveBeenCalled();
      expect(txPaymentRepo.save).not.toHaveBeenCalled();
    });

    it('does not transfer twice when a concurrent capture won the lock', async () => {
      const p = payment();
      arrange(p, payoutProfile(), {
        payment: payment({ transferCode: 'TRF_first' }),
      });

      await service.capturePayment(p.reference, 35);

      expect(paystack.resolveAccount).toHaveBeenCalledTimes(1);
      expect(paystack.initiateTransfer).not.toHaveBeenCalled();
      expect(txPaymentRepo.save).not.toHaveBeenCalled();
    });

    it('re-checks the state under the lock: a payment refunded meanwhile is left alone', async () => {
      const p = payment();
      arrange(p, payoutProfile(), {
        payment: payment({ status: PaymentStatus.REFUNDED }),
      });

      await service.capturePayment(p.reference, 35);

      expect(paystack.initiateTransfer).not.toHaveBeenCalled();
      expect(txPaymentRepo.save).not.toHaveBeenCalled();
    });

    it('keeps the no-payout-method path: parked with no hold reason, no lookup', async () => {
      const p = payment({ payoutHoldReason: 'payout_check_pending' });
      arrange(p, { id: 4 });

      await service.capturePayment(p.reference, 35);

      expect(paystack.resolveAccount).not.toHaveBeenCalled();
      expect(p).toMatchObject({
        status: PaymentStatus.PENDING_TRANSFER,
        payoutHoldReason: null,
      });
    });
  });

  describe('retryPendingTransfer', () => {
    beforeEach(() => {
      // The artisan's own profile, looked up by user id.
      profileRepo.findOne.mockResolvedValue(payoutProfile());
    });

    it.each([
      [
        'payout_name_mismatch',
        UnprocessableEntityException,
        PAYOUT_NAME_MISMATCH_MESSAGE,
      ],
      [
        'payout_account_not_found',
        UnprocessableEntityException,
        PAYOUT_ACCOUNT_NOT_FOUND_MESSAGE,
      ],
      [
        'payout_check_pending',
        ServiceUnavailableException,
        PAYOUT_CHECK_PENDING_MESSAGE,
      ],
    ] as const)(
      'says what is wrong when the payout is still held (%s)',
      async (reason, type, message) => {
        const held = payment({
          status: PaymentStatus.PENDING_TRANSFER,
          payoutHoldReason: reason,
        });
        paymentRepo.findOne.mockResolvedValue(held);
        jest.spyOn(service, 'capturePayment').mockResolvedValue(undefined);

        const err = await service
          .retryPendingTransfer(9, 35)
          .catch((e: unknown) => e);
        expect(err).toBeInstanceOf(type);
        expect((err as Error).message).toBe(message);
      },
    );
  });

  describe('releaseWithheldPayment', () => {
    it.each([
      ['payout_name_mismatch', "doesn't match"],
      ['payout_account_not_found', "couldn't be found"],
      ['payout_check_pending', 'retried automatically'],
    ] as const)(
      'refuses with the hold reason (%s) so a dispute ruling is not reported as paid',
      async (reason, text) => {
        paymentRepo.findOne
          .mockResolvedValueOnce(payment())
          .mockResolvedValueOnce(
            payment({
              status: PaymentStatus.PENDING_TRANSFER,
              payoutHoldReason: reason,
            }),
          );
        jest.spyOn(service, 'capturePayment').mockResolvedValue(undefined);

        await expect(service.releaseWithheldPayment(7)).rejects.toThrow(text);
      },
    );
  });

  describe('fixing payout details', () => {
    const momo = {
      type: 'mobile_money' as const,
      accountNumber: '0550000000',
      bankCode: 'MTN',
    };

    it('retries held payouts with the new details, which pass the check', async () => {
      const profile: Record<string, unknown> = payoutProfile({
        payoutAccountNameVerified: false,
      });
      const held = payment({
        status: PaymentStatus.PENDING_TRANSFER,
        payoutHoldReason: 'payout_name_mismatch',
        payoutHoldNotifiedAt: new Date('2026-10-01T00:00:00Z'),
      });
      arrange(held, profile);
      paymentRepo.find.mockResolvedValue([held]);
      paystack.createTransferRecipient.mockResolvedValue({
        recipient_code: 'RCP_fixed',
      });

      const res = await service.setupPayoutMethod(9, momo);

      expect(paymentRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            artisanProfileId: 4,
            status: PaymentStatus.PENDING_TRANSFER,
          }) as object,
        }),
      );
      expect(paystack.resolveAccount).toHaveBeenLastCalledWith(
        '0550000000',
        'MTN',
      );
      expect(paystack.initiateTransfer).toHaveBeenCalledWith(
        expect.objectContaining({ recipientCode: 'RCP_fixed' }),
      );
      expect(held).toMatchObject({
        status: PaymentStatus.HELD,
        transferCode: 'TRF_new',
        payoutHoldReason: null,
      });
      expect(res.data).toMatchObject({
        accountNameVerified: true,
        payoutsRetried: 1,
        payoutsStillOnHold: 0,
      });
    });

    it('counts a payout still on hold and never fails the save', async () => {
      const profile: Record<string, unknown> = payoutProfile();
      const held = payment({
        status: PaymentStatus.PENDING_TRANSFER,
        payoutHoldReason: 'payout_account_not_found',
      });
      arrange(held, profile);
      paymentRepo.find.mockResolvedValue([held]);
      paystack.createTransferRecipient.mockResolvedValue({
        recipient_code: 'RCP_fixed',
      });
      // The save's lookup names the account; at capture it can't be found.
      paystack.resolveAccount
        .mockResolvedValueOnce({
          status: 'resolved',
          accountName: 'KOFI MENSAH',
        })
        .mockResolvedValue({ status: 'unresolvable' });

      await expect(service.setupPayoutMethod(9, momo)).resolves.toMatchObject({
        data: { payoutsRetried: 1, payoutsStillOnHold: 1 },
      });
      expect(paystack.initiateTransfer).not.toHaveBeenCalled();
    });

    it('keeps the save when listing held payouts fails', async () => {
      profileRepo.findOne.mockResolvedValue(payoutProfile());
      paymentRepo.find.mockRejectedValue(new Error('db busy'));
      paystack.createTransferRecipient.mockResolvedValue({
        recipient_code: 'RCP_fixed',
      });
      jest.spyOn(Logger.prototype, 'error').mockImplementation();

      await expect(service.setupPayoutMethod(9, momo)).resolves.toMatchObject({
        data: { payoutsRetried: 0, payoutsStillOnHold: 0 },
      });
    });

    it('keeps the save when a retried capture throws', async () => {
      profileRepo.findOne.mockResolvedValue(payoutProfile());
      paymentRepo.find.mockResolvedValue([
        payment({
          status: PaymentStatus.PENDING_TRANSFER,
          payoutHoldReason: 'payout_name_mismatch',
        }),
      ]);
      paymentRepo.findOne.mockResolvedValue(null);
      paystack.createTransferRecipient.mockResolvedValue({
        recipient_code: 'RCP_fixed',
      });
      jest
        .spyOn(service, 'capturePayment')
        .mockRejectedValue(new Error('Insufficient balance'));
      jest.spyOn(Logger.prototype, 'error').mockImplementation();

      await expect(service.setupPayoutMethod(9, momo)).resolves.toMatchObject({
        data: { payoutsRetried: 1, payoutsStillOnHold: 0 },
      });
    });
  });

  describe('retryDuePayoutChecks', () => {
    it('retries only due pending checks and reports what was sent', async () => {
      const now = new Date('2026-11-01T10:00:00Z');
      const a = payment({ id: 7, reference: 'ref-a', jobId: 35 });
      const b = payment({ id: 8, reference: 'ref-b', jobId: 36 });
      paymentRepo.find.mockResolvedValue([a, b]);
      const capture = jest
        .spyOn(service, 'capturePayment')
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('Insufficient balance'));
      paymentRepo.findOne.mockResolvedValueOnce({
        ...a,
        status: PaymentStatus.HELD,
        transferCode: 'TRF_a',
      });
      jest.spyOn(Logger.prototype, 'error').mockImplementation();

      await expect(service.retryDuePayoutChecks(now)).resolves.toEqual({
        candidates: 2,
        sent: 1,
        failed: 1,
      });
      const where = (
        paymentRepo.find.mock.calls[0][0] as {
          where: Record<string, unknown>;
        }
      ).where;
      expect(where).toMatchObject({
        status: PaymentStatus.PENDING_TRANSFER,
        payoutHoldReason: 'payout_check_pending',
      });
      expect(where.payoutCheckNextAt).toMatchObject({
        _type: 'lessThanOrEqual',
        _value: now,
      });
      expect(capture.mock.calls).toEqual([
        ['ref-a', 35],
        ['ref-b', 36],
      ]);
    });
  });
});

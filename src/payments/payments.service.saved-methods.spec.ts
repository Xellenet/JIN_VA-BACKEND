import { Test } from '@nestjs/testing';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PaymentsService } from './payments.service';
import { Payment } from './entities/payment.entity';
import { PaymentCharge } from './entities/payment-charge.entity';
import { Job } from '@jobs/entities/job.entity';
import { User } from '@users/entities/user.entity';
import { ArtisanProfile } from '@users/entities/artisan-profile.entity';
import { PaystackService } from './paystack.service';
import { AdminAuditService } from '../admin-audit/admin-audit.service';
import { PaymentMethodsService } from '../payment-methods/payment-methods.service';
import { PaymentStatus } from '@common/types/enums';
import { CHARGE_MESSAGES } from './charge-outcome';

/**
 * Saved payment methods inside PaymentsService: the opt-in recorded at
 * initialise, the saved-method charge.success path (same PENDING → HELD as
 * the hosted checkout), duplicate payments and card saving. All fictional.
 */
describe('PaymentsService (saved payment methods)', () => {
  const repo = () => ({
    findOne: jest.fn(),
    findOneOrFail: jest.fn(),
    save: jest.fn((x: unknown) => Promise.resolve(x)),
    update: jest.fn(() => Promise.resolve({ affected: 1 })),
    count: jest.fn(() => Promise.resolve(0)),
  });
  let paymentRepo: ReturnType<typeof repo>;
  let chargeRepo: ReturnType<typeof repo>;
  let txPayments: ReturnType<typeof repo>;
  let txCharges: ReturnType<typeof repo>;
  const jobRepo = repo();
  const userRepo = repo();
  const profileRepo = repo();
  const paystack = {
    initializeTransaction: jest.fn(),
    verifyWebhookSignature: jest.fn(() => true),
  };
  const events = { emit: jest.fn() };
  const methods = { saveCardFromAuthorization: jest.fn() };
  let service: PaymentsService;

  const pending = (over: Partial<Payment> = {}) =>
    ({
      id: 7,
      jobId: 35,
      customerId: 22,
      artisanProfileId: 4,
      amount: 350,
      currency: 'GHS',
      reference: 'jinva-35-22-1',
      status: PaymentStatus.PENDING,
      saveCardRequested: false,
      ...over,
    }) as Payment;

  beforeEach(async () => {
    jest.clearAllMocks();
    paymentRepo = repo();
    chargeRepo = repo();
    txPayments = repo();
    txCharges = repo();
    jobRepo.findOne.mockResolvedValue({ id: 35, title: 'Fix tap' });
    profileRepo.findOne.mockResolvedValue(null);
    const manager = {
      getRepository: (e: unknown) => (e === Payment ? txPayments : txCharges),
    };
    const mod = await Test.createTestingModule({
      providers: [
        PaymentsService,
        { provide: getRepositoryToken(Payment), useValue: paymentRepo },
        { provide: getRepositoryToken(Job), useValue: jobRepo },
        { provide: getRepositoryToken(User), useValue: userRepo },
        { provide: getRepositoryToken(ArtisanProfile), useValue: profileRepo },
        { provide: getRepositoryToken(PaymentCharge), useValue: chargeRepo },
        {
          provide: getDataSourceToken(),
          useValue: {
            transaction: (cb: (m: unknown) => unknown) => cb(manager),
          },
        },
        { provide: PaystackService, useValue: paystack },
        {
          provide: ConfigService,
          useValue: { get: (_k: string, d?: unknown) => d },
        },
        { provide: EventEmitter2, useValue: events },
        { provide: AdminAuditService, useValue: { record: jest.fn() } },
        { provide: PaymentMethodsService, useValue: methods },
      ],
    }).compile();
    service = mod.get(PaymentsService);
  });

  const send = (data: Record<string, unknown>) =>
    service.processWebhook(
      JSON.stringify({ event: 'charge.success', data }),
      'sig',
    );

  describe('initialise records the save-card opt-in on the payment row', () => {
    beforeEach(() => {
      userRepo.findOneOrFail.mockResolvedValue({
        id: 22,
        email: 'a@example.test',
      });
      paystack.initializeTransaction.mockResolvedValue({
        authorization_url: 'https://checkout.paystack.test/x',
        access_code: 'ac',
        reference: 'jinva-35-22-1',
      });
    });

    it('saveCard: true sets the flag and tells Paystack in metadata', async () => {
      paymentRepo.findOne.mockResolvedValue(pending());
      await service.initializePayment(22, 35, { saveCard: true });
      expect(paymentRepo.update).toHaveBeenCalledWith(
        { id: 7 },
        { saveCardRequested: true },
      );
      expect(paystack.initializeTransaction).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({ save_card: true }) as unknown,
        }),
      );
    });

    it('no opt-in: no write, and the metadata is exactly as before', async () => {
      paymentRepo.findOne.mockResolvedValue(pending());
      await service.initializePayment(22, 35);
      expect(paymentRepo.update).not.toHaveBeenCalled();
      expect(
        (
          paystack.initializeTransaction.mock.calls as unknown as Array<
            [{ metadata: unknown }]
          >
        )[0][0].metadata,
      ).toEqual({
        jobId: 35,
        customerId: 22,
        paymentId: 7,
      });
    });

    it('a later initialise without the tick clears it, even on a reused session', async () => {
      paymentRepo.findOne.mockResolvedValue(
        pending({
          saveCardRequested: true,
          authorizationUrl: 'https://checkout.paystack.test/x',
          accessCode: 'ac',
        }),
      );
      await service.initializePayment(22, 35, { saveCard: false });
      expect(paymentRepo.update).toHaveBeenCalledWith(
        { id: 7 },
        { saveCardRequested: false },
      );
      expect(paystack.initializeTransaction).not.toHaveBeenCalled();
    });
  });

  describe('hosted charge.success and card saving', () => {
    const data = {
      reference: 'jinva-35-22-1',
      amount: 35000,
      currency: 'GHS',
      channel: 'card',
      paid_at: '2026-11-01T10:00:00Z',
      authorization: { reusable: true, channel: 'card' },
    };

    it('saves the card only when the payment row carries the opt-in', async () => {
      paymentRepo.findOne.mockResolvedValue(
        pending({ saveCardRequested: true }),
      );
      methods.saveCardFromAuthorization.mockResolvedValue('saved');
      await send(data);
      expect(methods.saveCardFromAuthorization).toHaveBeenCalledWith(
        22,
        data.authorization,
      );
    });

    it('ignores save_card in webhook metadata when the row has no opt-in', async () => {
      paymentRepo.findOne.mockResolvedValue(pending());
      await send({ ...data, metadata: { save_card: true } });
      expect(methods.saveCardFromAuthorization).not.toHaveBeenCalled();
    });

    it('a failed card save never fails the webhook', async () => {
      const p = pending({ saveCardRequested: true });
      paymentRepo.findOne.mockResolvedValue(p);
      methods.saveCardFromAuthorization.mockRejectedValue(new Error('db'));
      await expect(send(data)).resolves.toBeUndefined();
      expect(p.status).toBe(PaymentStatus.HELD);
    });

    it('a hosted payment after a saved-method charge paid the job changes nothing', async () => {
      const p = pending({ status: PaymentStatus.HELD });
      paymentRepo.findOne.mockResolvedValue(p);
      chargeRepo.count.mockResolvedValue(1);
      await send(data);
      expect(paymentRepo.save).not.toHaveBeenCalled();
    });
  });

  describe('saved-method charge.success', () => {
    const data = {
      reference: 'jinva-ch-7-1',
      amount: 35000,
      currency: 'GHS',
      channel: 'mobile_money',
      paid_at: '2026-11-01T10:00:00Z',
    };
    const charge = (over: Partial<PaymentCharge> = {}) =>
      ({
        id: 3,
        paymentId: 7,
        reference: 'jinva-ch-7-1',
        methodType: 'mobile_money',
        status: 'pending',
        ...over,
      }) as PaymentCharge;

    beforeEach(() => {
      paymentRepo.findOne.mockResolvedValue(null);
      chargeRepo.findOne.mockResolvedValue(charge());
    });

    it('moves the payment PENDING → HELD, marks the attempt succeeded and notifies once', async () => {
      const p = pending();
      txCharges.findOne.mockResolvedValue(charge());
      txPayments.findOne.mockResolvedValue(p);
      await send(data);
      expect(p.status).toBe(PaymentStatus.HELD);
      expect(p.channel).toBe('mobile_money');
      expect(txPayments.save).toHaveBeenCalledWith(p);
      expect(txCharges.update).toHaveBeenCalledWith(
        { id: 3 },
        { status: 'succeeded', action: null, message: null },
      );
      expect(events.emit).toHaveBeenCalled();
    });

    it('a redelivery changes nothing', async () => {
      txCharges.findOne.mockResolvedValue(charge({ status: 'succeeded' }));
      txPayments.findOne.mockResolvedValue(
        pending({ status: PaymentStatus.HELD }),
      );
      await send(data);
      expect(txPayments.save).not.toHaveBeenCalled();
      expect(events.emit).not.toHaveBeenCalled();
    });

    it('an amount mismatch is refused', async () => {
      txCharges.findOne.mockResolvedValue(charge());
      txPayments.findOne.mockResolvedValue(pending());
      await send({ ...data, amount: 100 });
      expect(txPayments.save).not.toHaveBeenCalled();
    });

    it('a second payment for an already-paid job is marked duplicate', async () => {
      txCharges.findOne.mockResolvedValue(charge());
      txPayments.findOne.mockResolvedValue(
        pending({ status: PaymentStatus.HELD }),
      );
      await send(data);
      expect(txCharges.update).toHaveBeenCalledWith(
        { id: 3 },
        {
          status: 'duplicate',
          action: null,
          message: CHARGE_MESSAGES.DUPLICATE,
        },
      );
      expect(txPayments.save).not.toHaveBeenCalled();
    });

    it('a vanished charge or payment is ignored', async () => {
      txCharges.findOne.mockResolvedValue(null);
      await service.applySavedChargeSuccess(3, data);
      txCharges.findOne.mockResolvedValue(charge());
      txPayments.findOne.mockResolvedValue(null);
      await service.applySavedChargeSuccess(3, { ...data, reference: 1 });
      expect(txPayments.save).not.toHaveBeenCalled();
    });

    it('an unknown reference is ignored', async () => {
      chargeRepo.findOne.mockResolvedValue(null);
      await send(data);
      expect(txPayments.findOne).not.toHaveBeenCalled();
    });
  });
});

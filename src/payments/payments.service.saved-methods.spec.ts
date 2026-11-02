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
import { PaymentAttemptsService } from './payment-attempts.service';
import { DuplicateRefundService } from './duplicate-refund.service';
import { chargeStore, type ChargeStore } from '../../test/support/charge-store';

/**
 * Saved payment methods inside PaymentsService: the opt-in recorded at
 * initialise, the shared charge.success path (the same locked PENDING → HELD
 * for the hosted checkout and saved methods), duplicate payments (refunded
 * automatically) and card saving. All fictional.
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
  let txPayments: ReturnType<typeof repo>;
  /** Attempts, shared by the repository and the transaction. */
  let charges: ChargeStore;
  const jobRepo = repo();
  const userRepo = repo();
  const profileRepo = repo();
  const paystack = {
    initializeTransaction: jest.fn(),
    verifyWebhookSignature: jest.fn(() => true),
  };
  const events = { emit: jest.fn() };
  const methods = { saveCardFromAuthorization: jest.fn() };
  const attempts = { claim: jest.fn(), jobState: jest.fn() };
  const refunds = { process: jest.fn(), onRefundWebhook: jest.fn() };
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
      paidReference: null,
      ...over,
    }) as Payment;

  /** The payment for both the unlocked and the locked read. */
  const arrange = (p: Payment) => {
    paymentRepo.findOne.mockResolvedValue(p);
    txPayments.findOne.mockResolvedValue(p);
    return p;
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    paymentRepo = repo();
    txPayments = repo();
    charges = chargeStore();
    jobRepo.findOne.mockResolvedValue({ id: 35, title: 'Fix tap' });
    profileRepo.findOne.mockResolvedValue(null);
    const manager = {
      getRepository: (e: unknown) => (e === Payment ? txPayments : charges),
    };
    const mod = await Test.createTestingModule({
      providers: [
        PaymentsService,
        { provide: getRepositoryToken(Payment), useValue: paymentRepo },
        { provide: getRepositoryToken(Job), useValue: jobRepo },
        { provide: getRepositoryToken(User), useValue: userRepo },
        { provide: getRepositoryToken(ArtisanProfile), useValue: profileRepo },
        { provide: getRepositoryToken(PaymentCharge), useValue: charges },
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
        { provide: PaymentAttemptsService, useValue: attempts },
        { provide: DuplicateRefundService, useValue: refunds },
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
    const claimed = (p: Payment, existing = false) => {
      const charge = charges.add({
        paymentId: 7,
        reference: p.reference,
        methodType: 'hosted',
        status: 'hosted_open',
        ...(existing
          ? {
              authorizationUrl: 'https://checkout.paystack.test/x',
              accessCode: 'ac',
            }
          : {}),
      });
      attempts.claim.mockResolvedValue({
        outcome: existing ? 'existing' : 'created',
        payment: p,
        charge,
      });
      return charge;
    };

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
      claimed(pending());
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

    it('no opt-in: no opt-in write, and the metadata names the attempt', async () => {
      const charge = claimed(pending());
      await service.initializePayment(22, 35);
      expect(paymentRepo.update).not.toHaveBeenCalledWith(
        { id: 7 },
        expect.objectContaining({
          saveCardRequested: expect.anything() as unknown,
        }),
      );
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
        chargeId: charge.id,
      });
    });

    it('a later initialise without the tick clears it, even on a reused session', async () => {
      claimed(pending({ saveCardRequested: true }), true);
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
    const hosted = () =>
      charges.add({
        paymentId: 7,
        customerId: 22,
        reference: 'jinva-35-22-1',
        methodType: 'hosted',
        status: 'hosted_open',
      });

    it('saves the card only when the payment row carries the opt-in', async () => {
      hosted();
      arrange(pending({ saveCardRequested: true }));
      methods.saveCardFromAuthorization.mockResolvedValue('saved');
      await send(data);
      expect(methods.saveCardFromAuthorization).toHaveBeenCalledWith(
        22,
        data.authorization,
      );
    });

    it('ignores save_card in webhook metadata when the row has no opt-in', async () => {
      hosted();
      arrange(pending());
      await send({ ...data, metadata: { save_card: true } });
      expect(methods.saveCardFromAuthorization).not.toHaveBeenCalled();
    });

    it('a failed card save never fails the webhook', async () => {
      hosted();
      const p = arrange(pending({ saveCardRequested: true }));
      methods.saveCardFromAuthorization.mockRejectedValue(new Error('db'));
      await expect(send(data)).resolves.toBeUndefined();
      expect(p.status).toBe(PaymentStatus.HELD);
      expect(p.paidReference).toBe('jinva-35-22-1');
    });

    it('takes the same row lock as a saved-method charge', async () => {
      hosted();
      arrange(pending());
      await send(data);
      expect(txPayments.findOne).toHaveBeenCalledWith({
        where: { id: 7 },
        lock: { mode: 'pessimistic_write' },
      });
    });

    it('a hosted payment after a saved-method charge paid the job is refunded automatically', async () => {
      const row = hosted();
      const p = arrange(
        pending({
          status: PaymentStatus.HELD,
          paidReference: 'jinva-ch-7-1',
        }),
      );
      await send(data);
      expect(txPayments.save).not.toHaveBeenCalled();
      expect(p.status).toBe(PaymentStatus.HELD);
      expect(charges.rows.get(row.id)).toMatchObject({
        status: 'duplicate',
        refundStatus: 'pending',
        refundAmount: 350,
      });
      expect(refunds.process).toHaveBeenCalledWith(row.id);
      expect(methods.saveCardFromAuthorization).not.toHaveBeenCalled();
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
      charges.add({
        id: 3,
        paymentId: 7,
        reference: 'jinva-ch-7-1',
        methodType: 'mobile_money',
        status: 'pending',
        ...over,
      });

    it('moves the payment PENDING → HELD, marks the attempt succeeded and notifies once', async () => {
      charge();
      const p = arrange(pending());
      await send(data);
      expect(p.status).toBe(PaymentStatus.HELD);
      expect(p.channel).toBe('mobile_money');
      expect(p.paidReference).toBe('jinva-ch-7-1');
      expect(txPayments.save).toHaveBeenCalledWith(p);
      expect(charges.rows.get(3)).toMatchObject({
        status: 'succeeded',
        action: null,
        message: null,
        channel: 'mobile_money',
      });
      expect(events.emit).toHaveBeenCalled();
    });

    it('a redelivery changes nothing', async () => {
      charge({ status: 'succeeded' });
      arrange(pending({ status: PaymentStatus.HELD }));
      await send(data);
      expect(txPayments.save).not.toHaveBeenCalled();
      expect(events.emit).not.toHaveBeenCalled();
    });

    it('an amount mismatch is refused', async () => {
      charge();
      arrange(pending());
      await send({ ...data, amount: 100 });
      expect(txPayments.save).not.toHaveBeenCalled();
      expect(charges.rows.get(3)?.status).toBe('pending');
    });

    it('a second payment for an already-paid job is a duplicate, refunded once', async () => {
      charge();
      arrange(
        pending({ status: PaymentStatus.HELD, paidReference: 'jinva-35-22-1' }),
      );
      await send(data);
      expect(charges.rows.get(3)).toMatchObject({
        status: 'duplicate',
        action: null,
        message: CHARGE_MESSAGES.DUPLICATE,
        refundStatus: 'pending',
      });
      expect(txPayments.save).not.toHaveBeenCalled();
      expect(refunds.process).toHaveBeenCalledTimes(1);
      await send(data); // Paystack retries the webhook.
      expect(refunds.process).toHaveBeenCalledTimes(1);
    });

    it('never refunds the reference that holds the money', async () => {
      charge();
      arrange(
        pending({ status: PaymentStatus.HELD, paidReference: 'jinva-ch-7-1' }),
      );
      await send(data);
      expect(charges.rows.get(3)?.status).toBe('succeeded');
      expect(refunds.process).not.toHaveBeenCalled();
    });

    it('a cancelled job that is charged anyway is refunded', async () => {
      charge({ status: 'cancelled' });
      arrange(pending({ status: PaymentStatus.CANCELLED }));
      await send(data);
      expect(charges.rows.get(3)?.status).toBe('duplicate');
      expect(refunds.process).toHaveBeenCalledWith(3);
    });

    it('a vanished charge or payment is ignored', async () => {
      await service.applyChargeSuccess(3, data);
      charge();
      txPayments.findOne.mockResolvedValue(null);
      await service.applySavedChargeSuccess(3, { ...data, reference: 1 });
      expect(txPayments.save).not.toHaveBeenCalled();
    });

    it('an unknown reference is ignored', async () => {
      paymentRepo.findOne.mockResolvedValue(null);
      await send(data);
      expect(txPayments.findOne).not.toHaveBeenCalled();
    });
  });
});

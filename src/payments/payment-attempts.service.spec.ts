import { ConflictException, NotFoundException } from '@nestjs/common';
import type { DataSource, EntityManager, Repository } from 'typeorm';
import { PaymentStatus } from '@common/types/enums';
import { Payment } from './entities/payment.entity';
import { PaymentCharge } from './entities/payment-charge.entity';
import { PaystackRequestError, type PaystackService } from './paystack.service';
import {
  ALREADY_PAID,
  ATTEMPT_ACTIVE_MESSAGES,
  ATTEMPT_WINDOW_MS,
  PAYMENT_ATTEMPT_ACTIVE,
  PaymentAttemptsService,
} from './payment-attempts.service';
import { CustomerPaymentMethod } from '../payment-methods/entities/customer-payment-method.entity';
import { chargeStore, type ChargeStore } from '../../test/support/charge-store';

/** One active attempt per job. All values fictional. */
describe('PaymentAttemptsService', () => {
  const pending = (over: Partial<Payment> = {}) =>
    ({
      id: 7,
      jobId: 35,
      customerId: 22,
      amount: 350,
      currency: 'GHS',
      reference: 'jinva-35-22-1',
      status: PaymentStatus.PENDING,
      paidReference: null,
      paidAt: null,
      ...over,
    }) as Payment;

  let charges: ChargeStore;
  let txPayments: { findOne: jest.Mock };
  let payments: { findOne: jest.Mock };
  let methodsRepo: { find: jest.Mock };
  const paystack = { verifyTransaction: jest.fn() };
  const settle = jest.fn();
  let service: PaymentAttemptsService;

  beforeEach(() => {
    jest.clearAllMocks();
    charges = chargeStore();
    txPayments = { findOne: jest.fn().mockResolvedValue(pending()) };
    payments = { findOne: jest.fn().mockResolvedValue(pending()) };
    methodsRepo = { find: jest.fn().mockResolvedValue([]) };
    const manager = {
      getRepository: (e: unknown) => (e === Payment ? txPayments : charges),
    };
    service = new PaymentAttemptsService(
      payments as unknown as Repository<Payment>,
      charges as unknown as Repository<PaymentCharge>,
      {
        transaction: (cb: (m: unknown) => unknown) => cb(manager),
        getRepository: (e: unknown) =>
          e === CustomerPaymentMethod ? methodsRepo : charges,
      } as unknown as DataSource,
      paystack as unknown as PaystackService,
    );
  });

  const hosted = { kind: 'hosted' } as const;
  const momo = { kind: 'mobile_money', paymentMethodId: 4 } as const;
  const claim = (spec: Parameters<PaymentAttemptsService['claim']>[2]) =>
    service.claim(22, 35, spec, settle, 'Nothing due');

  describe('claim', () => {
    it('the first hosted attempt uses the payment reference; it is locked and open', async () => {
      const res = await claim(hosted);
      expect(res.outcome).toBe('created');
      expect(res.charge).toMatchObject({
        reference: 'jinva-35-22-1',
        methodType: 'hosted',
        status: 'hosted_open',
        action: 'continue_checkout',
        paymentMethodId: null,
      });
      expect(
        new Date(res.charge.expiresAt!).getTime() - Date.now(),
      ).toBeGreaterThan(ATTEMPT_WINDOW_MS.hosted - 5_000);
      expect(txPayments.findOne).toHaveBeenCalledWith({
        where: { jobId: 35, customerId: 22, status: PaymentStatus.PENDING },
        lock: { mode: 'pessimistic_write' },
      });
    });

    it('the same kind again returns the active attempt', async () => {
      const first = await claim(hosted);
      const again = await claim(hosted);
      expect(again).toMatchObject({ outcome: 'existing' });
      expect(again.charge.id).toBe(first.charge.id);
      expect(charges.rows.size).toBe(1);
    });

    it('a later hosted attempt gets its own reference (Paystack refuses a reused one)', async () => {
      charges.add({
        paymentId: 7,
        reference: 'jinva-35-22-1',
        methodType: 'hosted',
        status: 'expired',
      });
      const res = await claim(hosted);
      expect(res.charge.reference).toMatch(/^jinva-ho-7-\d+-[0-9a-f]{6}$/);
    });

    it('a saved-method charge gets its own reference and waits', async () => {
      const res = await claim(momo);
      expect(res.charge).toMatchObject({
        methodType: 'mobile_money',
        status: 'pending',
        paymentMethodId: 4,
      });
      expect(res.charge.reference).toMatch(/^jinva-ch-7-/);
    });

    it('another kind while one is active is 409 PAYMENT_ATTEMPT_ACTIVE with the attempt', async () => {
      const momoAttempt = await claim(momo);
      const err = (await claim(hosted).catch(
        (e: unknown) => e,
      )) as ConflictException;
      expect(err).toBeInstanceOf(ConflictException);
      expect(err.getResponse()).toMatchObject({
        errorCode: PAYMENT_ATTEMPT_ACTIVE,
        message: ATTEMPT_ACTIVE_MESSAGES.mobile_money,
        data: {
          reference: momoAttempt.charge.reference,
          jobId: 35,
          kind: 'mobile_money',
          status: 'pending',
          authorizationUrl: null,
        },
      });
      expect(charges.rows.size).toBe(1);
    });

    it('a paid job is 409 ALREADY_PAID with the payment; nothing due is 404', async () => {
      txPayments.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce(
        pending({
          status: PaymentStatus.HELD,
          paidReference: 'jinva-ch-7-1',
        }),
      );
      await expect(claim(hosted)).rejects.toMatchObject({
        response: expect.objectContaining({
          errorCode: ALREADY_PAID,
          data: expect.objectContaining({
            status: PaymentStatus.HELD,
            reference: 'jinva-ch-7-1',
          }) as unknown,
        }) as unknown,
      });
      txPayments.findOne
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null);
      await expect(claim(hosted)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('a unique violation on the active index (a concurrent claim) returns the winner', async () => {
      const winner = charges.add({
        paymentId: 7,
        reference: 'jinva-ch-7-1-aa',
        methodType: 'mobile_money',
        paymentMethodId: 4,
        status: 'pending',
        expiresAt: new Date(Date.now() + 60_000),
      });
      // The first transaction lost the race inside the database.
      const realFindOne = charges.findOne.getMockImplementation()!;
      charges.findOne.mockImplementationOnce(() => Promise.resolve(null));
      charges.save.mockImplementationOnce(() =>
        Promise.reject(
          Object.assign(new Error('duplicate key'), {
            code: '23505',
            constraint: 'uq_payment_charges_one_active',
          }),
        ),
      );
      charges.findOne.mockImplementation(realFindOne);
      const res = await claim(momo);
      expect(res).toMatchObject({ outcome: 'existing' });
      expect(res.charge.id).toBe(winner.id);
    });

    it('other database errors are not swallowed', async () => {
      charges.save.mockImplementationOnce(() =>
        Promise.reject(Object.assign(new Error('x'), { code: '23505' })),
      );
      await expect(claim(momo)).rejects.toThrow('x');
    });

    describe('expiry', () => {
      const openHosted = (over: Partial<PaymentCharge> = {}) =>
        charges.add({
          paymentId: 7,
          reference: 'jinva-35-22-1',
          methodType: 'hosted',
          status: 'hosted_open',
          authorizationUrl: 'https://checkout.paystack.test/x',
          expiresAt: new Date(Date.now() - 1),
          ...over,
        });

      it('a hosted attempt past its window that Paystack calls abandoned is released, then MoMo may start', async () => {
        const old = openHosted();
        paystack.verifyTransaction.mockResolvedValue({ status: 'abandoned' });
        const res = await claim(momo);
        expect(res.outcome).toBe('created');
        expect(charges.rows.get(old.id)?.status).toBe('expired');
        expect(paystack.verifyTransaction).toHaveBeenCalledWith(
          'jinva-35-22-1',
        );
      });

      it('a hosted attempt inside its window is never released, even if Paystack says abandoned', async () => {
        const open = openHosted({
          expiresAt: new Date(Date.now() + 60_000),
        });
        paystack.verifyTransaction.mockResolvedValue({ status: 'abandoned' });
        await expect(
          service.reconcile(charges.rows.get(open.id)!, settle, {
            force: true,
          }),
        ).resolves.toBe('active');
        expect(charges.rows.get(open.id)?.status).toBe('hosted_open');
      });

      it('a success found on expiry is settled, never released', async () => {
        const old = openHosted();
        paystack.verifyTransaction.mockResolvedValue({
          status: 'success',
          amount: 35000,
          currency: 'GHS',
          channel: 'card',
          paid_at: '2026-11-01T10:00:00Z',
        });
        settle.mockImplementation(() => {
          charges.rows.get(old.id)!.status = 'succeeded';
          txPayments.findOne
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(pending({ status: PaymentStatus.HELD }));
          return Promise.resolve();
        });
        await expect(claim(momo)).rejects.toMatchObject({
          response: expect.objectContaining({
            errorCode: ALREADY_PAID,
          }) as unknown,
        });
        expect(settle).toHaveBeenCalledWith(
          old.id,
          expect.objectContaining({
            reference: 'jinva-35-22-1',
            amount: 35000,
          }),
        );
        expect(charges.rows.get(old.id)?.status).toBe('succeeded');
      });

      it('Paystack unreachable: another kind is refused, the same kind gets the attempt back', async () => {
        const old = openHosted();
        paystack.verifyTransaction.mockRejectedValue(new Error('ECONNRESET'));
        await expect(claim(momo)).rejects.toMatchObject({
          response: expect.objectContaining({
            errorCode: PAYMENT_ATTEMPT_ACTIVE,
            message: ATTEMPT_ACTIVE_MESSAGES.hosted,
          }) as unknown,
        });
        const same = await claim(hosted);
        expect(same).toMatchObject({ outcome: 'existing' });
        expect(same.charge.id).toBe(old.id);
        expect(charges.rows.get(old.id)?.status).toBe('hosted_open');
      });

      it('"not found" at Paystack past the window releases it (the charge never started)', async () => {
        const old = openHosted();
        paystack.verifyTransaction.mockRejectedValue(
          new PaystackRequestError('Transaction reference not found', 400),
        );
        await expect(claim(hosted)).resolves.toMatchObject({
          outcome: 'created',
        });
        expect(charges.rows.get(old.id)?.status).toBe('expired');
      });

      it('respects the verify interval unless forced', async () => {
        const open = openHosted({
          expiresAt: new Date(Date.now() + 60_000),
          lastVerifiedAt: new Date(),
        });
        await expect(
          service.reconcile(charges.rows.get(open.id)!, settle),
        ).resolves.toBe('active');
        expect(paystack.verifyTransaction).not.toHaveBeenCalled();
        await expect(
          service.reconcile(
            { ...charges.rows.get(open.id)!, status: 'failed' },
            settle,
          ),
        ).resolves.toBe('released');
      });
    });
  });

  describe('jobState', () => {
    it('404 when the caller has no payment for the job', async () => {
      payments.findOne.mockResolvedValue(null);
      await expect(service.jobState(22, 35, settle)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('paid, with the refunded duplicate and its method label', async () => {
      payments.findOne.mockResolvedValue(
        pending({
          status: PaymentStatus.HELD,
          paidAt: new Date('2026-11-01T10:00:00Z'),
        }),
      );
      charges.add({
        paymentId: 7,
        reference: 'jinva-ch-7-2',
        methodType: 'mobile_money',
        paymentMethodId: 4,
        status: 'duplicate',
        refundStatus: 'processing',
        refundAmount: '350.00',
        createdAt: new Date('2026-11-01T10:01:00Z'),
      });
      charges.add({
        paymentId: 7,
        reference: 'jinva-ch-7-3',
        methodType: 'mobile_money',
        status: 'duplicate',
        refundStatus: null,
      });
      methodsRepo.find.mockResolvedValue([
        { id: 4, type: 'mobile_money', network: 'MTN' },
      ]);
      const state = await service.jobState(22, 35, settle);
      expect(state).toEqual({
        jobId: 35,
        paid: true,
        payment: {
          id: 7,
          status: PaymentStatus.HELD,
          amount: 350,
          currency: 'GHS',
          paidAt: '2026-11-01T10:00:00.000Z',
        },
        activeAttempt: null,
        duplicateRefunds: [
          {
            reference: 'jinva-ch-7-2',
            amount: 350,
            currency: 'GHS',
            method: 'mobile_money',
            methodLabel: 'MTN MoMo',
            status: 'pending',
            createdAt: '2026-11-01T10:01:00.000Z',
          },
        ],
      });
    });

    it('the active attempt, checked with Paystack when due', async () => {
      const a = charges.add({
        paymentId: 7,
        reference: 'jinva-ch-7-9',
        methodType: 'mobile_money',
        paymentMethodId: 4,
        status: 'needs_otp',
        action: 'enter_otp',
        createdAt: new Date(Date.now() - 20_000),
        expiresAt: new Date(Date.now() + 60_000),
      });
      paystack.verifyTransaction.mockResolvedValue({ status: 'send_otp' });
      const state = await service.jobState(22, 35, settle);
      expect(paystack.verifyTransaction).toHaveBeenCalledWith('jinva-ch-7-9');
      expect(state.paid).toBe(false);
      expect(state.activeAttempt).toMatchObject({
        reference: a.reference,
        kind: 'mobile_money',
        status: 'needs_otp',
        action: 'enter_otp',
        paymentMethodId: 4,
      });
    });

    it('a failed charge found on the check is released and no longer active', async () => {
      charges.add({
        paymentId: 7,
        reference: 'jinva-ch-7-9',
        methodType: 'mobile_money',
        status: 'pending',
        createdAt: new Date(Date.now() - 20_000),
        expiresAt: new Date(Date.now() + 60_000),
      });
      paystack.verifyTransaction.mockResolvedValue({ status: 'failed' });
      const state = await service.jobState(22, 35, settle);
      expect(state.activeAttempt).toBeNull();
    });
  });

  describe('labels and views', () => {
    it('labels a saved card, a hosted channel and an unknown method', () => {
      expect(
        PaymentAttemptsService.labelFor({ methodType: 'card', channel: null }, {
          type: 'card',
          cardBrand: 'visa',
          cardLast4: '4081',
        } as CustomerPaymentMethod),
      ).toBe('Visa card ending 4081');
      expect(
        PaymentAttemptsService.labelFor(
          { methodType: 'hosted', channel: 'mobile_money' },
          null,
        ),
      ).toBe('mobile money');
      expect(
        PaymentAttemptsService.labelFor(
          { methodType: 'card', channel: null },
          null,
        ),
      ).toBe('card');
      expect(
        PaymentAttemptsService.labelFor(
          { methodType: 'hosted', channel: null },
          null,
        ),
      ).toBe('original payment method');
    });

    it('an attempt without a stored expiry uses its kind window', () => {
      const created = new Date('2026-11-01T10:00:00Z');
      expect(
        PaymentAttemptsService.expiresAt({
          methodType: 'hosted',
          createdAt: created,
          expiresAt: null,
        } as PaymentCharge).toISOString(),
      ).toBe('2026-11-01T10:30:00.000Z');
    });

    it('treats every paid state as paid', () => {
      for (const s of [
        'HELD',
        'PENDING_TRANSFER',
        'TRANSFER_FAILED',
        'RELEASED',
        'REFUNDED',
      ]) {
        expect(PaymentAttemptsService.isPaid(s)).toBe(true);
      }
      for (const s of ['PENDING', 'CANCELLED', 'FAILED']) {
        expect(PaymentAttemptsService.isPaid(s)).toBe(false);
      }
    });
  });

  describe('cancelForAccountDeletion', () => {
    it('cancels active attempts and withdraws the save-card opt-in', async () => {
      const paymentsRepo = { update: jest.fn() };
      charges.add({ customerId: 22, reference: 'a', status: 'pending' });
      charges.add({ customerId: 22, reference: 'b', status: 'succeeded' });
      charges.add({ customerId: 99, reference: 'c', status: 'hosted_open' });
      const manager = {
        getRepository: (e: unknown) => (e === Payment ? paymentsRepo : charges),
      } as unknown as EntityManager;
      await expect(
        PaymentAttemptsService.cancelForAccountDeletion(manager, 22),
      ).resolves.toBe(1);
      expect([...charges.rows.values()].map((c) => c.status)).toEqual([
        'cancelled',
        'succeeded',
        'hosted_open',
      ]);
      expect(paymentsRepo.update).toHaveBeenCalledWith(
        { customerId: 22, saveCardRequested: true },
        { saveCardRequested: false },
      );
    });
  });
});

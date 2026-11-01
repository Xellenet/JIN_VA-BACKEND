import {
  ConflictException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { DataSource, Repository } from 'typeorm';
import type { User } from '@users/entities/user.entity';
import { Payment } from './entities/payment.entity';
import { PaymentCharge } from './entities/payment-charge.entity';
import { PaystackRequestError, type PaystackService } from './paystack.service';
import type { PaymentsService } from './payments.service';
import type { PaymentMethodsService } from '../payment-methods/payment-methods.service';
import {
  CHARGE_ACTIVE_WINDOW_MS,
  CHARGE_VERIFY_INTERVAL_MS,
  SavedMethodChargeService,
} from './saved-method-charge.service';
import { CHARGE_MESSAGES } from './charge-outcome';
import { PaymentStatus } from '@common/types/enums';
import {
  ALREADY_PAID,
  PAYMENT_ATTEMPT_ACTIVE,
  PaymentAttemptsService,
} from './payment-attempts.service';

/** All values fictional. */
describe('SavedMethodChargeService', () => {
  const payment = {
    id: 7,
    jobId: 35,
    customerId: 22,
    amount: 350,
    reference: 'jinva-35-22-1',
    status: PaymentStatus.PENDING,
  } as Payment;
  let charges: Map<number, PaymentCharge>;
  let nextId: number;

  const chargeRepo = {
    findOne: jest.fn(),
    save: jest.fn(),
    create: jest.fn((v: Partial<PaymentCharge>) => v),
    update: jest.fn(),
    count: jest.fn(() => Promise.resolve(0)),
  };
  const txPayments = { findOne: jest.fn() };
  const payments = { findOne: jest.fn() };
  const users = { findOne: jest.fn() };
  const paystack = {
    chargeMobileMoney: jest.fn(),
    chargeAuthorization: jest.fn(),
    submitChargeOtp: jest.fn(),
    verifyTransaction: jest.fn(),
  };
  const methods = { getChargeable: jest.fn() };
  const paymentsService = { applyChargeSuccess: jest.fn() };
  let service: SavedMethodChargeService;

  const momo = {
    id: 4,
    type: 'mobile_money',
    network: 'VOD',
    phone: '0200000000',
  };
  const card = {
    id: 5,
    type: 'card',
    authorizationCode: 'AUTH_fict1',
    expired: false,
  };

  const findBy = (where: Record<string, unknown>) =>
    [...charges.values()].find((c) =>
      Object.entries(where).every(([k, v]) => {
        const val = (c as unknown as Record<string, unknown>)[k];
        if (v && typeof v === 'object' && '_value' in v) {
          return (v as { _value: unknown[] })._value.includes(val);
        }
        return val === v;
      }),
    ) ?? null;

  beforeEach(() => {
    jest.clearAllMocks();
    charges = new Map();
    nextId = 1;
    chargeRepo.findOne.mockImplementation(
      ({ where }: { where: Record<string, unknown> }) =>
        Promise.resolve(findBy(where)),
    );
    chargeRepo.save.mockImplementation((v: PaymentCharge) => {
      const row = {
        ...v,
        id: nextId++,
        createdAt: new Date(),
      } as PaymentCharge;
      charges.set(row.id, row);
      return Promise.resolve(row);
    });
    chargeRepo.update.mockImplementation(
      (where: Record<string, unknown>, patch: Partial<PaymentCharge>) => {
        let affected = 0;
        for (const c of charges.values()) {
          const hit = Object.entries(where).every(([k, v]) => {
            const val = (c as unknown as Record<string, unknown>)[k];
            if (v && typeof v === 'object' && '_value' in v) {
              return (v as { _value: unknown[] })._value.includes(val);
            }
            return val === v;
          });
          if (hit) {
            Object.assign(c, patch);
            affected++;
          }
        }
        return Promise.resolve({ affected });
      },
    );
    txPayments.findOne.mockResolvedValue(payment);
    payments.findOne.mockResolvedValue(payment);
    users.findOne.mockResolvedValue({
      id: 22,
      email: 'kofi.asante@example.test',
    });
    methods.getChargeable.mockResolvedValue(momo);
    paystack.chargeMobileMoney.mockResolvedValue({
      outcome: 'ok',
      data: { status: 'pay_offline' },
    });
    const manager = {
      getRepository: (e: unknown) => (e === Payment ? txPayments : chargeRepo),
    };
    // The real attempt rules, over the same in-memory rows.
    const attempts = new PaymentAttemptsService(
      payments as unknown as Repository<Payment>,
      chargeRepo as unknown as Repository<PaymentCharge>,
      {
        transaction: (cb: (m: unknown) => unknown) => cb(manager),
      } as unknown as DataSource,
      paystack as unknown as PaystackService,
    );
    service = new SavedMethodChargeService(
      payments as unknown as Repository<Payment>,
      chargeRepo as unknown as Repository<PaymentCharge>,
      users as unknown as Repository<User>,
      paystack as unknown as PaystackService,
      methods as unknown as PaymentMethodsService,
      paymentsService as unknown as PaymentsService,
      attempts,
    );
  });

  it('charges mobile money with the decrypted number and Paystack provider code', async () => {
    const res = await service.charge(22, 35, 4);
    expect(res).toMatchObject({
      jobId: 35,
      method: 'mobile_money',
      status: 'pending',
      action: 'approve_on_phone',
    });
    expect(res.reference).toMatch(/^jinva-ch-7-/);
    expect(paystack.chargeMobileMoney).toHaveBeenCalledWith(
      expect.objectContaining({
        amountGhs: 350,
        phone: '0200000000',
        provider: 'vod',
        reference: res.reference,
        metadata: expect.objectContaining({
          paymentId: 7,
          saved_method: true,
        }) as unknown,
      }),
    );
    expect(JSON.stringify(res)).not.toContain('0200000000');
  });

  it('returns the active attempt instead of charging twice', async () => {
    const first = await service.charge(22, 35, 4);
    const second = await service.charge(22, 35, 4);
    expect(second.reference).toBe(first.reference);
    expect(paystack.chargeMobileMoney).toHaveBeenCalledTimes(1);
  });

  it('starts a new attempt once the active one is past its window and Paystack says it did not succeed', async () => {
    const first = await service.charge(22, 35, 4);
    charges.get(1)!.expiresAt = new Date(Date.now() - 1);
    paystack.verifyTransaction.mockResolvedValue({ status: 'abandoned' });
    const second = await service.charge(22, 35, 4);
    expect(second.reference).not.toBe(first.reference);
    expect(charges.get(1)!.status).toBe('failed');
    expect(paystack.verifyTransaction).toHaveBeenCalledWith(first.reference);
  });

  it('a past-window attempt Paystack cannot confirm either way stays active', async () => {
    const first = await service.charge(22, 35, 4);
    charges.get(1)!.expiresAt = new Date(Date.now() - 1);
    paystack.verifyTransaction.mockRejectedValue(new Error('ECONNRESET'));
    // Same method: the same attempt comes back.
    await expect(service.charge(22, 35, 4)).resolves.toMatchObject({
      reference: first.reference,
    });
    // Another method: 409 with the attempt.
    methods.getChargeable.mockResolvedValue({ ...momo, id: 6 });
    await expect(service.charge(22, 35, 6)).rejects.toMatchObject({
      response: expect.objectContaining({
        errorCode: PAYMENT_ATTEMPT_ACTIVE,
      }) as unknown,
    });
    expect(charges.get(1)!.status).toBe('pending');
    expect(paystack.chargeMobileMoney).toHaveBeenCalledTimes(1);
  });

  it('a past-window attempt Paystack reports as paid is settled, never released', async () => {
    await service.charge(22, 35, 4);
    charges.get(1)!.expiresAt = new Date(Date.now() - 1);
    paystack.verifyTransaction.mockResolvedValue({
      status: 'success',
      amount: 35000,
      currency: 'GHS',
      channel: 'mobile_money',
      paid_at: '2026-11-01T10:00:00Z',
    });
    paymentsService.applyChargeSuccess.mockImplementation(() => {
      charges.get(1)!.status = 'succeeded';
      txPayments.findOne
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ ...payment, status: PaymentStatus.HELD });
      return Promise.resolve();
    });
    await expect(service.charge(22, 35, 4)).rejects.toMatchObject({
      response: expect.objectContaining({ errorCode: ALREADY_PAID }) as unknown,
    });
    expect(charges.get(1)!.status).toBe('succeeded');
    expect(paystack.chargeMobileMoney).toHaveBeenCalledTimes(1);
  });

  it('another saved method while one is active is 409 PAYMENT_ATTEMPT_ACTIVE with the attempt', async () => {
    const first = await service.charge(22, 35, 4);
    methods.getChargeable.mockResolvedValue(card);
    const err = await service.charge(22, 35, 5).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toMatchObject({
      errorCode: PAYMENT_ATTEMPT_ACTIVE,
      message: expect.stringContaining('approval on your phone') as unknown,
      data: {
        reference: first.reference,
        kind: 'mobile_money',
        status: 'pending',
        paymentMethodId: 4,
      },
    });
    expect(paystack.chargeAuthorization).not.toHaveBeenCalled();
  });

  it('an open hosted checkout blocks a saved-method charge', async () => {
    charges.set(1, {
      id: 1,
      paymentId: 7,
      customerId: 22,
      reference: 'jinva-35-22-1',
      methodType: 'hosted',
      status: 'hosted_open',
      authorizationUrl: 'https://checkout.paystack.test/x',
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    } as PaymentCharge);
    nextId = 2;
    await expect(service.charge(22, 35, 4)).rejects.toMatchObject({
      response: expect.objectContaining({
        errorCode: PAYMENT_ATTEMPT_ACTIVE,
        data: expect.objectContaining({
          kind: 'hosted',
          authorizationUrl: 'https://checkout.paystack.test/x',
        }) as unknown,
      }) as unknown,
    });
    expect(paystack.chargeMobileMoney).not.toHaveBeenCalled();
  });

  it('charges a card authorization; an expired card is 422 before anything', async () => {
    methods.getChargeable.mockResolvedValue(card);
    paystack.chargeAuthorization.mockResolvedValue({
      outcome: 'ok',
      data: { status: 'success' },
    });
    const res = await service.charge(22, 35, 5);
    expect(res).toMatchObject({
      method: 'card',
      status: 'pending',
      action: 'wait',
    });
    expect(paystack.chargeAuthorization).toHaveBeenCalledWith(
      expect.objectContaining({ authorizationCode: 'AUTH_fict1' }),
    );
    methods.getChargeable.mockResolvedValue({ ...card, expired: true });
    await expect(service.charge(22, 35, 5)).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
  });

  it('a card needing further authorisation falls back to the hosted checkout', async () => {
    methods.getChargeable.mockResolvedValue(card);
    paystack.chargeAuthorization.mockResolvedValue({
      outcome: 'ok',
      data: { status: 'send_pin' },
    });
    await expect(service.charge(22, 35, 5)).resolves.toMatchObject({
      status: 'failed',
      action: 'pay_another_way',
    });
  });

  it('409 ALREADY_PAID (with the payment) when the job is paid, 404 when nothing is due', async () => {
    txPayments.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce({
      ...payment,
      status: PaymentStatus.RELEASED,
      paidReference: 'jinva-ch-7-x',
      paidAt: new Date('2026-11-01T10:00:00Z'),
    });
    const err = await service.charge(22, 35, 4).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toEqual({
      errorCode: ALREADY_PAID,
      message: 'This job is already paid.',
      data: {
        jobId: 35,
        status: PaymentStatus.RELEASED,
        amount: 350,
        currency: undefined,
        paidAt: '2026-11-01T10:00:00.000Z',
        reference: 'jinva-ch-7-x',
      },
    });
    txPayments.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    await expect(service.charge(22, 35, 4)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    // A cancelled payment is not "paid": nothing is due.
    txPayments.findOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ ...payment, status: PaymentStatus.CANCELLED });
    await expect(service.charge(22, 35, 4)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('a thrown Paystack call is treated as unreachable (still pending)', async () => {
    paystack.chargeMobileMoney.mockRejectedValue(new Error('boom'));
    await expect(service.charge(22, 35, 4)).resolves.toMatchObject({
      status: 'pending',
      action: 'approve_on_phone',
    });
  });

  it('keeps the webhook result when it landed before the charge reply', async () => {
    paystack.chargeMobileMoney.mockImplementation(() => {
      charges.get(1)!.status = 'succeeded';
      charges.get(1)!.action = null;
      charges.get(1)!.message = null;
      return Promise.resolve({
        outcome: 'ok',
        data: { status: 'pay_offline' },
      });
    });
    await expect(service.charge(22, 35, 4)).resolves.toMatchObject({
      status: 'succeeded',
    });
  });

  describe('Telecel OTP', () => {
    it('send_otp → needs_otp → submit → pending', async () => {
      paystack.chargeMobileMoney.mockResolvedValue({
        outcome: 'ok',
        data: { status: 'send_otp' },
      });
      const started = await service.charge(22, 35, 4);
      expect(started).toMatchObject({
        status: 'needs_otp',
        action: 'enter_otp',
      });
      paystack.submitChargeOtp.mockResolvedValue({
        outcome: 'ok',
        data: { status: 'pay_offline' },
      });
      const after = await service.submitOtp(22, started.reference, '123456');
      expect(after).toMatchObject({ status: 'pending' });
      expect(paystack.submitChargeOtp).toHaveBeenCalledWith(
        started.reference,
        '123456',
      );
    });

    it('409 ALREADY_PAID on the code step once the job is paid', async () => {
      paystack.chargeMobileMoney.mockResolvedValue({
        outcome: 'ok',
        data: { status: 'send_otp' },
      });
      const started = await service.charge(22, 35, 4);
      payments.findOne.mockResolvedValueOnce({
        ...payment,
        status: PaymentStatus.HELD,
      });
      await expect(
        service.submitOtp(22, started.reference, '123456'),
      ).rejects.toMatchObject({
        response: expect.objectContaining({
          errorCode: ALREADY_PAID,
        }) as unknown,
      });
      expect(paystack.submitChargeOtp).not.toHaveBeenCalled();
    });

    it('409 when the charge is not waiting for a code; 404 for someone else', async () => {
      const started = await service.charge(22, 35, 4);
      await expect(
        service.submitOtp(22, started.reference, '1234'),
      ).rejects.toBeInstanceOf(ConflictException);
      await expect(
        service.submitOtp(99, started.reference, '1234'),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.status(22, 'unknown-ref')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('a refused code fails the attempt with a clear message', async () => {
      paystack.chargeMobileMoney.mockResolvedValue({
        outcome: 'ok',
        data: { status: 'send_otp' },
      });
      const started = await service.charge(22, 35, 4);
      paystack.submitChargeOtp.mockRejectedValue(new Error('net'));
      await expect(
        service.submitOtp(22, started.reference, '1234'),
      ).resolves.toMatchObject({
        status: 'pending',
        action: 'wait',
      });
      charges.get(1)!.status = 'needs_otp';
      paystack.submitChargeOtp.mockResolvedValue({
        outcome: 'refused',
        httpStatus: 400,
        message: 'x',
      });
      await expect(
        service.submitOtp(22, started.reference, '1234'),
      ).resolves.toMatchObject({
        status: 'failed',
        message: CHARGE_MESSAGES.OTP_FAILED,
      });
    });
  });

  describe('status', () => {
    it('reads our row without calling Paystack inside the verify interval', async () => {
      const started = await service.charge(22, 35, 4);
      await expect(
        service.status(22, started.reference),
      ).resolves.toMatchObject({
        status: 'pending',
      });
      expect(paystack.verifyTransaction).not.toHaveBeenCalled();
    });

    it('after the interval, a Paystack success goes through the shared HELD path', async () => {
      const started = await service.charge(22, 35, 4);
      charges.get(1)!.createdAt = new Date(
        Date.now() - CHARGE_VERIFY_INTERVAL_MS - 1,
      );
      paystack.verifyTransaction.mockResolvedValue({
        status: 'success',
        amount: 35000,
        currency: 'GHS',
        channel: 'mobile_money',
        paid_at: '2026-11-01T10:00:00Z',
      });
      paymentsService.applyChargeSuccess.mockImplementation(() => {
        charges.get(1)!.status = 'succeeded';
        return Promise.resolve();
      });
      await expect(
        service.status(22, started.reference),
      ).resolves.toMatchObject({
        status: 'succeeded',
      });
      expect(paymentsService.applyChargeSuccess).toHaveBeenCalledWith(
        1,
        expect.objectContaining({
          reference: started.reference,
          amount: 35000,
        }),
      );
    });

    it('a Paystack failure marks the attempt failed; an old unconfirmed one is not approved', async () => {
      const started = await service.charge(22, 35, 4);
      charges.get(1)!.createdAt = new Date(
        Date.now() - CHARGE_VERIFY_INTERVAL_MS - 1,
      );
      paystack.verifyTransaction.mockResolvedValue({ status: 'failed' });
      await expect(
        service.status(22, started.reference),
      ).resolves.toMatchObject({
        status: 'failed',
      });

      // Past the window: unreachable keeps it waiting; "not found" releases it.
      charges.get(1)!.status = 'pending';
      charges.get(1)!.lastVerifiedAt = null;
      charges.get(1)!.createdAt = new Date(
        Date.now() - CHARGE_ACTIVE_WINDOW_MS - 1,
      );
      charges.get(1)!.expiresAt = null;
      paystack.verifyTransaction.mockRejectedValue(new Error('ETIMEDOUT'));
      await expect(
        service.status(22, started.reference),
      ).resolves.toMatchObject({ status: 'pending' });

      charges.get(1)!.lastVerifiedAt = null;
      paystack.verifyTransaction.mockRejectedValue(
        new PaystackRequestError('Transaction reference not found', 400),
      );
      await expect(
        service.status(22, started.reference),
      ).resolves.toMatchObject({
        status: 'failed',
        message: CHARGE_MESSAGES.NOT_APPROVED,
      });
      expect(charges.get(1)!.status).toBe('expired');
    });

    it('a pending charge Paystack still calls pending inside the window stays active', async () => {
      const started = await service.charge(22, 35, 4);
      charges.get(1)!.createdAt = new Date(
        Date.now() - CHARGE_VERIFY_INTERVAL_MS - 1,
      );
      paystack.verifyTransaction.mockResolvedValue({ status: 'pending' });
      await expect(
        service.status(22, started.reference),
      ).resolves.toMatchObject({ status: 'pending' });
    });

    it('reports cancelled, expired and hosted attempts in the charge shape', () => {
      const base = {
        reference: 'r',
        methodType: 'mobile_money',
        action: 'x',
        message: null,
      } as unknown as PaymentCharge;
      expect(
        SavedMethodChargeService.toResult(
          { ...base, status: 'cancelled', message: CHARGE_MESSAGES.CANCELLED },
          1,
        ),
      ).toMatchObject({ status: 'failed', message: CHARGE_MESSAGES.CANCELLED });
      expect(
        SavedMethodChargeService.toResult({ ...base, status: 'expired' }, 1),
      ).toMatchObject({
        status: 'failed',
        message: CHARGE_MESSAGES.NOT_APPROVED,
      });
      expect(
        SavedMethodChargeService.toResult(
          { ...base, methodType: 'hosted', status: 'hosted_open' },
          1,
        ),
      ).toMatchObject({ method: 'hosted', status: 'pending', action: null });
    });

    it('a duplicate attempt reads as succeeded with a review message', async () => {
      const started = await service.charge(22, 35, 4);
      charges.get(1)!.status = 'duplicate';
      await expect(service.status(22, started.reference)).resolves.toEqual(
        expect.objectContaining({
          status: 'succeeded',
          message: CHARGE_MESSAGES.DUPLICATE,
        }),
      );
    });
  });
});

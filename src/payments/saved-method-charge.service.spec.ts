import {
  ConflictException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { DataSource, Repository } from 'typeorm';
import type { User } from '@users/entities/user.entity';
import { Payment } from './entities/payment.entity';
import { PaymentCharge } from './entities/payment-charge.entity';
import type { PaystackService } from './paystack.service';
import type { PaymentsService } from './payments.service';
import type { PaymentMethodsService } from '../payment-methods/payment-methods.service';
import {
  CHARGE_ACTIVE_WINDOW_MS,
  CHARGE_VERIFY_INTERVAL_MS,
  SavedMethodChargeService,
} from './saved-method-charge.service';
import { CHARGE_MESSAGES } from './charge-outcome';

/** All values fictional. */
describe('SavedMethodChargeService', () => {
  const payment = { id: 7, jobId: 35, customerId: 22, amount: 350 } as Payment;
  let charges: Map<number, PaymentCharge>;
  let nextId: number;

  const chargeRepo = {
    findOne: jest.fn(),
    save: jest.fn(),
    create: jest.fn((v: Partial<PaymentCharge>) => v),
    update: jest.fn(),
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
  const paymentsService = { applySavedChargeSuccess: jest.fn() };
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
        for (const c of charges.values()) {
          const hit = Object.entries(where).every(([k, v]) => {
            const val = (c as unknown as Record<string, unknown>)[k];
            if (v && typeof v === 'object' && '_value' in v) {
              return (v as { _value: unknown[] })._value.includes(val);
            }
            return val === v;
          });
          if (hit) Object.assign(c, patch);
        }
        return Promise.resolve();
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
    service = new SavedMethodChargeService(
      payments as unknown as Repository<Payment>,
      chargeRepo as unknown as Repository<PaymentCharge>,
      users as unknown as Repository<User>,
      {
        transaction: (cb: (m: unknown) => unknown) => cb(manager),
      } as unknown as DataSource,
      paystack as unknown as PaystackService,
      methods as unknown as PaymentMethodsService,
      paymentsService as unknown as PaymentsService,
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

  it('starts a new attempt once the active one is older than the window', async () => {
    const first = await service.charge(22, 35, 4);
    charges.get(1)!.createdAt = new Date(
      Date.now() - CHARGE_ACTIVE_WINDOW_MS - 1,
    );
    const second = await service.charge(22, 35, 4);
    expect(second.reference).not.toBe(first.reference);
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

  it('409 when the job is already paid, 404 when nothing is due', async () => {
    txPayments.findOne
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 7 });
    await expect(service.charge(22, 35, 4)).rejects.toBeInstanceOf(
      ConflictException,
    );
    txPayments.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
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
      paymentsService.applySavedChargeSuccess.mockImplementation(() => {
        charges.get(1)!.status = 'succeeded';
        return Promise.resolve();
      });
      await expect(
        service.status(22, started.reference),
      ).resolves.toMatchObject({
        status: 'succeeded',
      });
      expect(paymentsService.applySavedChargeSuccess).toHaveBeenCalledWith(
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

      charges.get(1)!.status = 'pending';
      charges.get(1)!.lastVerifiedAt = null;
      charges.get(1)!.createdAt = new Date(
        Date.now() - CHARGE_ACTIVE_WINDOW_MS - 1,
      );
      paystack.verifyTransaction.mockRejectedValue(new Error('404'));
      await expect(
        service.status(22, started.reference),
      ).resolves.toMatchObject({
        status: 'failed',
        message: CHARGE_MESSAGES.NOT_APPROVED,
      });
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

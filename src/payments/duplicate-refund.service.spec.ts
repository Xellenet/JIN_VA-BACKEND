import { BadGatewayException } from '@nestjs/common';
import type { EventEmitter2 } from '@nestjs/event-emitter';
import type { DataSource, Repository } from 'typeorm';
import { APP_EVENTS } from '@common/events/app.events';
import { PaymentStatus } from '@common/types/enums';
import { Job } from '@jobs/entities/job.entity';
import { Payment } from './entities/payment.entity';
import type { PaymentCharge } from './entities/payment-charge.entity';
import type { PaystackService } from './paystack.service';
import type { PaymentAttemptsService } from './payment-attempts.service';
import {
  DuplicateRefundService,
  REFUND_BACKOFF_MS,
  REFUND_MAX_ATTEMPTS,
} from './duplicate-refund.service';
import { chargeStore, type ChargeStore } from '../../test/support/charge-store';

/** Automatic refund of a duplicate payment. All values fictional. */
describe('DuplicateRefundService', () => {
  const held = (over: Partial<Payment> = {}) =>
    ({
      id: 7,
      jobId: 35,
      customerId: 22,
      amount: 350,
      reference: 'jinva-35-22-1',
      status: PaymentStatus.HELD,
      paidReference: 'jinva-35-22-1',
      ...over,
    }) as Payment;

  let charges: ChargeStore;
  const payments = { findOne: jest.fn() };
  const jobs = { findOne: jest.fn() };
  const paystack = { refund: jest.fn() };
  const attempts = { methodLabels: jest.fn() };
  const events = { emit: jest.fn() };
  let service: DuplicateRefundService;

  const duplicate = (over: Partial<PaymentCharge> = {}) =>
    charges.add({
      id: 3,
      paymentId: 7,
      customerId: 22,
      reference: 'jinva-ch-7-2',
      methodType: 'mobile_money',
      status: 'duplicate',
      refundStatus: 'pending',
      refundAmount: '350.00',
      refundAttempts: 0,
      refundNextAt: new Date(Date.now() - 1),
      ...over,
    });

  beforeEach(() => {
    jest.clearAllMocks();
    charges = chargeStore();
    payments.findOne.mockResolvedValue(held());
    jobs.findOne.mockResolvedValue({ id: 35, title: 'Fix tap' });
    attempts.methodLabels.mockImplementation((cs: PaymentCharge[]) =>
      Promise.resolve(new Map(cs.map((c) => [c.id, 'MTN MoMo']))),
    );
    paystack.refund.mockResolvedValue({ id: '98765', status: 'pending' });
    const manager = {
      getRepository: (e: unknown) => (e === Payment ? payments : charges),
    };
    service = new DuplicateRefundService(
      charges as unknown as Repository<PaymentCharge>,
      payments as unknown as Repository<Payment>,
      {
        transaction: (cb: (m: unknown) => unknown) => cb(manager),
        getRepository: (e: unknown) => (e === Job ? jobs : charges),
      } as unknown as DataSource,
      paystack as unknown as PaystackService,
      attempts as unknown as PaymentAttemptsService,
      events as unknown as EventEmitter2,
    );
  });

  it('refunds the duplicate reference, records it and tells the customer once', async () => {
    duplicate();
    await expect(service.process(3)).resolves.toBe('requested');
    expect(paystack.refund).toHaveBeenCalledWith('jinva-ch-7-2');
    expect(charges.rows.get(3)).toMatchObject({
      refundStatus: 'requested',
      refundId: '98765',
      refundAttempts: 1,
      refundNextAt: null,
    });
    expect(events.emit).toHaveBeenCalledWith(
      APP_EVENTS.PAYMENT_DUPLICATE_REFUNDED,
      {
        customerId: 22,
        jobId: 35,
        jobTitle: 'Fix tap',
        amount: 350,
        methodLabel: 'MTN MoMo',
      },
    );

    // Idempotent: never refunded twice.
    await expect(service.process(3)).resolves.toBe('skipped');
    expect(paystack.refund).toHaveBeenCalledTimes(1);
    expect(events.emit).toHaveBeenCalledTimes(1);
  });

  it('records a refund Paystack already processed', async () => {
    duplicate();
    paystack.refund.mockResolvedValue({ id: '1', status: 'processed' });
    await service.process(3);
    expect(charges.rows.get(3)).toMatchObject({ refundStatus: 'processed' });
    expect(charges.rows.get(3)?.refundedAt).toBeInstanceOf(Date);
  });

  it('never refunds the reference that holds the job money', async () => {
    duplicate({ reference: 'jinva-35-22-1' });
    await expect(service.process(3)).resolves.toBe('skipped');
    expect(paystack.refund).not.toHaveBeenCalled();
    expect(charges.rows.get(3)?.refundStatus).toBe('failed');
  });

  it('holdsMoney falls back to the payment reference for older paid payments', () => {
    const legacy = held({ paidReference: null });
    expect(DuplicateRefundService.holdsMoney(legacy, 'jinva-35-22-1')).toBe(
      true,
    );
    expect(DuplicateRefundService.holdsMoney(legacy, 'jinva-ch-7-2')).toBe(
      false,
    );
    expect(
      DuplicateRefundService.holdsMoney(
        held({ paidReference: null, status: PaymentStatus.CANCELLED }),
        'jinva-35-22-1',
      ),
    ).toBe(false);
  });

  it('skips what is not due: not a duplicate, already requested, or waiting for its backoff', async () => {
    charges.add({ id: 1, status: 'succeeded', reference: 'a' });
    duplicate({ id: 2, reference: 'b', refundStatus: 'requested' });
    duplicate({
      id: 4,
      reference: 'c',
      refundNextAt: new Date(Date.now() + 60_000),
    });
    for (const id of [1, 2, 4, 99]) {
      await expect(service.process(id)).resolves.toBe('skipped');
    }
    expect(paystack.refund).not.toHaveBeenCalled();
  });

  it('skips a duplicate whose payment vanished', async () => {
    duplicate();
    payments.findOne.mockResolvedValue(null);
    await expect(service.process(3)).resolves.toBe('skipped');
  });

  describe('when the refund call fails', () => {
    it('schedules a retry with backoff and alerts admins on the first failure only', async () => {
      duplicate();
      paystack.refund.mockRejectedValue(new BadGatewayException('timeout'));
      const before = Date.now();
      await expect(service.process(3)).resolves.toBe('retry');
      const row = charges.rows.get(3)!;
      expect(row.refundStatus).toBe('pending');
      expect(row.refundAttempts).toBe(1);
      expect(new Date(row.refundNextAt!).getTime()).toBeGreaterThanOrEqual(
        before + REFUND_BACKOFF_MS[0],
      );
      expect(events.emit).toHaveBeenCalledWith(
        APP_EVENTS.PAYMENT_REFUND_NEEDS_ATTENTION,
        expect.objectContaining({
          paymentId: 7,
          reference: 'jinva-ch-7-2',
          amount: 350,
        }),
      );

      // The second failure: no new alert.
      events.emit.mockClear();
      row.refundNextAt = new Date(Date.now() - 1);
      await expect(service.process(3)).resolves.toBe('retry');
      expect(charges.rows.get(3)!.refundAttempts).toBe(2);
      expect(events.emit).not.toHaveBeenCalled();
    });

    it('gives up at the cap, leaves it to an admin and alerts', async () => {
      duplicate({ refundAttempts: REFUND_MAX_ATTEMPTS - 1 });
      paystack.refund.mockRejectedValue(new Error('nope'));
      await expect(service.process(3)).resolves.toBe('gave_up');
      expect(charges.rows.get(3)).toMatchObject({
        refundStatus: 'failed',
        refundNextAt: null,
      });
      expect(events.emit).toHaveBeenCalledWith(
        APP_EVENTS.PAYMENT_REFUND_NEEDS_ATTENTION,
        expect.objectContaining({
          reason: expect.stringContaining('refund it by hand') as unknown,
        }),
      );
      await expect(service.process(3)).resolves.toBe('skipped');
    });

    it('"already refunded" from Paystack counts as done (a call cut off after it went through)', async () => {
      duplicate({ refundStatus: 'processing', refundId: '555' });
      paystack.refund.mockRejectedValue(
        new BadGatewayException(
          "The payment provider couldn't complete this: Transaction has been fully reversed",
        ),
      );
      await expect(service.process(3)).resolves.toBe('requested');
      expect(charges.rows.get(3)).toMatchObject({
        refundStatus: 'requested',
        refundId: '555',
      });
    });

    it('a notification failure never undoes the refund', async () => {
      duplicate();
      jobs.findOne.mockRejectedValue(new Error('db'));
      await expect(service.process(3)).resolves.toBe('requested');
      expect(charges.rows.get(3)?.refundStatus).toBe('requested');
    });
  });

  it('retryDue runs every due refund and counts the ones Paystack took', async () => {
    duplicate({ id: 3, reference: 'r3' });
    duplicate({ id: 4, reference: 'r4' });
    duplicate({
      id: 5,
      reference: 'r5',
      refundNextAt: new Date(Date.now() + 60_000),
    });
    paystack.refund
      .mockResolvedValueOnce({ id: '1', status: 'pending' })
      .mockRejectedValueOnce(new Error('down'));
    await expect(service.retryDue()).resolves.toEqual({
      candidates: 2,
      requested: 1,
    });
  });

  it('retryDue keeps going when one refund throws', async () => {
    duplicate();
    jest.spyOn(service, 'process').mockRejectedValueOnce(new Error('db'));
    await expect(service.retryDue()).resolves.toEqual({
      candidates: 1,
      requested: 0,
    });
  });

  describe('refund webhooks', () => {
    it('refund.processed marks it processed, once', async () => {
      duplicate({ refundStatus: 'requested', refundId: '98765' });
      await service.onRefundWebhook('refund.processed', {
        transaction_reference: 'jinva-ch-7-2',
        id: 98765,
      });
      expect(charges.rows.get(3)).toMatchObject({ refundStatus: 'processed' });
      const at = charges.rows.get(3)!.refundedAt;
      await service.onRefundWebhook('refund.processed', {
        transaction_reference: 'jinva-ch-7-2',
      });
      expect(charges.rows.get(3)!.refundedAt).toBe(at);
    });

    it('refund.failed marks it failed and alerts admins once', async () => {
      duplicate({ refundStatus: 'requested' });
      await service.onRefundWebhook('refund.failed', {
        transaction: { reference: 'jinva-ch-7-2' },
      });
      expect(charges.rows.get(3)?.refundStatus).toBe('failed');
      expect(events.emit).toHaveBeenCalledTimes(1);
      await service.onRefundWebhook('refund.failed', {
        transaction: { reference: 'jinva-ch-7-2' },
      });
      expect(events.emit).toHaveBeenCalledTimes(1);
    });

    it('refund.pending for a refund still being called records it and tells the customer', async () => {
      duplicate({ refundStatus: 'processing' });
      await service.onRefundWebhook('refund.pending', {
        transaction_reference: 'jinva-ch-7-2',
        id: '42',
      });
      expect(charges.rows.get(3)).toMatchObject({
        refundStatus: 'requested',
        refundId: '42',
      });
      expect(events.emit).toHaveBeenCalledWith(
        APP_EVENTS.PAYMENT_DUPLICATE_REFUNDED,
        expect.anything(),
      );
    });

    it('finds the refund by its id when no reference is given', async () => {
      duplicate({ refundStatus: 'requested', refundId: '77' });
      await service.onRefundWebhook('refund.processing', { id: 77 });
      expect(charges.rows.get(3)?.refundStatus).toBe('requested');
      await service.onRefundWebhook('refund.processed', { id: 77 });
      expect(charges.rows.get(3)?.refundStatus).toBe('processed');
    });

    it('ignores admin refunds and empty payloads', async () => {
      await service.onRefundWebhook('refund.processed', {});
      await service.onRefundWebhook('refund.processed', {
        transaction_reference: 'jinva-35-22-1',
      });
      expect(charges.update).not.toHaveBeenCalled();
    });
  });
});

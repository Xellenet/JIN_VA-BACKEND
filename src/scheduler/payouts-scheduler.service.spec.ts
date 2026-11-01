import { Logger } from '@nestjs/common';
import { PayoutsSchedulerService } from './payouts-scheduler.service';
import type { PaymentsService } from '../payments/payments.service';
import type { DuplicateRefundService } from '../payments/duplicate-refund.service';

describe('PayoutsSchedulerService', () => {
  const payments = { retryDuePayoutChecks: jest.fn() };
  const refunds = { retryDue: jest.fn() };
  const scheduler = new PayoutsSchedulerService(
    payments as unknown as PaymentsService,
    refunds as unknown as DuplicateRefundService,
  );

  beforeEach(() => jest.clearAllMocks());
  afterEach(() => jest.restoreAllMocks());

  it('retries due payout checks and logs a run summary', async () => {
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    payments.retryDuePayoutChecks.mockResolvedValue({
      candidates: 3,
      sent: 2,
      failed: 1,
    });

    await scheduler.retryPendingPayoutChecks();

    expect(payments.retryDuePayoutChecks).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(
      'retryPendingPayoutChecks run summary: candidates=3 sent=2 failed=1',
    );
  });

  it('logs and swallows a failed run so the next one still happens', async () => {
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    payments.retryDuePayoutChecks.mockRejectedValue(new Error('db down'));

    await expect(scheduler.retryPendingPayoutChecks()).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith(
      'retryPendingPayoutChecks failed: db down',
    );
  });

  describe('duplicate refunds', () => {
    it('retries due refunds and logs a summary when there were any', async () => {
      const log = jest.spyOn(Logger.prototype, 'log').mockImplementation();
      refunds.retryDue.mockResolvedValue({ candidates: 2, requested: 1 });
      await scheduler.retryDuplicateRefunds();
      expect(log).toHaveBeenCalledWith(
        'retryDuplicateRefunds run summary: candidates=2 requested=1',
      );
    });

    it('stays quiet when nothing is due', async () => {
      const log = jest.spyOn(Logger.prototype, 'log').mockImplementation();
      refunds.retryDue.mockResolvedValue({ candidates: 0, requested: 0 });
      await scheduler.retryDuplicateRefunds();
      expect(log).not.toHaveBeenCalled();
    });

    it('logs and swallows a failed run', async () => {
      const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
      refunds.retryDue.mockRejectedValue(new Error('db down'));
      await expect(scheduler.retryDuplicateRefunds()).resolves.toBeUndefined();
      expect(error).toHaveBeenCalledWith(
        'retryDuplicateRefunds failed: db down',
      );
    });
  });
});

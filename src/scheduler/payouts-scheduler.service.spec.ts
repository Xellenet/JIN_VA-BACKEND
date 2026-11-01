import { Logger } from '@nestjs/common';
import { PayoutsSchedulerService } from './payouts-scheduler.service';
import type { PaymentsService } from '../payments/payments.service';

describe('PayoutsSchedulerService', () => {
  const payments = { retryDuePayoutChecks: jest.fn() };
  const scheduler = new PayoutsSchedulerService(
    payments as unknown as PaymentsService,
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
});

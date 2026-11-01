import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PaymentsService } from '../payments/payments.service';

/**
 * Payout name check: retries payouts whose name check couldn't be made
 * because Paystack was unavailable. Each payment carries its own backoff
 * (`payout_check_next_at`: 30 min, 1 h, 2 h, 4 h, 8 h, then 12 h) and a cap,
 * after which admins are told; this run only picks the ones that are due.
 * Holds the artisan must fix (name mismatch, account not found) are never
 * retried here; they are retried when the artisan saves new details.
 */
@Injectable()
export class PayoutsSchedulerService {
  private readonly logger = new Logger(PayoutsSchedulerService.name);

  constructor(private readonly paymentsService: PaymentsService) {}

  @Cron(CronExpression.EVERY_30_MINUTES)
  async retryPendingPayoutChecks(): Promise<void> {
    try {
      const { candidates, sent, failed } =
        await this.paymentsService.retryDuePayoutChecks();
      this.logger.log(
        `retryPendingPayoutChecks run summary: candidates=${candidates} sent=${sent} failed=${failed}`,
      );
    } catch (err) {
      this.logger.error(
        `retryPendingPayoutChecks failed: ${(err as Error).message}`,
      );
    }
  }
}

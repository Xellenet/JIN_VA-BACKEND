import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { BookingsService } from '../bookings/bookings.service';

@Injectable()
export class BookingsSchedulerService {
  private readonly logger = new Logger(BookingsSchedulerService.name);

  constructor(private readonly bookingsService: BookingsService) {}

  /**
   * A5: runs every hour — expires PENDING bookings whose 24h response
   * window has elapsed ("at least 24h", not "exactly", so a delayed/paused
   * cron still catches everything overdue on its next run).
   *
   * NFR (b): each candidate commits independently via
   * {@link BookingsService.expireBooking}'s conditional `UPDATE ... WHERE
   * status = 'PENDING'`, which is what makes re-running this idempotent — a
   * booking already expired (or confirmed/declined) by a prior run or a
   * concurrent artisan action simply doesn't match on the second pass.
   */
  @Cron(CronExpression.EVERY_HOUR)
  async expirePendingBookings(): Promise<void> {
    const candidateIds = await this.bookingsService.findExpiryCandidateIds();

    if (candidateIds.length === 0) {
      this.logger.log(
        'expirePendingBookings run summary: candidates=0 processed=0 failed=0',
      );
      return;
    }

    let processed = 0;
    let failed = 0;
    for (const id of candidateIds) {
      try {
        const claimed = await this.bookingsService.expireBooking(id);
        if (claimed) processed++;
      } catch (err) {
        failed++;
        this.logger.error(
          `Failed to expire booking ${id}: ${(err as Error).message}`,
        );
      }
    }

    this.logger.log(
      `expirePendingBookings run summary: candidates=${candidateIds.length} processed=${processed} failed=${failed}`,
    );
  }

  /**
   * A7: runs every 30 minutes — sends 24h and 2h pre-appointment reminders
   * to both parties of a CONFIRMED booking. Idempotency is enforced by the
   * `reminder24hSentAt`/`reminder2hSentAt` flags checked inside
   * {@link BookingsService.findReminderCandidates}: a booking already
   * reminded for a given milestone (by this run or a prior/overlapping one)
   * simply isn't selected again.
   */
  @Cron(CronExpression.EVERY_30_MINUTES)
  async sendAppointmentReminders(): Promise<void> {
    await this.runMilestone('24H');
    await this.runMilestone('2H');
  }

  private async runMilestone(milestone: '24H' | '2H'): Promise<void> {
    const candidates =
      await this.bookingsService.findReminderCandidates(milestone);

    if (candidates.length === 0) {
      this.logger.log(
        `sendAppointmentReminders(${milestone}) run summary: candidates=0 processed=0 failed=0`,
      );
      return;
    }

    let processed = 0;
    let failed = 0;
    for (const booking of candidates) {
      try {
        await this.bookingsService.sendReminder(booking, milestone);
        processed++;
      } catch (err) {
        failed++;
        this.logger.error(
          `Failed to send ${milestone} reminder for booking ${booking.id}: ${(err as Error).message}`,
        );
      }
    }

    this.logger.log(
      `sendAppointmentReminders(${milestone}) run summary: candidates=${candidates.length} processed=${processed} failed=${failed}`,
    );
  }
}

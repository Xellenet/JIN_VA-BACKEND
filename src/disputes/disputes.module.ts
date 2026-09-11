import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Dispute } from './entities/dispute.entity';
import { Booking } from '../bookings/entities/booking.entity';
import { Job } from '@jobs/entities/job.entity';
import { JobStatusHistory } from '@jobs/entities/job-status-history.entity';
import { Payment } from '../payments/entities/payment.entity';
import { DisputesService } from './disputes.service';
import { DisputesController } from './disputes.controller';
import { DisputeWriteThrottlerGuard } from './guards/dispute-write-throttler.guard';
import { MessagesModule } from '@messages/messages.module';
import { PaymentsModule } from '../payments/payments.module';
import { AdminAuditModule } from '../admin-audit/admin-audit.module';
import { ThrottlingModule } from '@common/throttling/throttling.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Dispute,
      Booking,
      Job,
      // DQ3: derives the job's completion date from its status history, since
      // `Job` has no `completedAt` column.
      JobStatusHistory,
      Payment,
    ]),
    // AD1: supplies `MessagesService.getConversationBetween` for the
    // dispute-scoped, read-only conversation lookup.
    MessagesModule,
    // DR2: the money side of a verdict — the existing admin refund and
    // release-of-withheld-payment capabilities, neither re-implemented here.
    PaymentsModule,
    // AT5: one audit row per ruling, carrying the verdict and money action.
    AdminAuditModule,
    /**
     * B5: supplies the `dispute-write` named throttler behind
     * `DisputeWriteThrottlerGuard`. The guard is also attached to
     * `PATCH /admin/disputes/:id/resolve`, so it is exported for
     * `AdminModule` rather than duplicated there — one class, one
     * configuration, two routes with separate counters.
     */
    ThrottlingModule,
  ],
  controllers: [DisputesController],
  providers: [DisputesService, DisputeWriteThrottlerGuard],
  exports: [DisputesService, DisputeWriteThrottlerGuard],
})
export class DisputesModule {}

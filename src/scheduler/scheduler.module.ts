import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Job } from '@jobs/entities/job.entity';
import { JobsModule } from '@jobs/jobs.module';
import { UsersModule } from '@users/users.module';
import { BookingsModule } from '../bookings/bookings.module';
import { JobsSchedulerService } from './jobs-scheduler.service';
import { BookingsSchedulerService } from './bookings-scheduler.service';
import { AccountPurgeSchedulerService } from './account-purge-scheduler.service';
import { PaymentsModule } from '../payments/payments.module';
import { PayoutsSchedulerService } from './payouts-scheduler.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Job]),
    JobsModule,
    BookingsModule,
    // C1.7: for `AccountPurgeService`, which owns the purge itself — this
    // module only schedules it and logs the per-run summary.
    UsersModule,
    // Payout name check: retries checks that couldn't be made.
    PaymentsModule,
  ],
  providers: [
    JobsSchedulerService,
    BookingsSchedulerService,
    AccountPurgeSchedulerService,
    PayoutsSchedulerService,
  ],
})
export class SchedulerModule {}

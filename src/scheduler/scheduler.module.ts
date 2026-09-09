import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Job } from '@jobs/entities/job.entity';
import { JobsModule } from '@jobs/jobs.module';
import { UsersModule } from '@users/users.module';
import { BookingsModule } from '../bookings/bookings.module';
import { JobsSchedulerService } from './jobs-scheduler.service';
import { BookingsSchedulerService } from './bookings-scheduler.service';
import { AccountPurgeSchedulerService } from './account-purge-scheduler.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Job]),
    JobsModule,
    BookingsModule,
    // C1.7: for `AccountPurgeService`, which owns the purge itself — this
    // module only schedules it and logs the per-run summary.
    UsersModule,
  ],
  providers: [
    JobsSchedulerService,
    BookingsSchedulerService,
    AccountPurgeSchedulerService,
  ],
})
export class SchedulerModule {}

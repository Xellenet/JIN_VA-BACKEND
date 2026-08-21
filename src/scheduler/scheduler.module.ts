import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Job } from '@jobs/entities/job.entity';
import { JobsModule } from '@jobs/jobs.module';
import { BookingsModule } from '../bookings/bookings.module';
import { JobsSchedulerService } from './jobs-scheduler.service';
import { BookingsSchedulerService } from './bookings-scheduler.service';

@Module({
  imports: [TypeOrmModule.forFeature([Job]), JobsModule, BookingsModule],
  providers: [JobsSchedulerService, BookingsSchedulerService],
})
export class SchedulerModule {}

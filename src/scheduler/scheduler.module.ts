import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Job } from '@jobs/entities/job.entity';
import { JobsModule } from '@jobs/jobs.module';
import { JobsSchedulerService } from './jobs-scheduler.service';

@Module({
  imports: [TypeOrmModule.forFeature([Job]), JobsModule],
  providers: [JobsSchedulerService],
})
export class SchedulerModule {}

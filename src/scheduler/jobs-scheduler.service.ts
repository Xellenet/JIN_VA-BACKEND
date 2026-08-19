import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Repository } from 'typeorm';
import { Job } from '@jobs/entities/job.entity';
import { JobsService } from '@jobs/jobs.service';
import { Status } from '@common/types/enums';

@Injectable()
export class JobsSchedulerService {
  private readonly logger = new Logger(JobsSchedulerService.name);

  constructor(
    @InjectRepository(Job)
    private readonly jobsRepository: Repository<Job>,
    private readonly jobsService: JobsService,
  ) {}

  // Runs every day at 02:00 UTC — finds OPEN jobs past their deadline and expires them.
  @Cron(CronExpression.EVERY_DAY_AT_2AM)
  async expireStaleJobs(): Promise<void> {
    const now = new Date();

    const staleJobs = await this.jobsRepository.find({
      where: {
        status:   Status.OPEN,
        deadline: LessThan(now),
      },
      select: ['id'],
    });

    if (staleJobs.length === 0) return;

    this.logger.log(`Expiring ${staleJobs.length} stale job(s)`);

    for (const { id } of staleJobs) {
      try {
        await this.jobsService.expireJob(id);
      } catch (err) {
        this.logger.error(`Failed to expire job ${id}: ${(err as Error).message}`);
      }
    }
  }
}

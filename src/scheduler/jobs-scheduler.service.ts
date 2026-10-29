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
        status: Status.OPEN,
        deadline: LessThan(now),
      },
      select: ['id'],
    });

    if (staleJobs.length === 0) {
      this.logger.log(
        'expireStaleJobs run summary: candidates=0 processed=0 failed=0',
      );
      return;
    }

    this.logger.log(`Expiring ${staleJobs.length} stale job(s)`);

    let processed = 0;
    let failed = 0;
    for (const { id } of staleJobs) {
      try {
        await this.jobsService.expireJob(id);
        processed++;
      } catch (err) {
        failed++;
        this.logger.error(
          `Failed to expire job ${id}: ${(err as Error).message}`,
        );
      }
    }

    this.logger.log(
      `expireStaleJobs run summary: candidates=${staleJobs.length} processed=${processed} failed=${failed}`,
    );
  }

  /**
   * J2: runs daily — auto-completes IN_PROGRESS jobs where the artisan
   * requested completion at least 48h ago and the customer never confirmed.
   *
   * NFR (b): each candidate is processed (and committed) independently via
   * {@link JobsService.autoCompleteJob}'s own row-locked transaction, so a
   * crash mid-batch never leaves a partially-applied batch — already
   * -completed jobs are simply skipped (idempotent), and any not yet
   * processed are caught by the next run. A per-run summary (candidates
   * found / processed / failed) is always logged, even when zero jobs
   * qualify, per the audit's dormant-cron finding.
   */
  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async autoCompleteOverdueJobs(): Promise<void> {
    const candidateIds = await this.jobsService.findAutoCompleteCandidateIds();

    if (candidateIds.length === 0) {
      this.logger.log(
        'autoCompleteOverdueJobs run summary: candidates=0 processed=0 failed=0',
      );
      return;
    }

    let processed = 0;
    let failed = 0;
    for (const id of candidateIds) {
      try {
        const completed = await this.jobsService.autoCompleteJob(id);
        if (completed) processed++;
      } catch (err) {
        failed++;
        this.logger.error(
          `Failed to auto-complete job ${id}: ${(err as Error).message}`,
        );
      }
    }

    this.logger.log(
      `autoCompleteOverdueJobs run summary: candidates=${candidateIds.length} processed=${processed} failed=${failed}`,
    );
  }
}

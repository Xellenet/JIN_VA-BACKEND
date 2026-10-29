import { LessThan } from 'typeorm';
import { Status } from '@common/types/enums';
import type { JobsService } from '@jobs/jobs.service';
import { JobsSchedulerService } from './jobs-scheduler.service';

describe('JobsSchedulerService', () => {
  let scheduler: JobsSchedulerService;
  let logSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  const jobsRepo = { find: jest.fn() };
  const jobsService = {
    expireJob: jest.fn(),
    findAutoCompleteCandidateIds: jest.fn(),
    autoCompleteJob: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    scheduler = new JobsSchedulerService(
      jobsRepo as never,
      jobsService as unknown as JobsService,
    );
    logSpy = jest.spyOn(scheduler['logger'], 'log').mockImplementation();
    errorSpy = jest.spyOn(scheduler['logger'], 'error').mockImplementation();
  });

  const summaries = (): string[] =>
    logSpy.mock.calls
      .map(([msg]) => String(msg))
      .filter((msg) => msg.includes('run summary'));

  describe('expireStaleJobs', () => {
    it('selects only OPEN jobs whose deadline has passed', async () => {
      jobsRepo.find.mockResolvedValueOnce([]);

      await scheduler.expireStaleJobs();

      const [{ where, select }] = jobsRepo.find.mock.calls[0] as [
        { where: { status: Status; deadline: unknown }; select: string[] },
      ];
      expect(where.status).toBe(Status.OPEN);
      expect(where.deadline).toEqual(LessThan(expect.any(Date)));
      expect(select).toEqual(['id']);
    });

    it('logs a summary and expires nothing when no job is stale', async () => {
      jobsRepo.find.mockResolvedValueOnce([]);

      await scheduler.expireStaleJobs();

      expect(jobsService.expireJob).not.toHaveBeenCalled();
      expect(summaries()).toEqual([
        'expireStaleJobs run summary: candidates=0 processed=0 failed=0',
      ]);
    });

    it('keeps expiring the rest after one job fails', async () => {
      jobsRepo.find.mockResolvedValueOnce([{ id: 1 }, { id: 2 }, { id: 3 }]);
      jobsService.expireJob
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('lock timeout'))
        .mockResolvedValueOnce(undefined);

      await expect(scheduler.expireStaleJobs()).resolves.toBeUndefined();

      expect(jobsService.expireJob.mock.calls).toEqual([[1], [2], [3]]);
      expect(errorSpy).toHaveBeenCalledWith(
        'Failed to expire job 2: lock timeout',
      );
      expect(summaries()).toEqual([
        'expireStaleJobs run summary: candidates=3 processed=2 failed=1',
      ]);
    });
  });

  describe('autoCompleteOverdueJobs', () => {
    it('logs a summary even when there are no candidates', async () => {
      jobsService.findAutoCompleteCandidateIds.mockResolvedValueOnce([]);

      await scheduler.autoCompleteOverdueJobs();

      expect(jobsService.autoCompleteJob).not.toHaveBeenCalled();
      expect(summaries()).toEqual([
        'autoCompleteOverdueJobs run summary: candidates=0 processed=0 failed=0',
      ]);
    });

    // A job the customer confirmed between the candidate query and the row
    // lock comes back `false`: neither processed nor a failure.
    it('counts only jobs actually completed, and survives a failure', async () => {
      jobsService.findAutoCompleteCandidateIds.mockResolvedValueOnce([
        10, 11, 12,
      ]);
      jobsService.autoCompleteJob
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false)
        .mockRejectedValueOnce(new Error('deadlock'));

      await expect(
        scheduler.autoCompleteOverdueJobs(),
      ).resolves.toBeUndefined();

      expect(jobsService.autoCompleteJob).toHaveBeenCalledTimes(3);
      expect(errorSpy).toHaveBeenCalledWith(
        'Failed to auto-complete job 12: deadlock',
      );
      expect(summaries()).toEqual([
        'autoCompleteOverdueJobs run summary: candidates=3 processed=1 failed=1',
      ]);
    });
  });
});

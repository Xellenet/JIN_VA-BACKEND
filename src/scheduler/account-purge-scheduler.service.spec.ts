import { Test, TestingModule } from '@nestjs/testing';
import { AccountPurgeSchedulerService } from './account-purge-scheduler.service';
import { AccountPurgeService } from '@users/account-purge.service';
import { VARIABLES } from '@common/constants/variables.constants';

/**
 * C1.7: the cron's own contract — a per-run summary logged even when nothing
 * qualifies (so the job can never look dormant), each candidate processed
 * independently so one failure never blocks the batch, and the mode in force
 * stated on every summary so a log line is never ambiguous about whether
 * anything was actually written.
 */
describe('AccountPurgeSchedulerService (C1.7)', () => {
  let scheduler: AccountPurgeSchedulerService;
  let logSpy: jest.SpyInstance;

  const mockPurgeService = {
    isDestructiveModeEnabled: jest.fn(),
    findPurgeCandidateIds: jest.fn(),
    purgeAccount: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AccountPurgeSchedulerService,
        { provide: AccountPurgeService, useValue: mockPurgeService },
      ],
    }).compile();

    scheduler = module.get(AccountPurgeSchedulerService);
    jest.clearAllMocks();
    mockPurgeService.isDestructiveModeEnabled.mockReturnValue(false);
    logSpy = jest.spyOn(scheduler['logger'], 'log').mockImplementation();
    jest.spyOn(scheduler['logger'], 'warn').mockImplementation();
    jest.spyOn(scheduler['logger'], 'error').mockImplementation();
  });

  const summaries = (): string[] =>
    logSpy.mock.calls
      .map(([msg]) => String(msg))
      .filter((msg) => msg.includes('run summary'));

  it('logs a summary even when there are zero candidates', async () => {
    mockPurgeService.findPurgeCandidateIds.mockResolvedValueOnce([]);

    await scheduler.purgeExpiredDeletedAccounts();

    expect(summaries()).toEqual([
      'purgeExpiredDeletedAccounts run summary: mode=log-only candidates=0 processed=0 failed=0 skipped=0',
    ]);
    expect(mockPurgeService.purgeAccount).not.toHaveBeenCalled();
  });

  it('states log-only mode on the summary when destructive mode is off', async () => {
    mockPurgeService.findPurgeCandidateIds.mockResolvedValueOnce([1]);
    mockPurgeService.purgeAccount.mockResolvedValueOnce('reported');

    await scheduler.purgeExpiredDeletedAccounts();

    expect(summaries()[0]).toContain('mode=log-only');
    expect(summaries()[0]).toContain('candidates=1 processed=1 failed=0');
  });

  it('states destructive mode on the summary when it is armed', async () => {
    mockPurgeService.isDestructiveModeEnabled.mockReturnValue(true);
    mockPurgeService.findPurgeCandidateIds.mockResolvedValueOnce([1]);
    mockPurgeService.purgeAccount.mockResolvedValueOnce('purged');

    await scheduler.purgeExpiredDeletedAccounts();

    expect(summaries()[0]).toContain(
      `mode=${VARIABLES.ACCOUNT_PURGE_MODE_DESTRUCTIVE}`,
    );
  });

  // One failure must not stop the batch: the remaining candidates still get
  // their turn, and the failure is counted rather than thrown.
  it('processes each candidate independently and keeps going after a failure', async () => {
    mockPurgeService.findPurgeCandidateIds.mockResolvedValueOnce([1, 2, 3]);
    mockPurgeService.purgeAccount
      .mockResolvedValueOnce('reported')
      .mockRejectedValueOnce(new Error('deadlock'))
      .mockResolvedValueOnce('reported');

    await expect(
      scheduler.purgeExpiredDeletedAccounts(),
    ).resolves.toBeUndefined();

    expect(mockPurgeService.purgeAccount).toHaveBeenCalledTimes(3);
    expect(summaries()[0]).toContain(
      'candidates=3 processed=2 failed=1 skipped=0',
    );
  });

  // A candidate that was restored (or already purged) between the candidate
  // query and the row lock is reported separately from a real failure — it is
  // the expected outcome of the race, not an error.
  it('counts a skipped candidate as skipped, not failed', async () => {
    mockPurgeService.findPurgeCandidateIds.mockResolvedValueOnce([1, 2]);
    mockPurgeService.purgeAccount
      .mockResolvedValueOnce('skipped')
      .mockResolvedValueOnce('reported');

    await scheduler.purgeExpiredDeletedAccounts();

    expect(summaries()[0]).toContain(
      'candidates=2 processed=1 failed=0 skipped=1',
    );
  });
});

import { JobsService } from './jobs.service';
import { Status } from '@common/types/enums';

/**
 * J2/NFR (b): unit-level proof that `autoCompleteJob` is idempotent —
 * running it twice for the same job ID only completes it (and captures
 * payment / writes history) once. The daily cron's crash-tolerance depends
 * on this: a job already COMPLETED by a prior run is naturally excluded by
 * the `job.status !== Status.IN_PROGRESS` guard evaluated inside the
 * row-locked transaction, so a repeated or overlapping run is a safe no-op.
 */
interface FakeJob {
  id: number;
  status: Status;
  completionRequestedAt?: Date;
  paymentIntentId?: string;
  acceptedArtisanId: number;
  customer: { id: number };
  service: { id: number };
  title?: string;
}

describe('JobsService — J2 auto-complete idempotency', () => {
  function buildService(initialStatus: Status) {
    let status = initialStatus;
    const completionRequestedAt = new Date(Date.now() - 49 * 60 * 60 * 1000);

    const jobRepoInManager = {
      findOne: jest.fn(() =>
        Promise.resolve<FakeJob>({
          id: 1,
          status,
          completionRequestedAt,
          paymentIntentId: undefined,
          acceptedArtisanId: 7,
          customer: { id: 1 },
          service: { id: 1 },
        }),
      ),
      save: jest.fn((job: FakeJob) => {
        status = job.status;
        return Promise.resolve(job);
      }),
    };
    const historyRepoInManager = {
      create: jest.fn((x: unknown) => x),
      save: jest.fn((x: unknown) => Promise.resolve(x)),
    };
    const manager = {
      getRepository: jest.fn((entity: { name?: string }) => {
        if (entity?.name === 'JobStatusHistory') return historyRepoInManager;
        return jobRepoInManager;
      }),
    };
    const dataSource = {
      transaction: jest.fn((work: (m: typeof manager) => Promise<unknown>) =>
        work(manager),
      ),
    };
    const jobsRepository = {
      findOne: jest.fn(() =>
        Promise.resolve<FakeJob>({
          id: 1,
          status,
          acceptedArtisanId: 7,
          customer: { id: 1 },
          service: { id: 1 },
          title: 'Test job',
        }),
      ),
    };
    const paymentsService = { capturePayment: jest.fn() };
    const eventEmitter = { emit: jest.fn() };

    const service = new JobsService(
      jobsRepository as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      dataSource as any,
      paymentsService as any,
      eventEmitter as any,
    );
    return { service, eventEmitter, jobRepoInManager };
  }

  it('completes the job on the first run and no-ops on the second', async () => {
    const { service, eventEmitter, jobRepoInManager } = buildService(
      Status.IN_PROGRESS,
    );

    const firstRun = await service.autoCompleteJob(1);
    const secondRun = await service.autoCompleteJob(1);

    expect(firstRun).toBe(true);
    expect(secondRun).toBe(false);
    expect(jobRepoInManager.save).toHaveBeenCalledTimes(1);
    expect(eventEmitter.emit).toHaveBeenCalledTimes(1);
  });
});

import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { getDataSourceToken } from '@nestjs/typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { JobsService } from './jobs.service';
import { Job } from './entities/job.entity';
import { JobApplication } from './entities/job-application.entity';
import { JobStatusHistory } from './entities/job-status-history.entity';
import { JobAttachment } from './entities/job-attachment.entity';
import { ServiceEntity } from '@services/entities/service.entity';
import { User } from '@users/entities/user.entity';
import { PaymentsService } from '../payments/payments.service';
import { Status } from '@common/types/enums';
import { qbMock } from '../customer-insights/testing/qb-mock';

describe('JobsService', () => {
  let service: JobsService;
  let jobsRepo: { createQueryBuilder: jest.Mock };

  const mockRepo = () => ({
    create: jest.fn(),
    save: jest.fn(),
    find: jest.fn(),
    findOne: jest.fn(),
    count: jest.fn(),
    createQueryBuilder: jest.fn(),
  });
  const mockPaymentsService = {
    capturePayment: jest.fn(),
    holdPayment: jest.fn(),
  };
  const mockEventEmitter = { emit: jest.fn() };
  const mockDataSource = { transaction: jest.fn() };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        JobsService,
        { provide: getRepositoryToken(Job), useValue: mockRepo() },
        { provide: getRepositoryToken(JobApplication), useValue: mockRepo() },
        {
          provide: getRepositoryToken(JobStatusHistory),
          useValue: mockRepo(),
        },
        { provide: getRepositoryToken(JobAttachment), useValue: mockRepo() },
        { provide: getRepositoryToken(ServiceEntity), useValue: mockRepo() },
        { provide: getRepositoryToken(User), useValue: mockRepo() },
        { provide: getDataSourceToken(), useValue: mockDataSource },
        { provide: PaymentsService, useValue: mockPaymentsService },
        { provide: EventEmitter2, useValue: mockEventEmitter },
      ],
    }).compile();

    service = module.get<JobsService>(JobsService);
    jobsRepo = module.get(getRepositoryToken(Job));
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('getMySummary (B7a)', () => {
    it('BU-1.1 turns Postgres string counts into numbers, fills missing statuses and sums stages', async () => {
      jobsRepo.createQueryBuilder.mockReturnValue(
        qbMock({
          getRawMany: [
            { status: 'OPEN', count: '3' },
            { status: 'PENDING', count: '1' },
            { status: 'IN_PROGRESS', count: '2' },
            { status: 'COMPLETED', count: '27' },
            { status: 'CANCELLED', count: '4' },
            { status: 'EXPIRED', count: '1' },
          ],
        }),
      );
      const res = await service.getMySummary(1042);
      expect(res.message).toBe('Job summary retrieved');
      expect(res.data).toEqual({
        byStatus: {
          OPEN: 3,
          PENDING: 1,
          IN_PROGRESS: 2,
          COMPLETED: 27,
          CANCELLED: 4,
          EXPIRED: 1,
        },
        byStage: { open: 3, in_progress: 3, completed: 27, closed: 5 },
        total: 38,
      });
    });

    it('BU-1.2 gives zeros everywhere when the customer has no jobs', async () => {
      jobsRepo.createQueryBuilder.mockReturnValue(qbMock({ getRawMany: [] }));
      const { data } = await service.getMySummary(7);
      expect(Object.values(data.byStatus)).toEqual([0, 0, 0, 0, 0, 0]);
      expect(data.byStage).toEqual({
        open: 0,
        in_progress: 0,
        completed: 0,
        closed: 0,
      });
      expect(data.total).toBe(0);
    });

    it('BU-1.3 binds the owner as a parameter and groups once by status', async () => {
      const qb = qbMock({ getRawMany: [{ status: 'OPEN', count: 1 }] });
      jobsRepo.createQueryBuilder.mockReturnValue(qb);
      await service.getMySummary(1042);
      expect(qb.where).toHaveBeenCalledWith('job.customer_id = :me', {
        me: 1042,
      });
      expect(qb.sql()).not.toContain('1042');
      expect(qb.groupBy).toHaveBeenCalledTimes(1);
      expect(qb.groupBy).toHaveBeenCalledWith('job.status');
      expect(qb.sql()).toContain('deletedAt IS NULL');
    });
  });

  describe('findMine (B7b)', () => {
    const run = async (status?: Status[]) => {
      const qb = qbMock({ getCount: 3, getMany: [] });
      jobsRepo.createQueryBuilder.mockReturnValue(qb);
      const res = await service.findMine(5, { status, page: 1, limit: 10 });
      return { qb, res };
    };

    it('BU-1.7 uses IN (:...statuses) for several statuses and adds the id tie-break', async () => {
      const { qb, res } = await run([Status.PENDING, Status.IN_PROGRESS]);
      expect(qb.andWhere).toHaveBeenCalledWith('job.status IN (:...statuses)', {
        statuses: [Status.PENDING, Status.IN_PROGRESS],
      });
      expect(qb.addOrderBy).toHaveBeenCalledWith('job.id', 'DESC');
      expect(res.pagination).toEqual({
        total: 3,
        page: 1,
        limit: 10,
        totalPages: 1,
      });
    });

    it('BU-1.6 keeps the single-status `=` and adds nothing for no status', async () => {
      const one = await run([Status.OPEN]);
      expect(one.qb.andWhere).toHaveBeenCalledWith('job.status = :status', {
        status: Status.OPEN,
      });
      const none = await run(undefined);
      expect(none.qb.sql()).not.toContain('job.status');
    });
  });
});

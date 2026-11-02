import { Test, TestingModule } from '@nestjs/testing';
import { JobsController } from './jobs.controller';
import { JobsService } from './jobs.service';
import { CustomerAnalyticsThrottlerGuard } from '@common/throttling/customer-throttler.guards';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Role, Status } from '@common/types/enums';
import { ROLES_KEY } from '@common/decorators/roles.decorator';
import type { AuthenticatedRequest } from '@common/types/authenticated-request.type';

describe('JobsController', () => {
  let controller: JobsController;

  const mockJobsService = {
    create: jest.fn(),
    findAll: jest.fn(),
    findOne: jest.fn(),
    findMine: jest.fn().mockResolvedValue({ message: 'ok' }),
    getMySummary: jest.fn().mockResolvedValue({ message: 'ok' }),
  };
  const req = { user: { id: 1042 } } as unknown as AuthenticatedRequest;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [JobsController],
      providers: [{ provide: JobsService, useValue: mockJobsService }],
    })
      .overrideGuard(CustomerAnalyticsThrottlerGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<JobsController>(JobsController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('findMine passes the caller id and the multi-status query (B7b)', async () => {
    const query = { status: [Status.PENDING, Status.IN_PROGRESS], page: 1 };
    await controller.findMine(req, query);
    expect(mockJobsService.findMine).toHaveBeenCalledWith(1042, query);
  });

  it('getMySummary uses only the JWT subject (B7a)', async () => {
    await controller.getMySummary(req, {});
    expect(mockJobsService.getMySummary).toHaveBeenCalledWith(1042);
  });

  it('getMySummary has the roles guard, the customer role and its throttle (S-2, T-6)', () => {
    const handler = JobsController.prototype.getMySummary;
    const guards = Reflect.getMetadata('__guards__', handler) as unknown[];
    expect(guards).toEqual([RolesGuard, CustomerAnalyticsThrottlerGuard]);
    expect(Reflect.getMetadata(ROLES_KEY, handler)).toEqual([Role.CUSTOMER]);
  });
});

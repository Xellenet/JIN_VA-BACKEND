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

describe('JobsService', () => {
  let service: JobsService;

  const mockRepo = () => ({
    create: jest.fn(),
    save: jest.fn(),
    find: jest.fn(),
    findOne: jest.fn(),
    count: jest.fn(),
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
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});

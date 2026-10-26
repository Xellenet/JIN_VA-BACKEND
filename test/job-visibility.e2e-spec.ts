/**
 * QA SEC-02: GET /jobs/:id and GET /jobs returned any customer's jobs to any
 * logged-in user. Over real HTTP: who may read a job, and what the list shows
 * each role. Everything this suite creates is removed afterwards.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { WINSTON_MODULE_NEST_PROVIDER } from 'nest-winston';
import { DataSource, Repository } from 'typeorm';
import request from 'supertest';
import { App } from 'supertest/types';
import cookieParser from 'cookie-parser';
import type { Logger as WinstonLogger } from 'winston';
import { AppModule } from '../src/app.module';
import { ResponseInterceptor } from '../src/common/interceptors/response.interceptor';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { TypeOrmFilter } from '../src/common/filters/typeorm-exception.filter';
import { User } from '@users/entities/user.entity';
import { UserTokenService } from '@users/token.service';
import { ServiceEntity } from '@services/entities/service.entity';
import { Job } from '@jobs/entities/job.entity';
import { JobApplication } from '@jobs/entities/job-application.entity';
import { ApplicationStatus, Role, Status } from '@common/types/enums';
import { removeTestData, testUserIds } from './helpers/test-data';

jest.setTimeout(120000);

describe('Job visibility (SEC-02)', () => {
  let app: INestApplication<App>;
  let moduleFixture: TestingModule;
  let dataSource: DataSource;
  let serviceId = 0;
  const uniq = Date.now();
  const token: Record<string, string> = {};
  let openJob: Job;
  let activeJob: Job;
  const server = () => app.getHttpServer();

  beforeAll(async () => {
    moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    app.use(cookieParser());
    const logger = app.get<WinstonLogger>(WINSTON_MODULE_NEST_PROVIDER);
    app.useGlobalFilters(new AllExceptionsFilter(logger), new TypeOrmFilter());
    app.useGlobalInterceptors(new ResponseInterceptor());
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.setGlobalPrefix('api/v1', { exclude: ['/'] });
    await app.init();
    dataSource = moduleFixture.get(DataSource);

    const users: Repository<User> = moduleFixture.get(getRepositoryToken(User));
    const tokens = moduleFixture.get(UserTokenService);
    const make = async (label: string, role: Role) => {
      const u = await users.save(
        users.create({
          email: `jv-${label}-${uniq}@test.jinva.local`,
          username: `jv${label}${uniq}`,
          firstname: 'Job',
          lastname: 'Visibility',
          role,
          accountVerified: true,
        }),
      );
      token[label] = (await tokens.createJWTTokens(u)).access_token;
      return u;
    };
    const owner = await make('owner', Role.CUSTOMER);
    await make('other', Role.CUSTOMER);
    const accepted = await make('accepted', Role.ARTISAN);
    const applicant = await make('applicant', Role.ARTISAN);
    await make('stranger', Role.ARTISAN);
    await make('admin', Role.ADMIN);

    const services: Repository<ServiceEntity> = moduleFixture.get(
      getRepositoryToken(ServiceEntity),
    );
    const service = await services.save(
      services.create({
        name: `Job Visibility ${uniq}`,
        estimatedDurationMins: 60,
      }),
    );
    serviceId = service.id;

    const jobs: Repository<Job> = moduleFixture.get(getRepositoryToken(Job));
    const base = {
      customer: owner,
      service,
      description: 'Leaking kitchen tap needs a new washer',
      location: 'Osu, Greater Accra',
      currency: 'GHS',
    };
    openJob = await jobs.save(
      jobs.create({ ...base, title: `Open job ${uniq}`, status: Status.OPEN }),
    );
    activeJob = await jobs.save(
      jobs.create({
        ...base,
        title: `Active job ${uniq}`,
        status: Status.IN_PROGRESS,
        acceptedArtisan: accepted,
      }),
    );
    const apps: Repository<JobApplication> = moduleFixture.get(
      getRepositoryToken(JobApplication),
    );
    await apps.save(
      apps.create({
        job: activeJob,
        artisan: applicant,
        status: ApplicationStatus.REJECTED,
      }),
    );
  });

  afterAll(async () => {
    await removeTestData(dataSource, {
      userIds: await testUserIds(dataSource, 'jv-'),
      serviceIds: serviceId ? [serviceId] : [],
    });
    await app.close();
  });

  const getJob = (who: string, id: number) =>
    request(server())
      .get(`/api/v1/jobs/${id}`)
      .set('Authorization', `Bearer ${token[who]}`);

  const listIds = async (who: string) => {
    const res = await request(server())
      .get('/api/v1/jobs?limit=50')
      .set('Authorization', `Bearer ${token[who]}`);
    expect(res.status).toBe(200);
    return (res.body as { data: Array<{ id: number }> }).data.map((j) => j.id);
  };

  it.each([
    ['owner', 200, 200],
    ['other', 404, 404],
    ['accepted', 200, 200],
    ['applicant', 200, 200],
    ['stranger', 200, 404],
    ['admin', 200, 200],
  ])(
    '%s reads the open job (%i) and the in-progress job (%i)',
    async (who, open, active) => {
      expect((await getJob(who, openJob.id)).status).toBe(open);
      expect((await getJob(who, activeJob.id)).status).toBe(active);
    },
  );

  it('lists only what each role may see', async () => {
    const mine = [openJob.id, activeJob.id];
    expect(await listIds('owner')).toEqual(expect.arrayContaining(mine));
    const other = await listIds('other');
    expect(other).not.toContain(openJob.id);
    expect(other).not.toContain(activeJob.id);
    const stranger = await listIds('stranger');
    expect(stranger).toContain(openJob.id);
    expect(stranger).not.toContain(activeJob.id);
    expect(await listIds('accepted')).toEqual(expect.arrayContaining(mine));
    expect(await listIds('applicant')).toEqual(expect.arrayContaining(mine));
  });
});

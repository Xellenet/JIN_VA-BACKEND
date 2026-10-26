/**
 * QA JOB-08 / JOB-11 / JOB-18 / PAY-15, over real HTTP and the real database:
 * an application's price becomes the payment, work can't start unpaid, and a
 * refused refund leaves the job untouched. Paystack calls are refused by the
 * e2e isolation setup, which is exactly the "provider down" case. Everything
 * this suite creates is removed afterwards.
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
import { ArtisanProfile } from '@users/entities/artisan-profile.entity';
import { UserTokenService } from '@users/token.service';
import { ServiceEntity } from '@services/entities/service.entity';
import { Payment } from '../src/payments/entities/payment.entity';
import { PaymentStatus, Role } from '@common/types/enums';
import { removeTestData, testUserIds } from './helpers/test-data';

jest.setTimeout(120000);

describe('Job payment flow (JOB-08, JOB-11, JOB-18, PAY-15)', () => {
  let app: INestApplication<App>;
  let moduleFixture: TestingModule;
  let dataSource: DataSource;
  let payments: Repository<Payment>;
  let serviceId = 0;
  const uniq = Date.now();
  const token: Record<string, string> = {};
  const server = () => app.getHttpServer();
  const as = (who: string) => ({ Authorization: `Bearer ${token[who]}` });

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
    payments = moduleFixture.get(getRepositoryToken(Payment));

    const users: Repository<User> = moduleFixture.get(getRepositoryToken(User));
    const profiles: Repository<ArtisanProfile> = moduleFixture.get(
      getRepositoryToken(ArtisanProfile),
    );
    const tokens = moduleFixture.get(UserTokenService);
    const make = async (label: string, role: Role) => {
      const u = await users.save(
        users.create({
          email: `jpf-${label}-${uniq}@test.jinva.local`,
          username: `jpf${label}${uniq}`,
          firstname: 'Pay',
          lastname: 'Flow',
          role,
          accountVerified: true,
        }),
      );
      if (role === Role.ARTISAN) {
        await profiles.save(profiles.create({ user: u, hourlyRate: 80 }));
      }
      token[label] = (await tokens.createJWTTokens(u)).access_token;
    };
    await make('customer', Role.CUSTOMER);
    await make('artisanA', Role.ARTISAN);
    await make('artisanB', Role.ARTISAN);

    const services: Repository<ServiceEntity> = moduleFixture.get(
      getRepositoryToken(ServiceEntity),
    );
    serviceId = (
      await services.save(
        services.create({
          name: `Pay Flow ${uniq}`,
          estimatedDurationMins: 60,
        }),
      )
    ).id;
  });

  afterAll(async () => {
    await removeTestData(dataSource, {
      userIds: await testUserIds(dataSource, 'jpf-'),
      serviceIds: serviceId ? [serviceId] : [],
    });
    await app.close();
  });

  async function postJob(title: string): Promise<number> {
    const res = await request(server())
      .post('/api/v1/jobs')
      .set(as('customer'))
      .send({
        title,
        description: 'Bathroom tap is leaking and needs a new washer',
        serviceId,
        location: 'Osu, Greater Accra',
        budgetMin: 100,
        budgetMax: 200,
        currency: 'GHS',
      });
    expect(res.status).toBe(201);
    return (res.body as { data: { id: number } }).data.id;
  }

  const apply = (who: string, jobId: number, body: object) =>
    request(server())
      .post(`/api/v1/jobs/${jobId}/apply`)
      .set(as(who))
      .send(body);

  async function acceptFirst(jobId: number) {
    const list = await request(server())
      .get(`/api/v1/jobs/${jobId}/applications`)
      .set(as('customer'));
    const apps = (
      list.body as { data: Array<{ id: number; artisan: { email?: string } }> }
    ).data;
    const res = await request(server())
      .post(`/api/v1/jobs/${jobId}/applications/${apps[0].id}/accept`)
      .set(as('customer'));
    expect(res.status).toBe(201);
  }

  it('rejects a zero quote, and the accepted quote becomes the payment', async () => {
    const jobId = await postJob(`Quote job ${uniq}`);
    expect((await apply('artisanA', jobId, { quotePrice: 0 })).status).toBe(
      400,
    );
    expect((await apply('artisanA', jobId, { quotePrice: 175.5 })).status).toBe(
      201,
    );
    await acceptFirst(jobId);
    const payment = await payments.findOneByOrFail({ jobId });
    expect(Number(payment.amount)).toBe(175.5);
    expect(payment.status).toBe(PaymentStatus.PENDING);
  });

  it("won't start unpaid work, and starts once the payment is held", async () => {
    const jobId = await postJob(`Start job ${uniq}`);
    await apply('artisanA', jobId, { quotePrice: 150 });
    await acceptFirst(jobId);
    const start = () =>
      request(server())
        .patch(`/api/v1/jobs/${jobId}/start`)
        .set(as('artisanA'));

    const unpaid = await start();
    expect(unpaid.status).toBe(400);
    expect((unpaid.body as { message: string }).message).toMatch(/hasn't paid/);

    await payments.update({ jobId }, { status: PaymentStatus.HELD });
    expect((await start()).status).toBe(200);
  });

  it('a refused refund leaves the paid job and its money untouched', async () => {
    const jobId = await postJob(`Refund job ${uniq}`);
    await apply('artisanA', jobId, { quotePrice: 120 });
    await acceptFirst(jobId);
    await payments.update({ jobId }, { status: PaymentStatus.HELD });

    const cancel = await request(server())
      .patch(`/api/v1/jobs/${jobId}/cancel`)
      .set(as('customer'));
    expect(cancel.status).toBe(503);

    const job = await request(server())
      .get(`/api/v1/jobs/${jobId}`)
      .set(as('customer'));
    expect((job.body as { data: { status: string } }).data.status).toBe(
      'PENDING',
    );
    expect((await payments.findOneByOrFail({ jobId })).status).toBe(
      PaymentStatus.HELD,
    );
  });

  it('cancelling an unpaid job voids the payment and closes the other applications', async () => {
    const jobId = await postJob(`Cancel job ${uniq}`);
    await apply('artisanA', jobId, { quotePrice: 130 });
    await apply('artisanB', jobId, { quotePrice: 140 });
    await acceptFirst(jobId);
    // Accepting already rejects the other applicant; post a fresh OPEN job to
    // check that an open job's pending applications close on cancel too.
    const openJob = await postJob(`Open cancel ${uniq}`);
    await apply('artisanB', openJob, { quotePrice: 99 });

    for (const id of [jobId, openJob]) {
      const res = await request(server())
        .patch(`/api/v1/jobs/${id}/cancel`)
        .set(as('customer'));
      expect(res.status).toBe(200);
    }
    expect((await payments.findOneByOrFail({ jobId })).status).toBe(
      PaymentStatus.CANCELLED,
    );
    const [row]: Array<{ status: string }> = await dataSource.query(
      'SELECT status FROM job_applications WHERE job_id = $1',
      [openJob],
    );
    expect(row.status).toBe('REJECTED');
  });
});

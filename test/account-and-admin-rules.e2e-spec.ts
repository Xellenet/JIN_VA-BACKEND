/**
 * QA fix group 9 and the Minor list, over real HTTP and the real database:
 *   AUTH-04 email case, AUTH-28 password confirmation, SEC-14 Google-only
 *   login, AUTH-31 "Remember me", ADM-12 deleting a service in use, JOB-16
 *   editing an accepted job, FAV-07 hidden favourites, ADM-03 / PAY-21
 *   server-side admin search, DSP-03 blank reasons.
 * Everything this suite creates is removed afterwards.
 */
process.env.AUTH_RATE_LIMIT_PER_MINUTE = '10000';

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { WINSTON_MODULE_NEST_PROVIDER } from 'nest-winston';
import { DataSource, Repository } from 'typeorm';
import request from 'supertest';
import { App } from 'supertest/types';
import cookieParser from 'cookie-parser';
import * as bcrypt from 'bcrypt';
import type { Logger as WinstonLogger } from 'winston';
import { AppModule } from '../src/app.module';
import { ResponseInterceptor } from '../src/common/interceptors/response.interceptor';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { TypeOrmFilter } from '../src/common/filters/typeorm-exception.filter';
import { User } from '@users/entities/user.entity';
import { ArtisanProfile } from '@users/entities/artisan-profile.entity';
import { UserTokenService } from '@users/token.service';
import { ServiceEntity } from '@services/entities/service.entity';
import { Role } from '@common/types/enums';
import { removeTestData, testUserIds } from './helpers/test-data';

jest.setTimeout(120000);

const PASSWORD = 'RulesCheck#2026';

describe('Account and admin rules (fix group 9, Minor list)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let users: Repository<User>;
  let serviceId = 0;
  const uniq = Date.now();
  const token: Record<string, string> = {};
  const userOf: Record<string, User> = {};
  const profileOf: Record<string, number> = {};
  const server = () => app.getHttpServer();
  const as = (who: string) => ({ Authorization: `Bearer ${token[who]}` });
  const email = (label: string) => `ar-${label}-${uniq}@test.jinva.local`;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
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
    users = moduleFixture.get(getRepositoryToken(User));
    const profiles: Repository<ArtisanProfile> = moduleFixture.get(
      getRepositoryToken(ArtisanProfile),
    );
    const services: Repository<ServiceEntity> = moduleFixture.get(
      getRepositoryToken(ServiceEntity),
    );
    const service = await services.save(
      services.create({
        name: `Rules Masonry ${uniq}`,
        estimatedDurationMins: 60,
      }),
    );
    serviceId = service.id;
    const tokens = moduleFixture.get(UserTokenService);
    const hash = await bcrypt.hash(PASSWORD, 10);
    const make = async (
      label: string,
      role: Role,
      password: string | null = hash,
    ) => {
      const u = await users.save(
        users.create({
          email: email(label),
          username: `ar${label}${uniq}`,
          firstname: 'Kwesi',
          lastname: label === 'customer' ? 'Appiah' : 'Boadu',
          role,
          accountVerified: true,
          password,
        }),
      );
      userOf[label] = u;
      if (role === Role.ARTISAN) {
        profileOf[label] = (
          await profiles.save(
            profiles.create({
              user: u,
              hourlyRate: 75,
              location: 'Ho, Volta',
              currency: 'GHS',
              isProfileComplete: true,
              services: [service],
            }),
          )
        ).id;
      }
      token[label] = (await tokens.createJWTTokens(u)).access_token;
    };
    await make('customer', Role.CUSTOMER);
    await make('artisan', Role.ARTISAN);
    await make('admin', Role.ADMIN);
    await make('google', Role.CUSTOMER, null);
  });

  afterAll(async () => {
    try {
      await removeTestData(dataSource, {
        userIds: await testUserIds(dataSource, 'ar-'),
        serviceIds: serviceId ? [serviceId] : [],
      });
    } finally {
      await app.close();
    }
  });

  const login = (body: Record<string, unknown>) =>
    request(server()).post('/api/v1/auth/login').send(body);

  it('treats an email the same whatever its case (AUTH-04)', async () => {
    const mixed = `AR-Mixed-${uniq}@Test.Jinva.Local`;
    const register = (address: string, phoneSuffix: string) =>
      request(server())
        .post('/api/v1/auth/register')
        .send({
          email: address,
          password: PASSWORD,
          username: `armixed${phoneSuffix}${uniq}`,
          firstname: 'Efua',
          lastname: 'Mensah',
          phoneNumber: `+23324${phoneSuffix}${String(uniq).slice(-6)}`,
          gender: 'FEMALE',
          role: 'CUSTOMER',
        });
    expect((await register(mixed, '1')).status).toBe(201);
    const [row]: Array<{ email: string }> = await dataSource.query(
      'SELECT email FROM users WHERE LOWER(email) = LOWER($1)',
      [mixed],
    );
    expect(row.email).toBe(mixed.toLowerCase());
    expect((await register(mixed.toLowerCase(), '2')).status).toBe(409);
    await users.update(
      { email: mixed.toLowerCase() },
      { accountVerified: true },
    );
    expect(
      (await login({ email: mixed.toUpperCase(), password: PASSWORD })).status,
    ).toBe(200);
  });

  it('refuses a new password whose confirmation differs (AUTH-28)', async () => {
    const res = await request(server())
      .post('/api/v1/auth/change-password')
      .set(as('customer'))
      .send({
        currentPassword: PASSWORD,
        newPassword: 'NewRules#2026',
        confirmNewPassword: 'NewRules#2027',
      });
    expect(res.status).toBe(400);
    expect(
      (await login({ email: email('customer'), password: PASSWORD })).status,
    ).toBe(200);
  });

  it('answers a Google-only account like any wrong password (SEC-14)', async () => {
    const google = await login({
      email: email('google'),
      password: 'Whatever#2026',
    });
    const unknown = await login({
      email: email('nobody'),
      password: 'Whatever#2026',
    });
    expect(google.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect((google.body as { message: string }).message).toBe(
      (unknown.body as { message: string }).message,
    );
  });

  it('keeps an unticked "Remember me" sign-in to the browser session (AUTH-31)', async () => {
    const cookieHeaders = (res: request.Response) =>
      (res.headers['set-cookie'] as unknown as string[]) ?? [];
    const remembered = await login({
      email: email('customer'),
      password: PASSWORD,
    });
    expect(
      cookieHeaders(remembered).find((c) => c.startsWith('refresh_token=')),
    ).toMatch(/Max-Age=/);

    const sessionOnly = await login({
      email: email('customer'),
      password: PASSWORD,
      rememberMe: false,
    });
    const cookies = cookieHeaders(sessionOnly);
    const refresh = cookies.find((c) => c.startsWith('refresh_token='))!;
    expect(refresh).not.toMatch(/Max-Age=/);
    expect(cookies.some((c) => c.startsWith('jinva_session_only=1'))).toBe(
      true,
    );

    const refreshed = await request(server())
      .post('/api/v1/auth/refresh-token')
      .set('Cookie', cookies.map((c) => c.split(';')[0]).join('; '));
    expect(refreshed.status).toBe(200);
    expect(
      cookieHeaders(refreshed).find((c) => c.startsWith('refresh_token=')),
    ).not.toMatch(/Max-Age=/);
  });

  it("won't delete a service artisans offer, and says why (ADM-12)", async () => {
    const res = await request(server())
      .delete(`/api/v1/services/${serviceId}`)
      .set(as('admin'));
    expect(res.status).toBe(409);
    expect((res.body as { message: string }).message).toMatch(
      /1 artisan offers it/,
    );
  });

  it('allows editing a job only while it is open (JOB-16)', async () => {
    const posted = await request(server())
      .post('/api/v1/jobs')
      .set(as('customer'))
      .send({
        title: `Fix a cracked wall ${uniq}`,
        description: 'Long crack in the sitting room wall needs filling',
        serviceId,
        location: 'Ho, Volta',
        budgetMin: 200,
        budgetMax: 300,
        currency: 'GHS',
      });
    const jobId = (posted.body as { data: { id: number } }).data.id;
    const edit = (body: object) =>
      request(server())
        .patch(`/api/v1/jobs/${jobId}`)
        .set(as('customer'))
        .send(body);

    expect((await edit({ title: 'Tiny' })).status).toBe(400);
    expect((await edit({ budgetMax: 350 })).status).toBe(200);

    await request(server())
      .post(`/api/v1/jobs/${jobId}/apply`)
      .set(as('artisan'))
      .send({ quotePrice: 320 });
    const apps = await request(server())
      .get(`/api/v1/jobs/${jobId}/applications`)
      .set(as('customer'));
    const appId = (apps.body as { data: Array<{ id: number }> }).data[0].id;
    await request(server())
      .post(`/api/v1/jobs/${jobId}/applications/${appId}/accept`)
      .set(as('customer'));

    const late = await edit({ budgetMax: 50 });
    expect(late.status).toBe(400);
    expect((late.body as { message: string }).message).toMatch(
      /can no longer be edited/,
    );
  });

  it('hides a suspended artisan from favourites until they are reactivated (FAV-07)', async () => {
    const ids = async () => {
      const res = await request(server())
        .get('/api/v1/favourites')
        .set(as('customer'));
      return (res.body as { data: Array<{ id: number }> }).data.map((a) =>
        Number(a.id),
      );
    };
    await request(server())
      .post(`/api/v1/favourites/${profileOf.artisan}`)
      .set(as('customer'));
    expect(await ids()).toContain(profileOf.artisan);
    await users.update({ id: userOf.artisan.id }, { isSuspended: true });
    expect(await ids()).not.toContain(profileOf.artisan);
    await users.update({ id: userOf.artisan.id }, { isSuspended: false });
    expect(await ids()).toContain(profileOf.artisan);
  });

  it('searches clients and artisans on the server (ADM-03)', async () => {
    const clients = await request(server())
      .get(
        `/api/v1/admin/users?role=CUSTOMER&search=${encodeURIComponent(`ar-customer-${uniq}`)}`,
      )
      .set(as('admin'));
    expect(
      (clients.body as { data: Array<{ email: string }> }).data.map(
        (u) => u.email,
      ),
    ).toEqual([email('customer')]);
    const artisans = await request(server())
      .get(
        `/api/v1/admin/artisans?search=${encodeURIComponent(`Rules Masonry ${uniq}`)}`,
      )
      .set(as('admin'));
    const found = (
      artisans.body as { data: Array<{ id: number; accountStatus: string }> }
    ).data;
    expect(found.map((a) => a.id)).toEqual([profileOf.artisan]);
    expect(found[0].accountStatus).toBe('ACTIVE');
  });

  it('filters the payment ledger on the server (PAY-21)', async () => {
    const res = await request(server())
      .get(
        `/api/v1/payments/admin/all?search=${encodeURIComponent(`Fix a cracked wall ${uniq}`)}`,
      )
      .set(as('admin'));
    expect(res.status).toBe(200);
    expect((res.body as { data: Array<{ amount: string }> }).data).toHaveLength(
      1,
    );
    const summary = await request(server())
      .get('/api/v1/payments/admin/summary')
      .set(as('admin'));
    expect(summary.status).toBe(200);
    expect(summary.body).toHaveProperty('data.totalRevenue');
    expect(
      (
        await request(server())
          .get('/api/v1/payments/admin/all?status=NOPE')
          .set(as('admin'))
      ).status,
    ).toBe(400);
  });

  it('refuses a dispute reason that is only spaces (DSP-03)', async () => {
    const res = await request(server())
      .post('/api/v1/disputes')
      .set(as('customer'))
      .send({ bookingId: 1, category: 'WORK_QUALITY', reason: ' '.repeat(25) });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/detailed reason/);
  });
});

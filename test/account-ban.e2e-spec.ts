/**
 * QA AUTH-17 / ADM-04: a banned account used to log in and refresh normally,
 * then get bounced to /login with no explanation. Over real HTTP: banning ends
 * the session, login and refresh refuse with ACCOUNT_BANNED, and an unban
 * restores access. Everything this suite creates is removed afterwards.
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
import { UserTokenService } from '@users/token.service';
import { Role } from '@common/types/enums';
import { removeTestData, testUserIds } from './helpers/test-data';

jest.setTimeout(120000);

const PASSWORD = 'BanCheck#2026';

describe('Banned accounts (AUTH-17, ADM-04)', () => {
  let app: INestApplication<App>;
  let moduleFixture: TestingModule;
  let dataSource: DataSource;
  let adminToken = '';
  let customer: User;
  const uniq = Date.now();
  const customerEmail = `ban-customer-${uniq}@test.jinva.local`;
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
    const hash = await bcrypt.hash(PASSWORD, 10);
    const admin = await users.save(
      users.create({
        email: `ban-admin-${uniq}@test.jinva.local`,
        username: `banadmin${uniq}`,
        firstname: 'Ban',
        lastname: 'Admin',
        role: Role.ADMIN,
        accountVerified: true,
        password: hash,
      }),
    );
    adminToken = (
      await moduleFixture.get(UserTokenService).createJWTTokens(admin)
    ).access_token;
    customer = await users.save(
      users.create({
        email: customerEmail,
        username: `bancustomer${uniq}`,
        firstname: 'Ban',
        lastname: 'Customer',
        role: Role.CUSTOMER,
        accountVerified: true,
        password: hash,
      }),
    );
  });

  afterAll(async () => {
    await removeTestData(dataSource, {
      userIds: await testUserIds(dataSource, 'ban-'),
    });
    await app.close();
  });

  const login = (password = PASSWORD) =>
    request(server())
      .post('/api/v1/auth/login')
      .send({ email: customerEmail, password });

  const errorCode = (res: request.Response) =>
    (res.body as { meta?: { error?: string } }).meta?.error;

  it('ends the session, refuses login and refresh, then an unban restores access', async () => {
    const first = await login();
    expect(first.status).toBe(200);
    const access = (first.body as { access_token: string }).access_token;
    const cookie = (first.headers['set-cookie'] as unknown as string[])
      .find((c) => c.startsWith('refresh_token='))!
      .split(';')[0];

    const ban = await request(server())
      .patch(`/api/v1/admin/users/${customer.id}/ban`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reason: 'Repeated no-shows reported by artisans' });
    expect(ban.status).toBe(200);

    const me = await request(server())
      .get('/api/v1/users/me')
      .set('Authorization', `Bearer ${access}`);
    expect(me.status).toBe(403);
    expect(errorCode(me)).toBe('ACCOUNT_BANNED');

    const refresh = await request(server())
      .post('/api/v1/auth/refresh-token')
      .set('Cookie', cookie);
    expect(refresh.status).not.toBe(200);

    const relogin = await login();
    expect(relogin.status).toBe(403);
    expect(errorCode(relogin)).toBe('ACCOUNT_BANNED');
    expect(relogin.headers['set-cookie']).toBeUndefined();

    const wrong = await login('Wrong#Password1');
    expect(wrong.status).toBe(401);

    const unban = await request(server())
      .patch(`/api/v1/admin/users/${customer.id}/unban`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(unban.status).toBe(200);
    expect((await login()).status).toBe(200);
  });
});

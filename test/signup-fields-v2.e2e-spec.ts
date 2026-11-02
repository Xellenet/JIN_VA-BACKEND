/**
 * Sign-up form v2, over real HTTP and the hermetic test database
 * (test/support: in-process Postgres, generated keys, network refused):
 *
 * - an optional middle name is stored on register, returned by GET /users/me,
 *   and can be changed and cleared through PATCH /users/me;
 * - a username with a space is refused on register and on PATCH /users/me;
 * - a phone typed with a trunk 0 after the calling code (`+233 024…`, the
 *   form an old client could still send) is stored without it.
 *
 * Every row uses an @example.com address with a per-run tag and is deleted
 * in `afterAll`.
 *
 * Run: npm run test:e2e -- signup-fields-v2 --runInBand
 */
process.env.AUTH_RATE_LIMIT_PER_MINUTE = '10000';
process.env.AUTH_EMAIL_RATE_LIMIT_PER_MINUTE = '10000';

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

jest.setTimeout(120000);

const PASSWORD = 'Signup#2026v2';

describe('Sign-up form v2 (middle name, username, trunk 0)', () => {
  let app: INestApplication<App>;
  let moduleFixture: TestingModule;
  let userRepo: Repository<User>;
  let dataSource: DataSource;
  const uniq = Date.now();
  const tail = String(uniq).slice(-6);
  const createdIds: number[] = [];
  const server = () => app.getHttpServer();
  const email = (label: string) => `sfv2-${label}-${uniq}@example.com`;

  const body = (label: string, n: number, extra: Record<string, unknown>) => ({
    email: email(label),
    password: PASSWORD,
    username: `sfv2.${label}${tail}`,
    firstname: 'Ama',
    lastname: 'Mensah',
    phoneNumber: `+23324${n}${tail}`,
    gender: 'FEMALE',
    role: 'CUSTOMER',
    ...extra,
  });

  async function registered(label: string): Promise<User> {
    const user = await userRepo.findOneOrFail({
      where: { email: email(label) },
    });
    createdIds.push(user.id);
    return user;
  }

  async function login(label: string): Promise<string> {
    const user = await registered(label);
    await userRepo.update(user.id, {
      accountVerified: true,
      verifiedAt: new Date(),
    });
    const res = await request(server())
      .post('/api/v1/auth/login')
      .send({ email: email(label), password: PASSWORD });
    expect(res.status).toBe(200);
    return (res.body as { access_token: string }).access_token;
  }

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
    userRepo = moduleFixture.get(getRepositoryToken(User));
    dataSource = moduleFixture.get(DataSource);
  });

  afterAll(async () => {
    if (createdIds.length) {
      for (const table of [
        'user_tokens',
        'notification_preferences',
        'customer_profiles',
      ]) {
        await dataSource
          .query(`DELETE FROM ${table} WHERE user_id = ANY($1)`, [createdIds])
          .catch(() => undefined);
      }
      await dataSource
        .query('DELETE FROM users WHERE id = ANY($1)', [createdIds])
        .catch(() => undefined);
    }
    await app.close();
  });

  it('stores an optional middle name, returns it, and lets the owner change and clear it', async () => {
    const res = await request(server())
      .post('/api/v1/auth/register')
      .send(body('middle', 1, { middlename: '  Kwame ' }));
    expect(res.status).toBe(201);
    expect((await registered('middle')).middlename).toBe('Kwame');

    const token = await login('middle');
    const me = await request(server())
      .get('/api/v1/users/me')
      .set('Authorization', `Bearer ${token}`);
    expect(me.status).toBe(200);
    expect((me.body as { data: { middlename: string } }).data.middlename).toBe(
      'Kwame',
    );

    const changed = await request(server())
      .patch('/api/v1/users/me')
      .set('Authorization', `Bearer ${token}`)
      .send({ middlename: 'Kofi' });
    expect(changed.status).toBe(200);
    expect((await registered('middle')).middlename).toBe('Kofi');

    const cleared = await request(server())
      .patch('/api/v1/users/me')
      .set('Authorization', `Bearer ${token}`)
      .send({ middlename: '' });
    expect(cleared.status).toBe(200);
    expect((await registered('middle')).middlename).toBeNull();

    const tooLong = await request(server())
      .patch('/api/v1/users/me')
      .set('Authorization', `Bearer ${token}`)
      .send({ middlename: 'a'.repeat(16) });
    expect(tooLong.status).toBe(400);
  });

  it('leaves the middle name null when it is not given', async () => {
    const res = await request(server())
      .post('/api/v1/auth/register')
      .send(body('nomiddle', 2, {}));
    expect(res.status).toBe(201);
    expect((await registered('nomiddle')).middlename).toBeNull();
  });

  it('refuses a username with a space, on register and on PATCH /users/me', async () => {
    const res = await request(server())
      .post('/api/v1/auth/register')
      .send(body('spaced', 3, { username: `ama mensah${tail}` }));
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/username/i);
    expect(
      await userRepo.findOne({ where: { email: email('spaced') } }),
    ).toBeNull();

    const ok = await request(server())
      .post('/api/v1/auth/register')
      .send(body('rename', 4, {}));
    expect(ok.status).toBe(201);
    const token = await login('rename');
    const patch = await request(server())
      .patch('/api/v1/users/me')
      .set('Authorization', `Bearer ${token}`)
      .send({ username: 'ama mensah' });
    expect(patch.status).toBe(400);
    expect((await registered('rename')).username).toBe(`sfv2.rename${tail}`);
  });

  it('stores a phone typed with a trunk 0 after +233 without it', async () => {
    const res = await request(server())
      .post('/api/v1/auth/register')
      .send(body('trunk', 5, { phoneNumber: `+233 0245 ${tail}` }));
    expect(res.status).toBe(201);
    expect((await registered('trunk')).phoneNumber).toBe(`+233245${tail}`);
  });
});

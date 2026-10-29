/**
 * QA AUTH-12 / AUTH-24: a password reset or email verification sent with no
 * token used to match whichever account held a pending token of that type
 * (TypeORM drops `undefined` from a where clause). Over real HTTP and the real
 * database: token-less and empty-token calls must change nothing, and the
 * legitimate flows must keep working.
 *
 * QA SEC-05/06/08: a refresh token must never authenticate a request as an
 * access token: not after login, logout, rotation or a password reset.
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
import { UserTokenService } from '@users/token.service';
import { Token } from '@common/types/enums';

jest.setTimeout(120000);

const PASSWORD = 'Original#2026';
const NEW_PASSWORD = 'Changed#2026';

describe('Missing-token guard (AUTH-12, AUTH-24)', () => {
  let app: INestApplication<App>;
  let moduleFixture: TestingModule;
  let userRepo: Repository<User>;
  let tokens: UserTokenService;
  let dataSource: DataSource;
  const uniq = Date.now();
  const createdIds: number[] = [];
  const server = () => app.getHttpServer();
  const email = (label: string) =>
    `token-guard-${label}-${uniq}@test.jinva.local`;
  const phone = (n: number) => `+23324${n}${String(uniq).slice(-6)}`;

  async function register(label: string, n: number): Promise<User> {
    const res = await request(server())
      .post('/api/v1/auth/register')
      .send({
        email: email(label),
        password: PASSWORD,
        username: `tg${label}${uniq}`,
        firstname: 'Token',
        lastname: 'Guard',
        phoneNumber: phone(n),
        gender: 'FEMALE',
        role: 'CUSTOMER',
      });
    expect(res.status).toBe(201);
    const user = await userRepo.findOneOrFail({
      where: { email: email(label) },
      select: { id: true, email: true, password: true, accountVerified: true },
    });
    createdIds.push(user.id);
    return user;
  }

  const reload = (id: number) =>
    userRepo.findOneOrFail({
      where: { id },
      select: { id: true, password: true, accountVerified: true },
    });

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
    tokens = moduleFixture.get(UserTokenService);
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

  it('a reset with no token, or an empty token, changes no password', async () => {
    const victim = await register('reset', 1);
    await userRepo.update(victim.id, { accountVerified: true });
    const resetToken = await tokens.createToken(
      victim,
      Token.PASSWORD_RESET,
      60,
    );

    for (const query of ['', '?token=', '?token=%20%20']) {
      const res = await request(server())
        .post(`/api/v1/auth/reset-password${query}`)
        .send({ newPassword: NEW_PASSWORD, confirmNewPassword: NEW_PASSWORD });
      expect(res.status).toBe(400);
    }

    expect((await reload(victim.id)).password).toBe(victim.password);
    // The victim's real link still works afterwards: it was not consumed.
    const ok = await request(server())
      .post(`/api/v1/auth/reset-password?token=${resetToken.token}`)
      .send({ newPassword: NEW_PASSWORD, confirmNewPassword: NEW_PASSWORD });
    expect(ok.status).toBe(200);
    const login = await request(server())
      .post('/api/v1/auth/login')
      .send({ email: email('reset'), password: NEW_PASSWORD });
    expect(login.status).toBe(200);

    // A used link can't be replayed.
    const replay = await request(server())
      .post(`/api/v1/auth/reset-password?token=${resetToken.token}`)
      .send({ newPassword: PASSWORD, confirmNewPassword: PASSWORD });
    expect(replay.status).toBe(400);
  });

  it('a verification with no token, or an empty token, verifies nobody', async () => {
    const pending = await register('verify', 2);
    expect(pending.accountVerified).toBeFalsy();

    for (const body of [{}, { token: '' }, { token: '   ' }]) {
      const res = await request(server())
        .post('/api/v1/auth/verify-email')
        .send(body);
      expect(res.status).toBe(400);
    }
    expect((await reload(pending.id)).accountVerified).toBeFalsy();

    // The real link from registration still verifies the account.
    const [row]: Array<{ token: string }> = await dataSource.query(
      'SELECT token FROM user_tokens WHERE user_id = $1 AND type = $2',
      [pending.id, Token.EMAIL_VERIFICATION],
    );
    const ok = await request(server())
      .post('/api/v1/auth/verify-email')
      .send({ token: row.token });
    expect(ok.status).toBe(200);
    expect((await reload(pending.id)).accountVerified).toBe(true);
  });

  describe('refresh tokens are not access tokens (SEC-05, SEC-06, SEC-08)', () => {
    const refreshCookie = (res: request.Response): string => {
      const raw = res.headers['set-cookie'] as unknown as string[] | undefined;
      const c = (raw ?? []).find((x) => x.startsWith('refresh_token='));
      return c ? c.split(';')[0].slice('refresh_token='.length) : '';
    };

    async function verifiedUser(label: string, n: number) {
      const u = await register(label, n);
      await userRepo.update(u.id, { accountVerified: true });
      const login = await request(server())
        .post('/api/v1/auth/login')
        .send({ email: email(label), password: PASSWORD });
      expect(login.status).toBe(200);
      return {
        user: u,
        access: (login.body as { access_token: string }).access_token,
        refresh: refreshCookie(login),
      };
    }

    const me = (bearer: string) =>
      request(server())
        .get('/api/v1/users/me')
        .set('Authorization', `Bearer ${bearer}`);

    it('the access token works and the refresh token is refused as a Bearer token', async () => {
      const s = await verifiedUser('typ', 3);
      expect((await me(s.access)).status).toBe(200);
      expect(s.refresh).not.toBe('');
      expect((await me(s.refresh)).status).toBe(401);

      // Normal refresh still works and returns a working access token.
      const refreshed = await request(server())
        .post('/api/v1/auth/refresh-token')
        .set('Cookie', `refresh_token=${s.refresh}`);
      expect(refreshed.status).toBe(200);
      const newAccess = (refreshed.body as { access_token: string })
        .access_token;
      expect((await me(newAccess)).status).toBe(200);
      // The rotated (consumed) refresh token is refused both ways.
      expect((await me(s.refresh)).status).toBe(401);
      const replay = await request(server())
        .post('/api/v1/auth/refresh-token')
        .set('Cookie', `refresh_token=${s.refresh}`);
      expect(replay.status).not.toBe(200);
    });

    it('after logout the old refresh token neither refreshes nor authenticates', async () => {
      const s = await verifiedUser('logout', 4);
      const out = await request(server())
        .post('/api/v1/auth/logout')
        .set('Authorization', `Bearer ${s.access}`)
        .set('Cookie', `refresh_token=${s.refresh}`);
      expect(out.status).toBe(200);
      expect((await me(s.refresh)).status).toBe(401);
      const again = await request(server())
        .post('/api/v1/auth/refresh-token')
        .set('Cookie', `refresh_token=${s.refresh}`);
      expect(again.status).not.toBe(200);
    });

    it('after a password reset the old refresh token is useless', async () => {
      const s = await verifiedUser('resetsess', 5);
      const reset = await tokens.createToken(s.user, Token.PASSWORD_RESET, 60);
      const ok = await request(server())
        .post(`/api/v1/auth/reset-password?token=${reset.token}`)
        .send({ newPassword: NEW_PASSWORD, confirmNewPassword: NEW_PASSWORD });
      expect(ok.status).toBe(200);
      expect((await me(s.refresh)).status).toBe(401);
      const again = await request(server())
        .post('/api/v1/auth/refresh-token')
        .set('Cookie', `refresh_token=${s.refresh}`);
      expect(again.status).not.toBe(200);
    });
  });
});

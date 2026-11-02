/**
 * Customer Experience v2, SEC-37 / T-9 / E-5.11, against the in-memory
 * database: the account purge removes the customer's payment settings and
 * security events and leaves everyone else's alone; the daily retention job
 * removes security events older than 12 months.
 *
 * Every person and value here is fictional.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { ResponseInterceptor } from '../src/common/interceptors/response.interceptor';
import { User } from '@users/entities/user.entity';
import { UserTokenService } from '@users/token.service';
import { AccountPurgeService } from '@users/account-purge.service';
import { Role } from '@common/types/enums';
import { AccountSecurityService } from '../src/account-security/account-security.service';
import { removeTestData, testUserIds } from './helpers/test-data';

jest.setTimeout(120000);

const PREFIX = 'cx2pu-';

describe('Customer Experience v2 purge and retention (SEC-37)', () => {
  let app: INestApplication<App>;
  let moduleFixture: TestingModule;
  let dataSource: DataSource;
  let purge: AccountPurgeService;
  let security: AccountSecurityService;
  const uniq = Date.now();
  const token: Record<string, string> = {};
  const ids: Record<string, number> = {};
  let originalMode: string | undefined;
  const server = () => app.getHttpServer();

  const count = async (
    table: 'customer_payment_settings' | 'account_security_events',
    userId: number,
  ) =>
    (
      await dataSource.query<Array<{ c: number }>>(
        `SELECT count(*)::int AS c FROM ${table} WHERE user_id = $1`,
        [userId],
      )
    )[0].c;

  beforeAll(async () => {
    originalMode = process.env.ACCOUNT_PURGE_MODE;
    moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
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
    purge = moduleFixture.get(AccountPurgeService);
    security = moduleFixture.get(AccountSecurityService);

    const users: Repository<User> = moduleFixture.get(getRepositoryToken(User));
    const tokens = moduleFixture.get(UserTokenService);
    for (const label of ['a', 'b']) {
      const u = await users.save(
        users.create({
          email: `${PREFIX}${label}-${uniq}@test.jinva.local`,
          firstname: 'Akosua',
          lastname: 'Frimpong',
          role: Role.CUSTOMER,
          accountVerified: true,
        }),
      );
      ids[label] = u.id;
      token[label] = (await tokens.createJWTTokens(u)).access_token;
      // A settings row and a security event, through the real API.
      const res = await request(server())
        .patch('/api/v1/users/me/payment-settings')
        .set('Authorization', `Bearer ${token[label]}`)
        .send({ preferredChannel: 'card', momoNetwork: 'TELECEL' });
      expect(res.status).toBe(200);
    }
    // A second event kind for A.
    await security.record({ userId: ids.a, event: 'profile_photo.removed' });
  });

  afterAll(async () => {
    if (originalMode === undefined) delete process.env.ACCOUNT_PURGE_MODE;
    else process.env.ACCOUNT_PURGE_MODE = originalMode;
    await removeTestData(dataSource, {
      userIds: await testUserIds(dataSource, PREFIX),
    });
    await app.close();
  });

  it("E-5.11 / T-9: purging A removes A's payment settings and security events, and B keeps theirs", async () => {
    expect(await count('customer_payment_settings', ids.a)).toBe(1);
    expect(await count('account_security_events', ids.a)).toBe(2);
    expect(await count('customer_payment_settings', ids.b)).toBe(1);
    expect(await count('account_security_events', ids.b)).toBe(1);

    // A soft-deleted, past-cutoff account, with destructive mode armed.
    await dataSource.query(
      "UPDATE users SET deleted_at = now() - interval '45 days' WHERE id = $1",
      [ids.a],
    );
    process.env.ACCOUNT_PURGE_MODE = 'destructive';
    expect(await purge.purgeAccount(ids.a)).toBe('purged');

    expect(await count('customer_payment_settings', ids.a)).toBe(0);
    expect(await count('account_security_events', ids.a)).toBe(0);
    expect(await count('customer_payment_settings', ids.b)).toBe(1);
    expect(await count('account_security_events', ids.b)).toBe(1);
  });

  it('the retention job removes events older than 12 months and keeps newer ones', async () => {
    await dataSource.query(
      `INSERT INTO account_security_events (user_id, event, created_at)
       VALUES ($1, 'profile_photo.removed', now() - interval '13 months'),
              ($1, 'profile_photo.removed', now() - interval '11 months')`,
      [ids.b],
    );
    expect(await count('account_security_events', ids.b)).toBe(3);

    const removed = await security.purgeExpiredEvents();
    expect(removed).toBeGreaterThanOrEqual(1);

    const rows = await dataSource.query<Array<{ old: boolean }>>(
      `SELECT created_at < now() - interval '12 months' AS old
         FROM account_security_events WHERE user_id = $1`,
      [ids.b],
    );
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => !r.old)).toBe(true);
  });

  it('a hard-deleted user takes both rows with it (ON DELETE CASCADE)', async () => {
    await dataSource.query('DELETE FROM users WHERE id = $1', [ids.b]);
    expect(await count('customer_payment_settings', ids.b)).toBe(0);
    expect(await count('account_security_events', ids.b)).toBe(0);
  });
});

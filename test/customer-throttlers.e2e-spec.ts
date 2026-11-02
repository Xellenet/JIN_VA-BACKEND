/**
 * Customer Experience v2, T-6 over real HTTP: every new named throttler
 * answers limit+1 with the agreed 429 (`Retry-After` header, `meta.error`,
 * `meta.retryAfterSeconds`, the shared message), keyed per user, with a
 * separate bucket per route. Limits are made small through the same
 * environment overrides production reads; nothing sleeps.
 *
 * Also checks that each be-settings route has its guards attached (T-6's
 * "guard-attached" half). Every person and value here is fictional.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { getRepositoryToken } from '@nestjs/typeorm';
import { WINSTON_MODULE_NEST_PROVIDER } from 'nest-winston';
import { DataSource, Repository } from 'typeorm';
import request from 'supertest';
import { App } from 'supertest/types';
import type { Logger as WinstonLogger } from 'winston';
import { AppModule } from '../src/app.module';
import { ResponseInterceptor } from '../src/common/interceptors/response.interceptor';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { TypeOrmFilter } from '../src/common/filters/typeorm-exception.filter';
import { User } from '@users/entities/user.entity';
import { UserTokenService } from '@users/token.service';
import { Role } from '@common/types/enums';
import {
  CustomerAnalyticsThrottlerGuard,
  CustomerExportThrottlerGuard,
  NotificationReadThrottlerGuard,
  PaymentSettingsWriteThrottlerGuard,
  ProfileMediaWriteThrottlerGuard,
} from '@common/throttling/customer-throttler.guards';
import { LocalStorageProvider } from '../src/uploads/providers/local-storage.provider';
import { UsersController } from '../src/users/users.controller';
import { UploadsController } from '../src/uploads/uploads.controller';
import { NotificationsController } from '../src/notifications/notifications.controller';
import { PaymentSettingsController } from '../src/payment-settings/payment-settings.controller';
import { removeTestData, testUserIds } from './helpers/test-data';

jest.setTimeout(120000);

/** The response envelope, typed loosely enough for assertions. */
interface Envelope {
  status: string;
  message: unknown;
  data: Record<string, unknown>;
  meta: Record<string, unknown>;
}
const body = (res: request.Response): Envelope => res.body as Envelope;

// Read by ThrottlingModule at boot. Small, so limit+1 is a few calls.
const LIMITS = {
  CUSTOMER_ANALYTICS_RATE_LIMIT_PER_MINUTE: 2,
  CUSTOMER_EXPORT_RATE_LIMIT_PER_10_MINUTES: 1,
  PAYMENT_SETTINGS_WRITE_RATE_LIMIT_PER_MINUTE: 2,
  PROFILE_MEDIA_WRITE_RATE_LIMIT_PER_HOUR: 2,
  NOTIFICATION_READ_RATE_LIMIT_PER_MINUTE: 3,
};
for (const [name, value] of Object.entries(LIMITS)) {
  process.env[name] = String(value);
}

const PREFIX = 'cx2rl-';
const VALID_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

describe('Customer Experience v2 named throttlers (T-6)', () => {
  let app: INestApplication<App>;
  let moduleFixture: TestingModule;
  let dataSource: DataSource;
  let uploadSpy: jest.SpyInstance;
  let users: Repository<User>;
  let tokens: UserTokenService;
  const uniq = Date.now();
  let seq = 0;
  const server = () => app.getHttpServer();

  /** A fresh customer for each check, so no bucket is shared by accident. */
  async function freshCustomer(): Promise<string> {
    seq += 1;
    const u = await users.save(
      users.create({
        email: `${PREFIX}${seq}-${uniq}@test.jinva.local`,
        firstname: 'Kojo',
        lastname: 'Ansah',
        role: Role.CUSTOMER,
        accountVerified: true,
      }),
    );
    return (await tokens.createJWTTokens(u)).access_token;
  }

  /** Calls `fire` up to limit+1 times and returns the first 429. */
  async function exceed(
    limit: number,
    fire: () => request.Test,
    okStatuses: number[],
  ): Promise<request.Response> {
    for (let i = 0; i < limit; i++) {
      const res = await fire();
      expect(okStatuses).toContain(res.status);
    }
    const limited = await fire();
    expect(limited.status).toBe(429);
    return limited;
  }

  function expect429(res: request.Response, code: string) {
    expect(res.headers['retry-after']).toMatch(/^\d+$/);
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    expect(res.body).toMatchObject({
      status: 'error',
      message: 'Too many requests, please wait a moment.',
      meta: { statusCode: 429, error: code },
    });
    expect(body(res).meta.retryAfterSeconds).toBe(
      Number(res.headers['retry-after']),
    );
  }

  beforeAll(async () => {
    moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
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
    tokens = moduleFixture.get(UserTokenService);
    uploadSpy = jest
      .spyOn(moduleFixture.get(LocalStorageProvider), 'upload')
      .mockImplementation((_b, options) =>
        Promise.resolve({
          url: `/uploads/${options.folder}/cx2rl-${uniq}.png`,
          filename: `cx2rl-${uniq}.png`,
          folder: options.folder,
          sizeBytes: 1,
        }),
      );
  });

  afterAll(async () => {
    uploadSpy.mockRestore();
    await removeTestData(dataSource, {
      userIds: await testUserIds(dataSource, PREFIX),
    });
    await app.close();
  });

  it('payment-settings-write: PATCH /users/me/payment-settings', async () => {
    const t = await freshCustomer();
    let flip = false;
    const res = await exceed(
      LIMITS.PAYMENT_SETTINGS_WRITE_RATE_LIMIT_PER_MINUTE,
      () => {
        flip = !flip;
        return request(server())
          .patch('/api/v1/users/me/payment-settings')
          .set('Authorization', `Bearer ${t}`)
          .send({ preferredChannel: flip ? 'card' : 'mobile_money' });
      },
      [200],
    );
    expect429(res, 'PAYMENT_SETTINGS_RATE_LIMIT_EXCEEDED');

    // Keyed per user: another customer is unaffected.
    const other = await freshCustomer();
    const ok = await request(server())
      .patch('/api/v1/users/me/payment-settings')
      .set('Authorization', `Bearer ${other}`)
      .send({ preferredChannel: 'card' });
    expect(ok.status).toBe(200);
  });

  it('profile-media-write: DELETE /users/me/avatar, POST /users/me/avatar and POST /uploads/avatar each have their own bucket', async () => {
    const t = await freshCustomer();
    const auth = { Authorization: `Bearer ${t}` };
    const limit = LIMITS.PROFILE_MEDIA_WRITE_RATE_LIMIT_PER_HOUR;

    const del = await exceed(
      limit,
      () => request(server()).delete('/api/v1/users/me/avatar').set(auth),
      [200],
    );
    expect429(del, 'PROFILE_MEDIA_RATE_LIMIT_EXCEEDED');

    const meUpload = await exceed(
      limit,
      () =>
        request(server())
          .post('/api/v1/users/me/avatar')
          .set(auth)
          .attach('avatar', VALID_PNG, {
            filename: 'a.png',
            contentType: 'image/png',
          }),
      [201],
    );
    expect429(meUpload, 'PROFILE_MEDIA_RATE_LIMIT_EXCEEDED');

    const plainUpload = await exceed(
      limit,
      () =>
        request(server())
          .post('/api/v1/uploads/avatar')
          .set(auth)
          .attach('file', VALID_PNG, {
            filename: 'a.png',
            contentType: 'image/png',
          }),
      [200],
    );
    expect429(plainUpload, 'PROFILE_MEDIA_RATE_LIMIT_EXCEEDED');
  });

  it('notification-read: GET /notifications/:id, while the list stays unthrottled', async () => {
    const t = await freshCustomer();
    const auth = { Authorization: `Bearer ${t}` };
    const res = await exceed(
      LIMITS.NOTIFICATION_READ_RATE_LIMIT_PER_MINUTE,
      () => request(server()).get('/api/v1/notifications/2147480001').set(auth),
      [404],
    );
    expect429(res, 'NOTIFICATION_READ_RATE_LIMIT_EXCEEDED');

    for (let i = 0; i < 5; i++) {
      const list = await request(server())
        .get('/api/v1/notifications?page=1&limit=5')
        .set(auth);
      expect(list.status).toBe(200);
    }
  });

  it('customer-analytics: GET /jobs/mine/summary and GET /customers/me/overview have separate buckets', async () => {
    const t = await freshCustomer();
    const auth = { Authorization: `Bearer ${t}` };
    const limit = LIMITS.CUSTOMER_ANALYTICS_RATE_LIMIT_PER_MINUTE;
    const summary = await exceed(
      limit,
      () => request(server()).get('/api/v1/jobs/mine/summary').set(auth),
      [200],
    );
    expect429(summary, 'CUSTOMER_ANALYTICS_RATE_LIMIT_EXCEEDED');

    const overview = await exceed(
      limit,
      () => request(server()).get('/api/v1/customers/me/overview').set(auth),
      [200],
    );
    expect429(overview, 'CUSTOMER_ANALYTICS_RATE_LIMIT_EXCEEDED');
  });

  it('customer-export: GET /payments/history/export.csv', async () => {
    const t = await freshCustomer();
    const res = await exceed(
      LIMITS.CUSTOMER_EXPORT_RATE_LIMIT_PER_10_MINUTES,
      () =>
        request(server())
          .get('/api/v1/payments/history/export.csv')
          .set('Authorization', `Bearer ${t}`),
      [200],
    );
    expect429(res, 'CUSTOMER_EXPORT_RATE_LIMIT_EXCEEDED');
  });

  it('a throttled route still answers 401 to an anonymous caller (auth runs first)', async () => {
    const res = await request(server()).delete('/api/v1/users/me/avatar');
    expect(res.status).toBe(401);
  });

  describe('guards attached to every be-settings route', () => {
    const guardsOf = (target: object, method: string) => [
      ...((Reflect.getMetadata(GUARDS_METADATA, target.constructor) as
        | unknown[]
        | undefined) ?? []),
      ...((Reflect.getMetadata(
        GUARDS_METADATA,
        (target as Record<string, unknown>)[method] as object,
      ) as unknown[] | undefined) ?? []),
    ];

    it.each([
      [
        PaymentSettingsController.prototype,
        'updateSettings',
        PaymentSettingsWriteThrottlerGuard,
      ],
      [
        UsersController.prototype,
        'removeAvatar',
        ProfileMediaWriteThrottlerGuard,
      ],
      [
        UsersController.prototype,
        'uploadAvatar',
        ProfileMediaWriteThrottlerGuard,
      ],
      [
        UploadsController.prototype,
        'uploadAvatar',
        ProfileMediaWriteThrottlerGuard,
      ],
      [
        NotificationsController.prototype,
        'findOne',
        NotificationReadThrottlerGuard,
      ],
    ])('%p.%s carries its named throttler', (proto, method, guard) => {
      expect(guardsOf(proto, method)).toContain(guard);
    });

    it('the analytics and export guards exist for be-insights to attach', () => {
      expect(CustomerAnalyticsThrottlerGuard).toBeDefined();
      expect(CustomerExportThrottlerGuard).toBeDefined();
    });
  });
});

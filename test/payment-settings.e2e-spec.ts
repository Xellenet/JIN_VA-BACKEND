/**
 * Customer Experience v2, B5 and B5c over real HTTP and the in-memory
 * database: `GET/PATCH /users/me/payment-settings` and the checkout channel
 * order on `POST /payments/initialize`.
 *
 * Covers E-5.1 to E-5.10 and E-5.12 (the [Q6] number cases are not built),
 * PR-1, T-8 (minus the number), O-1 (log capture) and the "event in the same
 * transaction" rule. Paystack is mocked; nothing leaves the process. Every
 * person and value here is fictional.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
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
import { ArtisanProfile } from '@users/entities/artisan-profile.entity';
import { UserTokenService } from '@users/token.service';
import { ServiceEntity } from '@services/entities/service.entity';
import { Role } from '@common/types/enums';
import { PaystackService } from '../src/payments/paystack.service';
import { AccountSecurityService } from '../src/account-security/account-security.service';
import { PAYSTACK_CHECKOUT_CHANNELS } from '../src/payment-settings/checkout-channels';
import { expectNoForbiddenFields } from './support/forbidden-fields';
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

// Small, so E-5.7 needs only a few calls. Read by ThrottlingModule at boot.
process.env.PAYMENT_SETTINGS_WRITE_RATE_LIMIT_PER_MINUTE = '50';

const PREFIX = 'cx2ps-';
const PHONE = '+233241110001';

describe('Payment settings (B5, B5c)', () => {
  let app: INestApplication<App>;
  let moduleFixture: TestingModule;
  let dataSource: DataSource;
  let users: Repository<User>;
  let serviceId = 0;
  const uniq = Date.now();
  const token: Record<string, string> = {};
  const ids: Record<string, number> = {};
  const emails: Record<string, string> = {};
  const server = () => app.getHttpServer();
  const as = (who: string) => ({ Authorization: `Bearer ${token[who]}` });

  const get = (who?: string) => {
    const req = request(server()).get('/api/v1/users/me/payment-settings');
    return who ? req.set(as(who)) : req;
  };
  const patch = (who: string | undefined, body: object) => {
    const req = request(server()).patch('/api/v1/users/me/payment-settings');
    return (who ? req.set(as(who)) : req).send(body);
  };
  const settingsRows = (userId: number) =>
    dataSource.query<
      Array<{ preferred_channel: string | null; momo_network: string | null }>
    >(
      'SELECT preferred_channel, momo_network FROM customer_payment_settings WHERE user_id = $1',
      [userId],
    );
  const events = (userId: number) =>
    dataSource.query<
      Array<{ event: string; fields_changed: string[]; details: unknown }>
    >(
      'SELECT event, fields_changed, details FROM account_security_events WHERE user_id = $1 ORDER BY id',
      [userId],
    );

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

    const profiles: Repository<ArtisanProfile> = moduleFixture.get(
      getRepositoryToken(ArtisanProfile),
    );
    const tokens = moduleFixture.get(UserTokenService);
    const make = async (
      label: string,
      role: Role,
      extra: Partial<User> = {},
    ) => {
      emails[label] = `${PREFIX}${label}-${uniq}@test.jinva.local`;
      const u = await users.save(
        users.create({
          email: emails[label],
          username: `cx2ps${label}${uniq}`,
          firstname: 'Ama',
          lastname: 'Mensah',
          role,
          accountVerified: true,
          ...extra,
        }),
      );
      ids[label] = u.id;
      if (role === Role.ARTISAN) {
        await profiles.save(profiles.create({ user: u, hourlyRate: 80 }));
      }
      token[label] = (await tokens.createJWTTokens(u)).access_token;
    };
    await make('a', Role.CUSTOMER, { phoneNumber: PHONE });
    await make('b', Role.CUSTOMER);
    await make('c', Role.CUSTOMER);
    await make('s', Role.CUSTOMER, { isSuspended: true });
    await make('k', Role.ARTISAN);
    await make('admin', Role.ADMIN);

    const services: Repository<ServiceEntity> = moduleFixture.get(
      getRepositoryToken(ServiceEntity),
    );
    serviceId = (
      await services.save(
        services.create({
          name: `Payment Settings ${uniq}`,
          estimatedDurationMins: 60,
        }),
      )
    ).id;
  });

  afterAll(async () => {
    await removeTestData(dataSource, {
      userIds: await testUserIds(dataSource, PREFIX),
      serviceIds: serviceId ? [serviceId] : [],
    });
    await app.close();
  });

  it('PR-1: the table has no mobile money number column', async () => {
    const columns = await dataSource.query<Array<{ column_name: string }>>(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'customer_payment_settings' ORDER BY column_name",
    );
    expect(columns.map((c) => c.column_name)).toEqual([
      'created_at',
      'id',
      'momo_network',
      'preferred_channel',
      'updated_at',
      'user_id',
    ]);
  });

  it('E-5.1: GET with no row returns defaults, no-store, and creates nothing', async () => {
    const res = await get('a');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.body).toMatchObject({
      status: 'success',
      message: 'Payment settings retrieved',
      data: {
        preferredChannel: null,
        momoNetwork: null,
        receiptEmail: emails.a,
        updatedAt: null,
        editable: true,
      },
    });
    expect(Object.keys(body(res).data as object).sort()).toEqual([
      'editable',
      'momoNetwork',
      'preferredChannel',
      'receiptEmail',
      'updatedAt',
    ]);
    expect(await settingsRows(ids.a)).toHaveLength(0);
  });

  it('E-5.2: PATCH saves, GET reads it back, and one event with field names only is written', async () => {
    const res = await patch('a', {
      preferredChannel: 'mobile_money',
      momoNetwork: 'MTN',
    });
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(body(res).message).toBe('Payment preferences saved');
    expect(body(res).data).toMatchObject({
      preferredChannel: 'mobile_money',
      momoNetwork: 'MTN',
      receiptEmail: emails.a,
      editable: true,
    });
    expect(typeof body(res).data.updatedAt).toBe('string');

    const read = await get('a');
    expect(body(read).data).toMatchObject({
      preferredChannel: 'mobile_money',
      momoNetwork: 'MTN',
    });
    expect(await settingsRows(ids.a)).toEqual([
      { preferred_channel: 'mobile_money', momo_network: 'MTN' },
    ]);

    const written = await events(ids.a);
    expect(written).toEqual([
      {
        event: 'payment_settings.updated',
        fields_changed: ['preferredChannel', 'momoNetwork'],
        details: null,
      },
    ]);
  });

  it('an empty body or the same values again is a no-op with no event', async () => {
    const before = (await events(ids.a)).length;
    expect((await patch('a', {})).status).toBe(200);
    const same = await patch('a', {
      preferredChannel: 'mobile_money',
      momoNetwork: 'MTN',
    });
    expect(same.status).toBe(200);
    expect(body(same).data.preferredChannel).toBe('mobile_money');
    expect((await events(ids.a)).length).toBe(before);
  });

  it('null clears one field and records only that field', async () => {
    const res = await patch('a', { momoNetwork: null });
    expect(res.status).toBe(200);
    expect(body(res).data).toMatchObject({
      preferredChannel: 'mobile_money',
      momoNetwork: null,
    });
    const last = (await events(ids.a)).at(-1);
    expect(last?.fields_changed).toEqual(['momoNetwork']);
    // Restore for the checkout tests below.
    await patch('a', { momoNetwork: 'MTN' });
  });

  it.each([
    [
      'E-5.3 another user id',
      () => ({ preferredChannel: 'card', userId: ids.b }),
    ],
    ['a customerId', () => ({ customerId: ids.b })],
    ['PR-1 a mobile money number', () => ({ momoNumber: '+233201234567' })],
    ['a channels list', () => ({ channels: ['card'] })],
    ['an unknown channel', () => ({ preferredChannel: 'bank_transfer' })],
    ['an unknown network', () => ({ momoNetwork: 'VODAFONE' })],
  ])('400 for %s, and nothing changes', async (_label, makeBody) => {
    const beforeA = await settingsRows(ids.a);
    const res = await patch('a', makeBody());
    expect(res.status).toBe(400);
    expect(body(res).status).toBe('error');
    expect(await settingsRows(ids.a)).toEqual(beforeA);
    expect(await settingsRows(ids.b)).toHaveLength(0);
  });

  it('E-5.4: each customer only reads and writes their own row', async () => {
    expect(
      (await patch('b', { preferredChannel: 'card', momoNetwork: 'AT' }))
        .status,
    ).toBe(200);
    const a = await get('a');
    expect(body(a).data).toMatchObject({
      preferredChannel: 'mobile_money',
      receiptEmail: emails.a,
    });
    const b = await get('b');
    expect(body(b).data).toMatchObject({
      preferredChannel: 'card',
      momoNetwork: 'AT',
      receiptEmail: emails.b,
    });
    expect(await settingsRows(ids.a)).toEqual([
      { preferred_channel: 'mobile_money', momo_network: 'MTN' },
    ]);
  });

  it('E-5.5: artisan and admin get 403, no token gets 401', async () => {
    expect((await get('k')).status).toBe(403);
    expect((await patch('k', { preferredChannel: 'card' })).status).toBe(403);
    expect((await get('admin')).status).toBe(403);
    expect((await patch('admin', { preferredChannel: 'card' })).status).toBe(
      403,
    );
    expect((await get()).status).toBe(401);
    expect((await patch(undefined, { preferredChannel: 'card' })).status).toBe(
      401,
    );
  });

  it('E-5.6: a suspended customer can read (editable false) but not write', async () => {
    const read = await get('s');
    expect(read.status).toBe(200);
    expect(body(read).data.editable).toBe(false);

    const write = await patch('s', { preferredChannel: 'card' });
    expect(write.status).toBe(403);
    expect(String(body(write).message)).toMatch(/suspended/i);
    expect(await settingsRows(ids.s)).toHaveLength(0);
  });

  it('E-5.12 / T-8: responses carry no number, authorization data or other forbidden keys', async () => {
    const read = await get('a');
    const write = await patch('a', { preferredChannel: 'mobile_money' });
    for (const body of [read.body, write.body]) {
      expectNoForbiddenFields(body, { forbiddenValues: [PHONE] });
    }
  });

  it('the event is written in the same transaction: a failed event write leaves no saved change', async () => {
    const security = app.get(AccountSecurityService);
    const spy = jest
      .spyOn(security, 'record')
      .mockRejectedValueOnce(new Error('event insert failed'));
    try {
      const res = await patch('c', { preferredChannel: 'card' });
      expect(res.status).toBe(500);
      expect(await settingsRows(ids.c)).toHaveLength(0);
      expect(await events(ids.c)).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
    // And with the event write working again, the save goes through.
    expect((await patch('c', { preferredChannel: 'card' })).status).toBe(200);
    expect(await settingsRows(ids.c)).toHaveLength(1);
  });

  it('the CHECK constraints refuse a value the API would never send', async () => {
    await expect(
      dataSource.query(
        "UPDATE customer_payment_settings SET preferred_channel = 'bank' WHERE user_id = $1",
        [ids.c],
      ),
    ).rejects.toThrow();
    await expect(
      dataSource.query(
        "INSERT INTO account_security_events (user_id, event) VALUES ($1, 'something.else')",
        [ids.c],
      ),
    ).rejects.toThrow();
  });

  describe('B5c checkout channel order', () => {
    let initialize: jest.SpyInstance;

    beforeEach(() => {
      initialize = jest
        .spyOn(PaystackService.prototype, 'initializeTransaction')
        .mockImplementation((params: { reference: string }) =>
          Promise.resolve({
            authorization_url: `https://checkout.paystack.test/${params.reference}`,
            access_code: 'ac_test',
            reference: params.reference,
          }),
        );
    });
    afterEach(() => initialize.mockRestore());

    /** Posts a job as `who`, has the artisan apply, and accepts it. */
    async function acceptedJob(who: string, title: string): Promise<number> {
      const job = await request(server())
        .post('/api/v1/jobs')
        .set(as(who))
        .send({
          title,
          description: 'Kitchen tap drips all night and needs a new washer',
          serviceId,
          location: 'Osu, Greater Accra',
          budgetMin: 100,
          budgetMax: 200,
          currency: 'GHS',
        });
      expect(job.status).toBe(201);
      const jobId = (job.body as { data: { id: number } }).data.id;
      expect(
        (
          await request(server())
            .post(`/api/v1/jobs/${jobId}/apply`)
            .set(as('k'))
            .send({ quotePrice: 150 })
        ).status,
      ).toBe(201);
      const list = await request(server())
        .get(`/api/v1/jobs/${jobId}/applications`)
        .set(as(who));
      const appId = (list.body as { data: Array<{ id: number }> }).data[0].id;
      expect(
        (
          await request(server())
            .post(`/api/v1/jobs/${jobId}/applications/${appId}/accept`)
            .set(as(who))
        ).status,
      ).toBe(201);
      return jobId;
    }

    const init = (who: string, jobId: number) =>
      request(server())
        .post('/api/v1/payments/initialize')
        .set(as(who))
        .send({ jobId });

    it('E-5.8: a mobile money preference puts mobile_money first and keeps every channel', async () => {
      const jobId = await acceptedJob('a', `Channel order ${uniq}`);
      const res = await init('a', jobId);
      expect(res.status).toBe(201);
      const params = (initialize.mock.calls as unknown[][])[0][0] as {
        channels?: string[];
      };
      expect(params.channels?.[0]).toBe('mobile_money');
      expect([...(params.channels ?? [])].sort()).toEqual(
        [...PAYSTACK_CHECKOUT_CHANNELS].sort(),
      );
      // The response shape is unchanged; nothing about channels is returned.
      expect(Object.keys(body(res).data as object).sort()).toEqual([
        'accessCode',
        'amount',
        'authorizationUrl',
        'currency',
        'reference',
      ]);
    });

    it('E-5.9: with no preference, the Paystack call has no channels key, exactly as before', async () => {
      const jobId = await acceptedJob('b', `No preference ${uniq}`);
      // b prefers card; clear it so b has a row but no preference.
      await patch('b', { preferredChannel: null });
      const res = await init('b', jobId);
      expect(res.status).toBe(201);
      const params = (initialize.mock.calls as unknown[][])[0][0] as Record<
        string,
        unknown
      >;
      expect(Object.keys(params).sort()).toEqual([
        'amountGhs',
        'callbackUrl',
        'email',
        'metadata',
        'reference',
      ]);
    });

    it('E-5.10: if the settings cannot be read, checkout still initialises as today', async () => {
      const jobId = await acceptedJob('c', `Settings down ${uniq}`);
      const original = dataSource.getRepository.bind(dataSource) as (
        target: unknown,
      ) => unknown;
      const spy = jest.spyOn(dataSource, 'getRepository').mockImplementation(((
        target: unknown,
      ) => {
        if (
          typeof target === 'function' &&
          (target as { name?: string }).name === 'CustomerPaymentSettings'
        ) {
          throw new Error('settings table unavailable');
        }
        return original(target);
      }) as typeof dataSource.getRepository);
      try {
        const res = await init('c', jobId);
        expect(res.status).toBe(201);
        const params = (initialize.mock.calls as unknown[][])[0][0] as Record<
          string,
          unknown
        >;
        expect(params).not.toHaveProperty('channels');
      } finally {
        spy.mockRestore();
      }
    });
  });

  it('E-5.7: PATCH answers limit+1 with 429 and its code; GET is unaffected', async () => {
    // Fresh customer, so earlier tests' writes do not count.
    const tokens = moduleFixture.get(UserTokenService);
    const u = await users.save(
      users.create({
        email: `${PREFIX}rl-${uniq}@test.jinva.local`,
        firstname: 'Kwesi',
        lastname: 'Boateng',
        role: Role.CUSTOMER,
        accountVerified: true,
      }),
    );
    token.rl = (await tokens.createJWTTokens(u)).access_token;

    let limited: request.Response | null = null;
    for (let i = 0; i < 60; i++) {
      const res = await patch('rl', {
        preferredChannel: i % 2 ? 'card' : 'mobile_money',
      });
      if (res.status === 429) {
        limited = res;
        break;
      }
      expect(res.status).toBe(200);
    }
    expect(limited).not.toBeNull();
    expect(limited!.headers['retry-after']).toMatch(/^\d+$/);
    expect(limited!.body).toMatchObject({
      status: 'error',
      message: 'Too many requests, please wait a moment.',
      meta: { statusCode: 429, error: 'PAYMENT_SETTINGS_RATE_LIMIT_EXCEEDED' },
    });
    expect(body(limited!).meta.retryAfterSeconds).toBeGreaterThan(0);
    expect((await get('rl')).status).toBe(200);
  });

  it('O-1: log lines from these endpoints carry no email, phone or authorization values', async () => {
    const captured: string[] = [];
    const capture =
      (original: (...args: unknown[]) => unknown) =>
      (...args: unknown[]) => {
        captured.push(args.map((a) => String(a)).join(' '));
        return original(...args);
      };
    const stdout = jest
      .spyOn(process.stdout, 'write')
      .mockImplementation(capture(() => true) as never);
    const stderr = jest
      .spyOn(process.stderr, 'write')
      .mockImplementation(capture(() => true) as never);
    const consoleSpies = (['log', 'info', 'warn', 'error'] as const).map(
      (level) =>
        jest
          .spyOn(console, level)
          .mockImplementation(capture(() => undefined) as never),
    );
    try {
      await get('a');
      await patch('a', { preferredChannel: 'card' });
      await patch('a', { momoNumber: PHONE });
      await patch('a', { preferredChannel: 'bitcoin' });
      await get('k');
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
      consoleSpies.forEach((s) => s.mockRestore());
    }
    const text = captured.join('\n');
    expect(text).not.toContain(emails.a);
    expect(text).not.toContain(PHONE);
    expect(text).not.toContain(token.a);
    expect(text).not.toMatch(/Bearer\s+ey/);
  });
});

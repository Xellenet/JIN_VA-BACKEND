/**
 * Saved payment methods for customers, over real HTTP and the in-memory
 * database: saving a mobile money number with its looked-up name, the masked
 * list, ownership, PIN refusal, saving a card only with the customer's
 * opt-in, paying a job with a saved method (mobile money, Telecel OTP, card
 * fallback to the hosted checkout), the webhook → HELD path, failures and the
 * account purge.
 *
 * Paystack is mocked on the prototype (every call below is a jest spy); the
 * webhook is signed with the test-only secret. Every person, number and card
 * here is fictional.
 */
import { createHmac } from 'crypto';
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
import { AccountPurgeService } from '@users/account-purge.service';
import { ServiceEntity } from '@services/entities/service.entity';
import { Role } from '@common/types/enums';
import { PaystackService } from '../src/payments/paystack.service';
import { expectNoForbiddenFields } from './support/forbidden-fields';
import { removeTestData, testUserIds } from './helpers/test-data';

jest.setTimeout(180000);

interface Envelope {
  status: string;
  message: unknown;
  data: Record<string, unknown>;
  meta: Record<string, unknown>;
}
const body = (res: request.Response): Envelope => res.body as Envelope;

// Generous limits so the suite's own calls never hit them.
process.env.PAYMENT_METHOD_LOOKUP_RATE_LIMIT_PER_10_MINUTES = '200';
process.env.PAYMENT_METHODS_WRITE_RATE_LIMIT_PER_10_MINUTES = '200';
process.env.PAYMENT_CHARGE_RATE_LIMIT_PER_10_MINUTES = '200';

const PREFIX = 'spm-';
const MOMO = '0240000000';
const TELECEL = '0200000000';
const NAME = 'KOFI ASANTE';
const SECRET = 'sk_test_e2e_not_a_real_key';

describe('Saved payment methods (customers)', () => {
  let app: INestApplication<App>;
  let moduleFixture: TestingModule;
  let dataSource: DataSource;
  let serviceId = 0;
  const uniq = Date.now();
  const token: Record<string, string> = {};
  const ids: Record<string, number> = {};
  const server = () => app.getHttpServer();
  const as = (who: string) => ({ Authorization: `Bearer ${token[who]}` });
  const spies: jest.SpyInstance[] = [];
  const spy = <K extends keyof PaystackService>(name: K) => {
    const s = jest.spyOn(PaystackService.prototype, name as never);
    spies.push(s);
    return s as unknown as jest.Mock;
  };
  let resolveAccount: jest.Mock;
  let chargeMobileMoney: jest.Mock;
  let chargeAuthorization: jest.Mock;
  let submitChargeOtp: jest.Mock;
  let verifyTransaction: jest.Mock;

  const methodsUrl = '/api/v1/users/me/payment-methods';
  const list = (who: string) => request(server()).get(methodsUrl).set(as(who));
  const addMomo = (who: string, b: object) =>
    request(server()).post(`${methodsUrl}/mobile-money`).set(as(who)).send(b);
  const rows = (userId: number) =>
    dataSource.query<Array<Record<string, unknown>>>(
      'SELECT * FROM customer_payment_methods WHERE user_id = $1 ORDER BY id',
      [userId],
    );
  const paymentOf = async (jobId: number) =>
    (
      await dataSource.query<
        Array<{ id: number; status: string; save_card_requested: boolean }>
      >(
        'SELECT id, status, save_card_requested FROM payments WHERE job_id = $1',
        [jobId],
      )
    )[0];

  /** Signs and posts a webhook exactly as Paystack would. */
  const webhook = (event: string, data: Record<string, unknown>) => {
    const raw = JSON.stringify({ event, data });
    return request(server())
      .post('/api/v1/payments/webhook')
      .set('Content-Type', 'application/json')
      .set(
        'x-paystack-signature',
        createHmac('sha512', SECRET).update(raw).digest('hex'),
      )
      .send(raw);
  };

  beforeAll(async () => {
    moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication({ rawBody: true });
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
    const profiles: Repository<ArtisanProfile> = moduleFixture.get(
      getRepositoryToken(ArtisanProfile),
    );
    const tokens = moduleFixture.get(UserTokenService);
    const make = async (label: string, role: Role) => {
      const u = await users.save(
        users.create({
          email: `${PREFIX}${label}-${uniq}@test.jinva.local`,
          username: `spm${label}${uniq}`,
          firstname: 'Kofi',
          lastname: 'Asante',
          role,
          accountVerified: true,
        }),
      );
      ids[label] = u.id;
      if (role === Role.ARTISAN) {
        await profiles.save(profiles.create({ user: u, hourlyRate: 80 }));
      }
      token[label] = (await tokens.createJWTTokens(u)).access_token;
    };
    for (const c of ['a', 'b', 'c', 'p']) await make(c, Role.CUSTOMER);
    await make('k', Role.ARTISAN);

    const services: Repository<ServiceEntity> = moduleFixture.get(
      getRepositoryToken(ServiceEntity),
    );
    serviceId = (
      await services.save(
        services.create({
          name: `Saved methods ${uniq}`,
          estimatedDurationMins: 60,
        }),
      )
    ).id;
  });

  beforeEach(() => {
    resolveAccount = spy('resolveAccount').mockResolvedValue({
      status: 'resolved',
      accountName: NAME,
    });
    spy('initializeTransaction').mockImplementation(
      (p: { reference: string }) =>
        Promise.resolve({
          authorization_url: `https://checkout.paystack.test/${p.reference}`,
          access_code: 'ac_test',
          reference: p.reference,
        }),
    );
    chargeMobileMoney = spy('chargeMobileMoney').mockResolvedValue({
      outcome: 'ok',
      data: { status: 'pay_offline', display_text: 'Approve on your phone' },
    });
    chargeAuthorization = spy('chargeAuthorization').mockResolvedValue({
      outcome: 'ok',
      data: { status: 'success' },
    });
    submitChargeOtp = spy('submitChargeOtp').mockResolvedValue({
      outcome: 'ok',
      data: { status: 'pay_offline' },
    });
    verifyTransaction = spy('verifyTransaction').mockRejectedValue(
      new Error('not called in this suite unless stubbed'),
    );
  });
  afterEach(() => {
    while (spies.length) spies.pop()!.mockRestore();
  });

  afterAll(async () => {
    await removeTestData(dataSource, {
      userIds: await testUserIds(dataSource, PREFIX),
      serviceIds: serviceId ? [serviceId] : [],
    });
    await app.close();
  });

  /** Posts a job as `who`, has the artisan quote 150 and accepts it. */
  async function acceptedJob(who: string, title: string): Promise<number> {
    const job = await request(server()).post('/api/v1/jobs').set(as(who)).send({
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
    const apps = await request(server())
      .get(`/api/v1/jobs/${jobId}/applications`)
      .set(as(who));
    const appId = (apps.body as { data: Array<{ id: number }> }).data[0].id;
    expect(
      (
        await request(server())
          .post(`/api/v1/jobs/${jobId}/applications/${appId}/accept`)
          .set(as(who))
      ).status,
    ).toBe(201);
    return jobId;
  }

  const charge = (who: string, jobId: number, paymentMethodId: number) =>
    request(server())
      .post(`/api/v1/payments/${jobId}/charge`)
      .set(as(who))
      .send({ paymentMethodId });
  const status = (who: string, ref: string) =>
    request(server())
      .get(`/api/v1/payments/charges/${encodeURIComponent(ref)}/status`)
      .set(as(who));

  // ─── Saving and listing ──────────────────────────────────────────────────────

  it('lists nothing at first, can save, and is never cached', async () => {
    const res = await list('a');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(body(res).data).toEqual({
      methods: [],
      maxMethods: 5,
      canSave: true,
    });
  });

  it('looks up the name on a number (POST, no-store)', async () => {
    const res = await request(server())
      .post(`${methodsUrl}/resolve`)
      .set(as('a'))
      .send({ network: 'MTN', accountNumber: '+233 24 000 0000' });
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(body(res).data).toEqual({ accountName: NAME });
    expect(resolveAccount).toHaveBeenCalledWith(MOMO, 'MTN');
  });

  it('saves a mobile money number with the resolved name; stored encrypted; list is masked', async () => {
    const res = await addMomo('a', { network: 'MTN', accountNumber: MOMO });
    expect(res.status).toBe(201);
    expect(body(res).data).toMatchObject({
      type: 'mobile_money',
      isDefault: true,
      mobileMoney: {
        network: 'MTN',
        numberMasked: '024 ••• 0000',
        accountName: NAME,
        nameVerified: true,
      },
      card: null,
    });

    const [row] = await rows(ids.a);
    expect(String(row.number_encrypted)).toMatch(/^v1:[0-9a-f]{8}:/);
    expect(JSON.stringify(row)).not.toContain(MOMO);

    const read = await list('a');
    expectNoForbiddenFields(read.body, { forbiddenValues: [MOMO] });
    expect(JSON.stringify(read.body)).not.toMatch(/encrypted|hash/i);

    const events = await dataSource.query<
      Array<{ event: string; details: unknown }>
    >('SELECT event, details FROM account_security_events WHERE user_id = $1', [
      ids.a,
    ]);
    expect(events).toEqual([
      {
        event: 'payment_method.added',
        details: { type: 'mobile_money', network: 'MTN' },
      },
    ]);
  });

  it('refuses the same number twice (409), an unknown wallet (422) and an unavailable lookup (503)', async () => {
    expect(
      (await addMomo('a', { network: 'MTN', accountNumber: MOMO })).status,
    ).toBe(409);
    resolveAccount.mockResolvedValueOnce({ status: 'unresolvable' });
    expect(
      (await addMomo('a', { network: 'MTN', accountNumber: '0540000000' }))
        .status,
    ).toBe(422);
    resolveAccount.mockResolvedValueOnce({ status: 'unavailable' });
    expect(
      (await addMomo('a', { network: 'MTN', accountNumber: '0540000000' }))
        .status,
    ).toBe(503);
    expect(await rows(ids.a)).toHaveLength(1);
  });

  it.each([
    ['a pin', { network: 'MTN', accountNumber: '0540000000', pin: '1234' }],
    [
      'a momoPin',
      { network: 'MTN', accountNumber: '0540000000', momoPin: '1' },
    ],
  ])(
    'refuses a body with %s (400 PIN_NOT_ACCEPTED), nothing saved',
    async (_l, b) => {
      const res = await addMomo('a', b);
      expect(res.status).toBe(400);
      expect(body(res).meta.error).toBe('PIN_NOT_ACCEPTED');
      expect(JSON.stringify(res.body)).not.toContain('1234');
      expect(resolveAccount).not.toHaveBeenCalled();
    },
  );

  it('validates the number: a landline or a short number is 400', async () => {
    for (const accountNumber of ['0300000000', '02400']) {
      expect(
        (await addMomo('a', { network: 'MTN', accountNumber })).status,
      ).toBe(400);
    }
    expect(
      (await addMomo('a', { network: 'TELECEL', accountNumber: TELECEL }))
        .status,
    ).toBe(400);
  });

  it('ownership: another customer gets 404; artisans 403; no token 401', async () => {
    const [row] = await rows(ids.a);
    const id = Number(row.id);
    expect(
      (
        await request(server())
          .patch(`${methodsUrl}/${id}/default`)
          .set(as('b'))
      ).status,
    ).toBe(404);
    expect(
      (await request(server()).delete(`${methodsUrl}/${id}`).set(as('b')))
        .status,
    ).toBe(404);
    expect((await list('k')).status).toBe(403);
    expect((await request(server()).get(methodsUrl)).status).toBe(401);
    expect(await rows(ids.a)).toHaveLength(1);
  });

  it('make default and remove (the newest remaining becomes default)', async () => {
    await addMomo('a', { network: 'VOD', accountNumber: TELECEL });
    const [first, second] = await rows(ids.a);
    let res = await request(server())
      .patch(`${methodsUrl}/${String(second.id)}/default`)
      .set(as('a'));
    expect(res.status).toBe(200);
    const methods = body(res).data.methods as Array<{
      id: number;
      isDefault: boolean;
    }>;
    expect(methods.filter((m) => m.isDefault).map((m) => m.id)).toEqual([
      Number(second.id),
    ]);

    res = await request(server())
      .delete(`${methodsUrl}/${String(second.id)}`)
      .set(as('a'));
    expect(res.status).toBe(200);
    expect(body(res).data.methods).toEqual([
      expect.objectContaining({ id: Number(first.id), isDefault: true }),
    ]);
    // Restore the Telecel number for the OTP test below.
    await addMomo('a', { network: 'VOD', accountNumber: TELECEL });
  });

  // ─── Cards: saved only with the opt-in ───────────────────────────────────────

  const authorization = (signature: string, over: object = {}) => ({
    authorization_code: `AUTH_${signature.replace(/[^A-Za-z0-9]/g, '')}`,
    card_type: 'visa ',
    last4: '4081',
    exp_month: '12',
    exp_year: '2030',
    bank: 'TEST BANK',
    channel: 'card',
    signature,
    reusable: true,
    ...over,
  });
  const paidByCard = (reference: string, signature: string, over = {}) => ({
    reference,
    amount: 15000,
    currency: 'GHS',
    channel: 'card',
    paid_at: new Date().toISOString(),
    metadata: { save_card: true },
    authorization: authorization(signature, over),
  });
  const referenceOf = async (jobId: number) =>
    (
      await dataSource.query<Array<{ reference: string }>>(
        'SELECT reference FROM payments WHERE job_id = $1',
        [jobId],
      )
    )[0].reference;

  it('saves the card from a hosted payment only when the customer ticked it, and only once', async () => {
    const cards = async () =>
      (await rows(ids.b)).filter((r) => r.type === 'card');

    // 1) Opted in + reusable → saved.
    const j1 = await acceptedJob('b', `Card opt-in ${uniq}`);
    const init = await request(server())
      .post('/api/v1/payments/initialize')
      .set(as('b'))
      .send({ jobId: j1, saveCard: true });
    expect(init.status).toBe(201);
    expect((await paymentOf(j1)).save_card_requested).toBe(true);
    expect(
      (
        await webhook(
          'charge.success',
          paidByCard(await referenceOf(j1), 'SIG_one'),
        )
      ).status,
    ).toBe(201);
    expect((await paymentOf(j1)).status).toBe('HELD');
    let saved = await cards();
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ card_brand: 'visa', card_last4: '4081' });
    expect(JSON.stringify(saved[0])).not.toContain('AUTH_SIGone');
    expect(JSON.stringify(saved[0])).not.toContain('"SIG_one"');

    // 2) Not opted in (webhook metadata says save_card, which is not trusted) → not saved.
    const j2 = await acceptedJob('b', `Card no opt-in ${uniq}`);
    await request(server())
      .post('/api/v1/payments/initialize')
      .set(as('b'))
      .send({ jobId: j2 });
    await webhook(
      'charge.success',
      paidByCard(await referenceOf(j2), 'SIG_two'),
    );
    expect(await cards()).toHaveLength(1);

    // 3) Opted in but not reusable → not saved.
    const j3 = await acceptedJob('b', `Card not reusable ${uniq}`);
    await request(server())
      .post('/api/v1/payments/initialize')
      .set(as('b'))
      .send({ jobId: j3, saveCard: true });
    await webhook(
      'charge.success',
      paidByCard(await referenceOf(j3), 'SIG_three', { reusable: false }),
    );
    expect(await cards()).toHaveLength(1);

    // 4) The same card again → not saved twice.
    const j4 = await acceptedJob('b', `Card again ${uniq}`);
    await request(server())
      .post('/api/v1/payments/initialize')
      .set(as('b'))
      .send({ jobId: j4, saveCard: true });
    await webhook(
      'charge.success',
      paidByCard(await referenceOf(j4), 'SIG_one'),
    );
    saved = await cards();
    expect(saved).toHaveLength(1);

    const read = await list('b');
    expect(body(read).data.methods).toEqual([
      expect.objectContaining({
        type: 'card',
        isDefault: true,
        card: expect.objectContaining({
          brand: 'visa',
          last4: '4081',
          expMonth: 12,
          expYear: 2030,
          expired: false,
        }) as unknown,
      }),
    ]);
    expect(JSON.stringify(read.body)).not.toContain('AUTH_');
  });

  // ─── Paying with a saved method ──────────────────────────────────────────────

  it('mobile money: pending → same reference on repeat → webhook → HELD → succeeded', async () => {
    const jobId = await acceptedJob('a', `Pay MoMo ${uniq}`);
    const method = (await rows(ids.a)).find((r) => r.network === 'MTN')!;
    const res = await charge('a', jobId, Number(method.id));
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('private, no-store');
    const data = body(res).data as { reference: string };
    expect(body(res).data).toMatchObject({
      jobId,
      method: 'mobile_money',
      status: 'pending',
      action: 'approve_on_phone',
    });
    expect(chargeMobileMoney).toHaveBeenCalledWith(
      expect.objectContaining({
        phone: MOMO,
        provider: 'mtn',
        amountGhs: 150,
        reference: data.reference,
      }),
    );
    expectNoForbiddenFields(res.body, { forbiddenValues: [MOMO] });

    const again = await charge('a', jobId, Number(method.id));
    expect((body(again).data as { reference: string }).reference).toBe(
      data.reference,
    );
    expect(chargeMobileMoney).toHaveBeenCalledTimes(1);

    expect((await paymentOf(jobId)).status).toBe('PENDING');
    await webhook('charge.success', {
      reference: data.reference,
      amount: 15000,
      currency: 'GHS',
      channel: 'mobile_money',
      paid_at: new Date().toISOString(),
    });
    expect((await paymentOf(jobId)).status).toBe('HELD');
    expect(body(await status('a', data.reference)).data).toMatchObject({
      status: 'succeeded',
      action: null,
    });
    // Someone else's reference is 404.
    expect((await status('b', data.reference)).status).toBe(404);
    // And paying again is 409.
    expect((await charge('a', jobId, Number(method.id))).status).toBe(409);
  });

  it('Telecel: send_otp → submit the code → webhook → succeeded', async () => {
    const jobId = await acceptedJob('a', `Pay Telecel ${uniq}`);
    const method = (await rows(ids.a)).find((r) => r.network === 'VOD')!;
    chargeMobileMoney.mockResolvedValueOnce({
      outcome: 'ok',
      data: { status: 'send_otp', display_text: 'Enter OTP' },
    });
    const res = await charge('a', jobId, Number(method.id));
    const { reference } = body(res).data as { reference: string };
    expect(body(res).data).toMatchObject({
      status: 'needs_otp',
      action: 'enter_otp',
    });
    expect(chargeMobileMoney).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'vod', phone: TELECEL }),
    );

    const pinTry = await request(server())
      .post(`/api/v1/payments/charges/${reference}/otp`)
      .set(as('a'))
      .send({ otp: '123456', pin: '0000' });
    expect(pinTry.status).toBe(400);
    expect(submitChargeOtp).not.toHaveBeenCalled();

    const otp = await request(server())
      .post(`/api/v1/payments/charges/${reference}/otp`)
      .set(as('a'))
      .send({ otp: '123456' });
    expect(otp.status).toBe(200);
    expect(body(otp).data).toMatchObject({ status: 'pending' });
    expect(submitChargeOtp).toHaveBeenCalledWith(reference, '123456');

    await webhook('charge.success', {
      reference,
      amount: 15000,
      currency: 'GHS',
      channel: 'mobile_money',
      paid_at: new Date().toISOString(),
    });
    expect(body(await status('a', reference)).data).toMatchObject({
      status: 'succeeded',
    });
    expect((await paymentOf(jobId)).status).toBe('HELD');
  });

  it('a declined charge fails with safe text; trying again starts a new attempt', async () => {
    const jobId = await acceptedJob('a', `Pay declined ${uniq}`);
    const method = (await rows(ids.a)).find((r) => r.network === 'MTN')!;
    chargeMobileMoney.mockResolvedValueOnce({
      outcome: 'ok',
      data: { status: 'failed', display_text: 'Insufficient funds' },
    });
    const first = await charge('a', jobId, Number(method.id));
    expect(body(first).data).toMatchObject({
      status: 'failed',
      message: 'Insufficient funds',
    });
    const second = await charge('a', jobId, Number(method.id));
    expect(body(second).data).toMatchObject({ status: 'pending' });
    expect((body(second).data as { reference: string }).reference).not.toBe(
      (body(first).data as { reference: string }).reference,
    );
    expect((await paymentOf(jobId)).status).toBe('PENDING');
  });

  it('a saved card that needs more authorisation falls back to the hosted checkout, which still works', async () => {
    const jobId = await acceptedJob('b', `Card fallback ${uniq}`);
    const card = (await rows(ids.b)).find((r) => r.type === 'card')!;
    chargeAuthorization.mockResolvedValueOnce({
      outcome: 'ok',
      data: { status: 'send_pin' },
    });
    const res = await charge('b', jobId, Number(card.id));
    expect(body(res).data).toMatchObject({
      method: 'card',
      status: 'failed',
      action: 'pay_another_way',
    });
    expect(chargeAuthorization).toHaveBeenCalledWith(
      expect.objectContaining({
        authorizationCode: 'AUTH_SIGone',
        amountGhs: 150,
      }),
    );
    const init = await request(server())
      .post('/api/v1/payments/initialize')
      .set(as('b'))
      .send({ jobId });
    expect(init.status).toBe(201);
    expect(body(init).data).toHaveProperty('authorizationUrl');
  });

  it('a pending charge is checked with Paystack on status after the interval', async () => {
    const jobId = await acceptedJob('c', `Verify path ${uniq}`);
    await addMomo('c', { network: 'ATL', accountNumber: '0270000000' });
    const [m] = await rows(ids.c);
    const res = await charge('c', jobId, Number(m.id));
    const { reference } = body(res).data as { reference: string };
    expect(chargeMobileMoney).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'atl' }),
    );
    await dataSource.query(
      "UPDATE payment_charges SET created_at = now() - interval '1 minute' WHERE reference = $1",
      [reference],
    );
    verifyTransaction.mockResolvedValueOnce({
      status: 'success',
      reference,
      amount: 15000,
      currency: 'GHS',
      paid_at: new Date().toISOString(),
      channel: 'mobile_money',
      customer: { email: 'x', id: 1 },
    });
    expect(body(await status('c', reference)).data).toMatchObject({
      status: 'succeeded',
    });
    expect((await paymentOf(jobId)).status).toBe('HELD');
  });

  it('refuses a PIN in the charge body and someone else’s method id', async () => {
    const jobId = await acceptedJob('c', `Pin refused ${uniq}`);
    const [m] = await rows(ids.c);
    const pin = await request(server())
      .post(`/api/v1/payments/${jobId}/charge`)
      .set(as('c'))
      .send({ paymentMethodId: Number(m.id), pin: '1234' });
    expect(pin.status).toBe(400);
    const [other] = await rows(ids.a);
    expect((await charge('c', jobId, Number(other.id))).status).toBe(404);
    expect(chargeMobileMoney).not.toHaveBeenCalled();
  });

  // ─── Purge ───────────────────────────────────────────────────────────────────

  it('the account purge removes every saved method of that customer only', async () => {
    await addMomo('p', { network: 'MTN', accountNumber: '0550000000' });
    expect(await rows(ids.p)).toHaveLength(1);
    const beforeA = (await rows(ids.a)).length;
    await dataSource.query(
      "UPDATE users SET deleted_at = now() - interval '45 days' WHERE id = $1",
      [ids.p],
    );
    const original = process.env.ACCOUNT_PURGE_MODE;
    process.env.ACCOUNT_PURGE_MODE = 'destructive';
    try {
      expect(
        await moduleFixture.get(AccountPurgeService).purgeAccount(ids.p),
      ).toBe('purged');
    } finally {
      if (original === undefined) delete process.env.ACCOUNT_PURGE_MODE;
      else process.env.ACCOUNT_PURGE_MODE = original;
    }
    expect(await rows(ids.p)).toHaveLength(0);
    expect(await rows(ids.a)).toHaveLength(beforeA);
  });
});

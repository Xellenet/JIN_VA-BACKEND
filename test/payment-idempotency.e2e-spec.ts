/**
 * Idempotent job payments, over real HTTP and the in-memory database:
 * Idempotency-Key replay and refusals, one active attempt per job (hosted
 * vs saved method), expiry only after Paystack says no, paid is final, the
 * hosted and saved-method webhooks taking the same lock (a second success is
 * refunded automatically, a redelivery is processed once), refund webhooks
 * and retries, and saved methods kept through the 30-day recovery window
 * after an account deletion request. Concurrency is real: two requests in flight at once
 * (Promise.all) against PGlite.
 *
 * Paystack is mocked on the prototype; webhooks are signed with the
 * test-only secret. Every person, number and reference here is fictional.
 */
import { createHmac, randomUUID } from 'crypto';
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
import { DuplicateRefundService } from '../src/payments/duplicate-refund.service';
import { removeTestData, testUserIds } from './helpers/test-data';

jest.setTimeout(180000);

interface Envelope {
  status: string;
  message: unknown;
  data: Record<string, unknown>;
  meta: Record<string, unknown>;
}
const body = (res: request.Response): Envelope => res.body as Envelope;

process.env.PAYMENT_METHOD_LOOKUP_RATE_LIMIT_PER_10_MINUTES = '200';
process.env.PAYMENT_METHODS_WRITE_RATE_LIMIT_PER_10_MINUTES = '200';
process.env.PAYMENT_CHARGE_RATE_LIMIT_PER_10_MINUTES = '200';

const PREFIX = 'pid-';
const MOMO = '0240000001';
const SECRET = 'sk_test_e2e_not_a_real_key';

describe('Idempotent job payments', () => {
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
  let initializeTransaction: jest.Mock;
  let chargeMobileMoney: jest.Mock;
  let verifyTransaction: jest.Mock;
  let refund: jest.Mock;

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
  const paid = (reference: string, channel = 'mobile_money') => ({
    reference,
    amount: 15000,
    currency: 'GHS',
    channel,
    paid_at: new Date().toISOString(),
  });

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
          username: `pid${label}${uniq}`,
          firstname: 'Efua',
          lastname: 'Boateng',
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
    for (const c of ['a', 'd']) await make(c, Role.CUSTOMER);
    await make('k', Role.ARTISAN);

    const services: Repository<ServiceEntity> = moduleFixture.get(
      getRepositoryToken(ServiceEntity),
    );
    serviceId = (
      await services.save(
        services.create({
          name: `Idempotency ${uniq}`,
          estimatedDurationMins: 60,
        }),
      )
    ).id;
  });

  beforeEach(() => {
    spy('resolveAccount').mockResolvedValue({
      status: 'resolved',
      accountName: 'EFUA BOATENG',
    });
    initializeTransaction = spy('initializeTransaction').mockImplementation(
      (p: { reference: string }) =>
        Promise.resolve({
          authorization_url: `https://checkout.paystack.test/${p.reference}`,
          access_code: `ac_${p.reference}`,
          reference: p.reference,
        }),
    );
    chargeMobileMoney = spy('chargeMobileMoney').mockImplementation(
      () =>
        new Promise((resolve) =>
          // A little latency, so two requests really overlap.
          setTimeout(
            () =>
              resolve({
                outcome: 'ok',
                data: { status: 'pay_offline' },
              }),
            150,
          ),
        ),
    );
    verifyTransaction = spy('verifyTransaction').mockRejectedValue(
      new Error('not stubbed'),
    );
    refund = spy('refund').mockResolvedValue({
      id: '700001',
      status: 'pending',
    });
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

  async function acceptedJob(who: string, title: string): Promise<number> {
    const job = await request(server()).post('/api/v1/jobs').set(as(who)).send({
      title,
      description: 'The garden tap leaks and needs a new washer fitted',
      serviceId,
      location: 'Labone, Greater Accra',
      budgetMin: 100,
      budgetMax: 200,
      currency: 'GHS',
    });
    expect(job.status).toBe(201);
    const jobId = (job.body as { data: { id: number } }).data.id;
    await request(server())
      .post(`/api/v1/jobs/${jobId}/apply`)
      .set(as('k'))
      .send({ quotePrice: 150 });
    const apps = await request(server())
      .get(`/api/v1/jobs/${jobId}/applications`)
      .set(as(who));
    const appId = (apps.body as { data: Array<{ id: number }> }).data[0].id;
    await request(server())
      .post(`/api/v1/jobs/${jobId}/applications/${appId}/accept`)
      .set(as(who));
    return jobId;
  }

  let momoId = 0;
  const methodRows = (userId: number) =>
    dataSource.query<Array<{ id: number }>>(
      'SELECT id FROM customer_payment_methods WHERE user_id = $1',
      [userId],
    );
  const chargeRows = (jobId: number) =>
    dataSource.query<
      Array<{
        reference: string;
        method_type: string;
        status: string;
        refund_status: string | null;
        refund_id: string | null;
        refund_attempts: number;
      }>
    >(
      `SELECT c.* FROM payment_charges c JOIN payments p ON p.id = c.payment_id
       WHERE p.job_id = $1 ORDER BY c.id`,
      [jobId],
    );
  const paymentOf = async (jobId: number) =>
    (
      await dataSource.query<
        Array<{
          id: number;
          status: string;
          reference: string;
          paid_reference: string | null;
        }>
      >('SELECT * FROM payments WHERE job_id = $1', [jobId])
    )[0];

  const charge = (jobId: number, key?: string, methodId = momoId) => {
    const r = request(server())
      .post(`/api/v1/payments/${jobId}/charge`)
      .set(as('a'));
    if (key) r.set('Idempotency-Key', key);
    return r.send({ paymentMethodId: methodId });
  };
  const initialize = (jobId: number, key?: string) => {
    const r = request(server())
      .post('/api/v1/payments/initialize')
      .set(as('a'));
    if (key) r.set('Idempotency-Key', key);
    return r.send({ jobId });
  };
  const state = (jobId: number, who = 'a') =>
    request(server())
      .get(`/api/v1/payments/jobs/${jobId}/attempt`)
      .set(as(who));

  it('setup: a saved MoMo number', async () => {
    const res = await request(server())
      .post('/api/v1/users/me/payment-methods/mobile-money')
      .set(as('a'))
      .send({ network: 'MTN', accountNumber: MOMO });
    expect(res.status).toBe(201);
    momoId = Number(body(res).data.id);
  });

  // ─── Idempotency-Key ─────────────────────────────────────────────────────────

  it('double-click: two charges with one key at once → one Paystack call, one attempt, the same answer', async () => {
    const jobId = await acceptedJob('a', `Double click ${uniq}`);
    const key = randomUUID();
    const [r1, r2] = await Promise.all([
      charge(jobId, key),
      charge(jobId, key),
    ]);
    const statuses = [r1.status, r2.status].sort();
    // The second either waited for the first (replay) or saw it in flight.
    expect([
      [200, 200],
      [200, 409],
    ]).toContainEqual(statuses);
    const inFlight = [r1, r2].find((r) => r.status === 409);
    if (inFlight) {
      expect(body(inFlight).meta.error).toBe('IDEMPOTENCY_IN_PROGRESS');
    }
    expect(chargeMobileMoney).toHaveBeenCalledTimes(1);
    expect(await chargeRows(jobId)).toHaveLength(1);

    // The retry of the same press replays the first response.
    const first = [r1, r2].find((r) => r.status === 200)!;
    const replay = await charge(jobId, key);
    expect(replay.status).toBe(200);
    expect(replay.headers['idempotency-replayed']).toBe('true');
    expect(body(replay).data).toEqual(body(first).data);
    expect(chargeMobileMoney).toHaveBeenCalledTimes(1);

    // The same key for another job is refused, never replayed.
    const other = await acceptedJob('a', `Key reuse ${uniq}`);
    const reused = await charge(other, key);
    expect(reused.status).toBe(422);
    expect(body(reused).meta.error).toBe('IDEMPOTENCY_KEY_REUSED');

    // A malformed key is 400; no key at all still works (old clients).
    const bad = await charge(other, 'not a key');
    expect(bad.status).toBe(400);
    expect(body(bad).meta.error).toBe('IDEMPOTENCY_KEY_INVALID');
    const noKey = await charge(other);
    expect(noKey.status).toBe(200);
  });

  it('two hosted initialises at once (no key) share one checkout session', async () => {
    const jobId = await acceptedJob('a', `Hosted race ${uniq}`);
    const [r1, r2] = await Promise.all([initialize(jobId), initialize(jobId)]);
    expect([r1.status, r2.status]).toEqual([201, 201]);
    expect(body(r1).data.authorizationUrl).toBe(body(r2).data.authorizationUrl);
    expect(body(r1).data.reference).toBe((await paymentOf(jobId)).reference);
    expect(initializeTransaction).toHaveBeenCalledTimes(1);
    expect(await chargeRows(jobId)).toEqual([
      expect.objectContaining({ method_type: 'hosted', status: 'hosted_open' }),
    ]);
  });

  // ─── One active attempt per job ──────────────────────────────────────────────

  it('hosted then MoMo → 409 PAYMENT_ATTEMPT_ACTIVE with the open checkout; the state endpoint shows it', async () => {
    const jobId = await acceptedJob('a', `Hosted then MoMo ${uniq}`);
    const init = await initialize(jobId, randomUUID());
    expect(init.status).toBe(201);

    const res = await charge(jobId, randomUUID());
    expect(res.status).toBe(409);
    expect(body(res).meta.error).toBe('PAYMENT_ATTEMPT_ACTIVE');
    expect(body(res).message).toMatch(/open on the checkout page/);
    expect(body(res).data).toMatchObject({
      jobId,
      kind: 'hosted',
      status: 'hosted_open',
      authorizationUrl: body(init).data.authorizationUrl,
    });
    expect(chargeMobileMoney).not.toHaveBeenCalled();

    const s = await state(jobId);
    expect(s.status).toBe(200);
    expect(s.headers['cache-control']).toBe('private, no-store');
    expect(body(s).data).toMatchObject({
      jobId,
      paid: false,
      activeAttempt: { kind: 'hosted', status: 'hosted_open' },
      duplicateRefunds: [],
    });
    // Someone else's job is 404.
    expect((await state(jobId, 'd')).status).toBe(404);
  });

  it('MoMo then hosted → 409 with "Approve on your phone"; once expired and verified failed, hosted is allowed', async () => {
    const jobId = await acceptedJob('a', `MoMo expires ${uniq}`);
    const started = await charge(jobId, randomUUID());
    expect(started.status).toBe(200);
    const ref = String(body(started).data.reference);

    const blocked = await initialize(jobId, randomUUID());
    expect(blocked.status).toBe(409);
    expect(body(blocked).meta.error).toBe('PAYMENT_ATTEMPT_ACTIVE');
    expect(body(blocked).message).toBe(
      'A payment is waiting for approval on your phone. Approve or decline it there, or wait for it to expire, before paying another way.',
    );
    expect(body(blocked).data).toMatchObject({
      reference: ref,
      kind: 'mobile_money',
      paymentMethodId: momoId,
    });
    expect(initializeTransaction).not.toHaveBeenCalled();

    // Past its window, Paystack unreachable: still blocked (never released blind).
    await dataSource.query(
      "UPDATE payment_charges SET expires_at = now() - interval '1 second' WHERE reference = $1",
      [ref],
    );
    verifyTransaction.mockRejectedValue(new Error('ECONNRESET'));
    expect((await initialize(jobId, randomUUID())).status).toBe(409);

    // Paystack says it failed: released, and the hosted checkout opens.
    verifyTransaction.mockResolvedValue({
      status: 'failed',
      reference: ref,
      amount: 15000,
      currency: 'GHS',
      paid_at: null,
      channel: 'mobile_money',
      customer: { email: 'x', id: 1 },
    });
    const init = await initialize(jobId, randomUUID());
    expect(init.status).toBe(201);
    expect(initializeTransaction).toHaveBeenCalledTimes(1);
    expect((await chargeRows(jobId)).map((c) => c.status)).toEqual([
      'failed',
      'hosted_open',
    ]);
  });

  // ─── Webhooks: one lock, one HELD, duplicates refunded ──────────────────────

  it('two successes for one job with different references at once → one HELD, the other refunded automatically', async () => {
    const jobId = await acceptedJob('a', `Paid twice ${uniq}`);
    const init = await initialize(jobId);
    const hostedRef = String(body(init).data.reference);
    // A MoMo charge that was released (past its window, Paystack said no)
    // and then approved late anyway.
    const started = await (async () => {
      await dataSource.query(
        "UPDATE payment_charges SET expires_at = now() - interval '1 second' WHERE reference = $1",
        [hostedRef],
      );
      verifyTransaction.mockResolvedValue({ status: 'abandoned' });
      return charge(jobId);
    })();
    expect(started.status).toBe(200);
    const momoRef = String(body(started).data.reference);

    const [w1, w2] = await Promise.all([
      webhook('charge.success', paid(momoRef)),
      webhook('charge.success', paid(hostedRef, 'card')),
    ]);
    expect([w1.status, w2.status]).toEqual([201, 201]);

    const p = await paymentOf(jobId);
    expect(p.status).toBe('HELD');
    const rows = await chargeRows(jobId);
    const holder = rows.find((r) => r.status === 'succeeded')!;
    const dup = rows.find((r) => r.status === 'duplicate')!;
    expect(rows.filter((r) => r.status === 'succeeded')).toHaveLength(1);
    expect(p.paid_reference).toBe(holder.reference);
    expect(dup).toMatchObject({
      refund_status: 'requested',
      refund_id: '700001',
      refund_attempts: 1,
    });
    // Only the duplicate is refunded, once; never the money-holder.
    expect(refund).toHaveBeenCalledTimes(1);
    expect(refund).toHaveBeenCalledWith(dup.reference);
    expect(refund).not.toHaveBeenCalledWith(holder.reference);

    // The customer is told, calmly, and the job page can show it.
    let note: Array<{ body: string }> = [];
    for (let i = 0; i < 20 && note.length === 0; i++) {
      note = await dataSource.query(
        "SELECT body FROM notifications WHERE user_id = $1 AND type = 'DUPLICATE_PAYMENT_REFUNDED'",
        [ids.a],
      );
      if (!note.length) await new Promise((r) => setTimeout(r, 100));
    }
    expect(note[0].body).toMatch(
      /^You were charged twice for Paid twice \d+\. We've refunded the extra payment of GH₵ 150\.00 to your (MTN MoMo|card)\.$/,
    );
    const s = await state(jobId);
    expect(body(s).data).toMatchObject({
      paid: true,
      activeAttempt: null,
      duplicateRefunds: [
        expect.objectContaining({
          reference: dup.reference,
          amount: 150,
          currency: 'GHS',
          status: 'requested',
        }),
      ],
    });

    // Paystack retries both webhooks: nothing changes, no second refund.
    await webhook('charge.success', paid(momoRef));
    await webhook('charge.success', paid(hostedRef, 'card'));
    expect(refund).toHaveBeenCalledTimes(1);

    // refund.processed lands.
    await webhook('refund.processed', {
      transaction_reference: dup.reference,
      id: 700001,
      status: 'processed',
    });
    expect(
      (await chargeRows(jobId)).find((r) => r.reference === dup.reference)
        ?.refund_status,
    ).toBe('processed');

    // Paid is final on every payment POST, with the payment in data.
    for (const res of [
      await initialize(jobId, randomUUID()),
      await charge(jobId, randomUUID()),
    ]) {
      expect(res.status).toBe(409);
      expect(body(res).meta.error).toBe('ALREADY_PAID');
      expect(body(res).data).toMatchObject({
        jobId,
        status: 'HELD',
        amount: 150,
        reference: holder.reference,
      });
    }
  });

  it('the same webhook delivered twice at once is processed once', async () => {
    const jobId = await acceptedJob('a', `Webhook twice ${uniq}`);
    const init = await initialize(jobId);
    const ref = String(body(init).data.reference);
    const event = paid(ref, 'card');
    await Promise.all([
      webhook('charge.success', event),
      webhook('charge.success', event),
    ]);
    expect((await paymentOf(jobId)).status).toBe('HELD');
    expect((await chargeRows(jobId)).map((c) => c.status)).toEqual([
      'succeeded',
    ]);
    expect(refund).not.toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 300));
    const receipts = await dataSource.query<unknown[]>(
      `SELECT id FROM notifications WHERE user_id = $1 AND type = 'PAYMENT_RECEIPT'
       AND payload->>'jobId' = $2`,
      [ids.a, String(jobId)],
    );
    expect(receipts).toHaveLength(1);
  });

  it('a refund call that fails is retried by the scheduler with backoff', async () => {
    const jobId = await acceptedJob('a', `Refund retry ${uniq}`);
    const init = await initialize(jobId);
    const hostedRef = String(body(init).data.reference);
    await webhook('charge.success', paid(hostedRef, 'card'));
    // A second, late success with another reference (an old MoMo prompt).
    await dataSource.query(
      `INSERT INTO payment_charges (payment_id, customer_id, reference, method_type, status, expires_at)
       VALUES ($1, $2, $3, 'mobile_money', 'expired', now())`,
      [(await paymentOf(jobId)).id, ids.a, `jinva-ch-late-${uniq}`],
    );
    refund.mockRejectedValueOnce(new Error('Paystack is down'));
    await webhook('charge.success', paid(`jinva-ch-late-${uniq}`));
    let dup = (await chargeRows(jobId)).find((r) => r.status === 'duplicate')!;
    expect(dup).toMatchObject({ refund_status: 'pending', refund_attempts: 1 });

    const refunds = moduleFixture.get(DuplicateRefundService);
    // Not due yet: nothing happens.
    expect(await refunds.retryDue()).toEqual({ candidates: 0, requested: 0 });
    await dataSource.query(
      "UPDATE payment_charges SET refund_next_at = now() - interval '1 second' WHERE reference = $1",
      [dup.reference],
    );
    expect(await refunds.retryDue()).toEqual({ candidates: 1, requested: 1 });
    dup = (await chargeRows(jobId)).find((r) => r.status === 'duplicate')!;
    expect(dup).toMatchObject({
      refund_status: 'requested',
      refund_attempts: 2,
    });
    expect(refund).toHaveBeenCalledTimes(2);
    expect(refund).toHaveBeenLastCalledWith(`jinva-ch-late-${uniq}`);
  });

  // ─── Account deletion ────────────────────────────────────────────────────────

  it('a deletion request keeps saved methods for the 30-day recovery window', async () => {
    const add = await request(server())
      .post('/api/v1/users/me/payment-methods/mobile-money')
      .set(as('d'))
      .send({ network: 'MTN', accountNumber: '0240000002' });
    expect(add.status).toBe(201);

    const del = await request(server()).delete('/api/v1/users/me').set(as('d'));
    expect(del.status).toBe(200);

    // Removed by the account purge once the window has passed, not now.
    expect(await methodRows(ids.d)).toHaveLength(1);
    expect((await methodRows(ids.a)).length).toBeGreaterThan(0);
  });
});

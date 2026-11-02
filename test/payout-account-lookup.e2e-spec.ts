/**
 * Payout account name lookup over real HTTP and the in-memory database:
 * `POST /payments/payout-method/resolve` and the server-side lookup on
 * `POST /payments/payout-method`, and the payout name check made before
 * every transfer. Paystack is mocked (resolveAccount,
 * createTransferRecipient, listBanks, initiateTransfer); nothing leaves the
 * process. Every person and number here is fictional.
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
import { PaymentStatus, Role, Status } from '@common/types/enums';
import { PaystackService } from '../src/payments/paystack.service';
import { PaymentsService } from '../src/payments/payments.service';
import { Payment } from '../src/payments/entities/payment.entity';
import { Job } from '@jobs/entities/job.entity';
import { ServiceEntity } from '@services/entities/service.entity';
import { PAYOUT_NAME_MISMATCH_MESSAGE } from '../src/payments/payout-hold';
import type { ResolveAccountResult } from '../src/payments/paystack.service';
import {
  ACCOUNT_LOOKUP_UNAVAILABLE,
  ACCOUNT_NAME_NOT_FOUND,
} from '../src/payments/payout-account';
import { removeTestData, testUserIds } from './helpers/test-data';

jest.setTimeout(120000);

const PREV_LIMIT = process.env.PAYOUT_ACCOUNT_LOOKUP_RATE_LIMIT_PER_10_MINUTES;
// Read by ThrottlingModule at boot: room for the flows below, small enough
// for the 429 case.
process.env.PAYOUT_ACCOUNT_LOOKUP_RATE_LIMIT_PER_10_MINUTES = '8';

interface Envelope {
  message: unknown;
  data: Record<string, unknown>;
  meta: Record<string, unknown>;
}
const body = (res: request.Response): Envelope => res.body as Envelope;

const PREFIX = 'payout-lookup-';
const NUMBER = '0240000000';
const NAME = 'KOFI ASANTE';

describe('Payout account lookup', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  const uniq = Date.now();
  const token: Record<string, string> = {};
  const userId: Record<string, number> = {};
  const resolveAccount = jest.fn<
    Promise<ResolveAccountResult>,
    [string, string]
  >();
  const createTransferRecipient = jest.fn();
  const listBanks = jest.fn();
  const initiateTransfer = jest.fn();
  let moduleRef: TestingModule;
  let serviceId: number | undefined;
  const server = () => app.getHttpServer();
  const post = (path: string, payload: object, who = 'K') =>
    request(server())
      .post(`/api/v1${path}`)
      .set({ Authorization: `Bearer ${token[who]}` })
      .send(payload);
  const resolve = (payload: object, who = 'K') =>
    post('/payments/payout-method/resolve', payload, who);
  const save = (payload: object, who = 'K') =>
    post('/payments/payout-method', payload, who);
  const momo = { type: 'mobile_money', accountNumber: NUMBER, bankCode: 'MTN' };
  const profileRow = async (who: string) =>
    (
      await dataSource.query<
        Array<{
          payout_account_name: string | null;
          payout_account_name_verified: boolean | null;
          payout_account_number: string | null;
          paystack_recipient_code: string | null;
        }>
      >(
        `SELECT payout_account_name, payout_account_name_verified, payout_account_number, paystack_recipient_code
         FROM artisan_profiles WHERE user_id = $1`,
        [userId[who]],
      )
    )[0];

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
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
    moduleRef = moduleFixture;

    jest
      .spyOn(PaystackService.prototype, 'resolveAccount')
      .mockImplementation(resolveAccount);
    jest
      .spyOn(PaystackService.prototype, 'createTransferRecipient')
      .mockImplementation(createTransferRecipient);
    jest
      .spyOn(PaystackService.prototype, 'listBanks')
      .mockImplementation(listBanks);
    jest
      .spyOn(PaystackService.prototype, 'initiateTransfer')
      .mockImplementation(initiateTransfer);
    listBanks.mockResolvedValue([
      { code: '280100', name: 'Access Bank', type: 'ghipss', active: true },
    ]);

    const users: Repository<User> = moduleFixture.get(getRepositoryToken(User));
    const profiles: Repository<ArtisanProfile> = moduleFixture.get(
      getRepositoryToken(ArtisanProfile),
    );
    const tokens = moduleFixture.get(UserTokenService);
    const make = async (label: string, role: Role) => {
      const u = await users.save(
        users.create({
          email: `${PREFIX}${label.toLowerCase()}-${uniq}@test.jinva.local`,
          username: `pl${label}${uniq}`,
          firstname: 'Kofi',
          lastname: 'Asante',
          role,
          accountVerified: true,
        }),
      );
      userId[label] = u.id;
      token[label] = (await tokens.createJWTTokens(u)).access_token;
      if (role === Role.ARTISAN) {
        await profiles.save(
          profiles.create({
            user: u,
            hourlyRate: 80,
            location: 'Tema',
            currency: 'GHS',
          }),
        );
      }
    };
    await make('K', Role.ARTISAN);
    await make('T', Role.ARTISAN);
    await make('P', Role.ARTISAN);
    await make('c', Role.CUSTOMER);
  });

  beforeEach(() => {
    resolveAccount.mockReset();
    createTransferRecipient.mockReset();
    createTransferRecipient.mockResolvedValue({ recipient_code: 'RCP_e2e' });
    initiateTransfer.mockReset();
    initiateTransfer.mockResolvedValue({ transfer_code: 'TRF_e2e' });
  });

  afterAll(async () => {
    if (PREV_LIMIT === undefined) {
      delete process.env.PAYOUT_ACCOUNT_LOOKUP_RATE_LIMIT_PER_10_MINUTES;
    } else {
      process.env.PAYOUT_ACCOUNT_LOOKUP_RATE_LIMIT_PER_10_MINUTES = PREV_LIMIT;
    }
    await removeTestData(dataSource, {
      userIds: await testUserIds(dataSource, PREFIX),
      serviceIds: serviceId ? [serviceId] : [],
    });
    jest.restoreAllMocks();
    await app.close();
  });

  describe('POST /payments/payout-method/resolve', () => {
    it('is for signed-in artisans only', async () => {
      const anon = await request(server())
        .post('/api/v1/payments/payout-method/resolve')
        .send(momo);
      expect(anon.status).toBe(401);
      expect((await resolve(momo, 'c')).status).toBe(403);
      expect(resolveAccount).not.toHaveBeenCalled();
    });

    it('validates the number, the network or bank, and unknown fields', async () => {
      const short = await resolve({ ...momo, accountNumber: '02400' });
      expect(short.status).toBe(400);
      const unknownBank = await resolve({
        type: 'bank',
        accountNumber: '1234567890',
        bankCode: '999999',
      });
      expect(unknownBank.status).toBe(400);
      const extra = await resolve({ ...momo, accountName: NAME });
      expect(extra.status).toBe(400);
      expect(resolveAccount).not.toHaveBeenCalled();
    });

    it('returns the name for a normalised number, never cached', async () => {
      resolveAccount.mockResolvedValue({
        status: 'resolved',
        accountName: NAME,
      });
      const res = await resolve({
        ...momo,
        accountNumber: '+233 24 000 0000',
        bankCode: 'vod',
      });
      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('private, no-store');
      expect(body(res).data).toEqual({ accountName: NAME });
      expect(resolveAccount).toHaveBeenCalledWith(NUMBER, 'VOD');

      const bank = await resolve({
        type: 'bank',
        accountNumber: '1234567890',
        bankCode: '280100',
      });
      expect(bank.status).toBe(200);
      expect(resolveAccount).toHaveBeenLastCalledWith('1234567890', '280100');
    });

    it('answers 422 when the account is not found and 503 when the lookup is down', async () => {
      resolveAccount.mockResolvedValueOnce({ status: 'unresolvable' });
      const notFound = await resolve(momo);
      expect(notFound.status).toBe(422);
      expect(body(notFound).message).toBe(ACCOUNT_NAME_NOT_FOUND);

      resolveAccount.mockResolvedValueOnce({ status: 'unavailable' });
      const down = await resolve(momo);
      expect(down.status).toBe(503);
      expect(body(down).message).toBe(ACCOUNT_LOOKUP_UNAVAILABLE);
    });

    it('rate-limits lookups per user', async () => {
      resolveAccount.mockResolvedValue({
        status: 'resolved',
        accountName: NAME,
      });
      for (let i = 0; i < 8; i += 1) {
        expect((await resolve(momo, 'T')).status).toBe(200);
      }
      const limited = await resolve(momo, 'T');
      expect(limited.status).toBe(429);
      expect(body(limited).meta.error).toBe(
        'PAYOUT_ACCOUNT_LOOKUP_RATE_LIMIT_EXCEEDED',
      );
      expect(resolveAccount).toHaveBeenCalledTimes(8);
    });
  });

  describe('POST /payments/payout-method', () => {
    it('refuses a number that cannot be resolved and saves nothing', async () => {
      resolveAccount.mockResolvedValue({ status: 'unresolvable' });
      const res = await save({ ...momo, accountName: 'Somebody Else' });
      expect(res.status).toBe(422);
      expect(body(res).message).toBe(ACCOUNT_NAME_NOT_FOUND);
      expect(createTransferRecipient).not.toHaveBeenCalled();
      expect((await profileRow('K')).paystack_recipient_code).toBeNull();
    });

    it('stores the looked-up name over the typed one, as verified', async () => {
      resolveAccount.mockResolvedValue({
        status: 'resolved',
        accountName: NAME,
      });
      const res = await save({
        ...momo,
        accountNumber: '233240000000',
        accountName: 'Somebody Else',
      });
      expect(res.status).toBe(201);
      expect(res.headers['cache-control']).toBe('private, no-store');
      expect(body(res).data).toEqual({
        accountName: NAME,
        accountNameVerified: true,
        payoutsRetried: 0,
        payoutsStillOnHold: 0,
      });
      expect(createTransferRecipient).toHaveBeenCalledWith(
        expect.objectContaining({ name: NAME, accountNumber: NUMBER }),
      );
      expect(await profileRow('K')).toMatchObject({
        payout_account_name: NAME,
        payout_account_name_verified: true,
        payout_account_number: NUMBER,
      });

      const profile = await request(server())
        .get('/api/v1/users/me/artisan-profile')
        .set({ Authorization: `Bearer ${token.K}` });
      expect(body(profile).data.payoutDestination).toEqual({
        type: 'mobile_money',
        label: 'MTN MoMo',
        last4: '0000',
        accountName: NAME,
        accountNameVerified: true,
      });
      expect(JSON.stringify(profile.body)).not.toContain(NUMBER);
    });

    it('falls back to the typed name, not verified, when the lookup is down', async () => {
      resolveAccount.mockResolvedValue({ status: 'unavailable' });
      const noName = await save(momo);
      expect(noName.status).toBe(400);
      expect(createTransferRecipient).not.toHaveBeenCalled();

      const res = await save({ ...momo, accountName: 'Kofi Asante' });
      expect(res.status).toBe(201);
      expect(body(res).data).toEqual({
        accountName: 'Kofi Asante',
        accountNameVerified: false,
        payoutsRetried: 0,
        payoutsStillOnHold: 0,
      });
      expect(await profileRow('K')).toMatchObject({
        payout_account_name: 'Kofi Asante',
        payout_account_name_verified: false,
      });
    });
  });

  describe('payout name check before a transfer', () => {
    const SAVED = 'YAW DARKO';
    const NEW_NUMBER = '0550000000';
    let payments: PaymentsService;

    const paymentRow = async (id: number) =>
      (
        await dataSource.query<
          Array<{
            status: string;
            payout_hold_reason: string | null;
            payout_check_attempts: number;
            payout_check_next_at: Date | null;
            transfer_code: string | null;
          }>
        >(
          `SELECT status, payout_hold_reason, payout_check_attempts, payout_check_next_at, transfer_code
           FROM payments WHERE id = $1`,
          [id],
        )
      )[0];
    const onHoldNotifications = async () =>
      (
        await dataSource.query<Array<{ body: string; payload: object }>>(
          `SELECT body, payload FROM notifications WHERE user_id = $1 AND type = 'PAYOUT_ON_HOLD'`,
          [userId.P],
        )
      ).map((r) => r);
    /** Listeners run after the emit returns; wait for their write. */
    const settle = () => new Promise((r) => setTimeout(r, 150));

    const makeHeldPayment = async (title: string): Promise<Payment> => {
      const jobs = moduleRef.get<Repository<Job>>(getRepositoryToken(Job));
      const rows = moduleRef.get<Repository<Payment>>(
        getRepositoryToken(Payment),
      );
      const profileId = (
        await dataSource.query<Array<{ id: number }>>(
          'SELECT id FROM artisan_profiles WHERE user_id = $1',
          [userId.P],
        )
      )[0].id;
      const job = await jobs.save(
        jobs.create({
          customer: { id: userId.c },
          service: { id: serviceId },
          title,
          description: 'Fixture job for the payout name check.',
          location: 'Tema',
          currency: 'GHS',
          budgetMin: 200,
          budgetMax: 200,
          status: Status.COMPLETED,
          acceptedArtisan: { id: userId.P },
        }),
      );
      return rows.save(
        rows.create({
          jobId: job.id,
          customerId: userId.c,
          artisanProfileId: profileId,
          amount: 200,
          platformFee: 10,
          artisanAmount: 190,
          currency: 'GHS',
          status: PaymentStatus.HELD,
          reference: `${PREFIX}${uniq}-${job.id}`,
          channel: 'mobile_money',
          paidAt: new Date('2026-10-20T10:00:00Z'),
        }),
      );
    };

    beforeAll(async () => {
      payments = moduleRef.get(PaymentsService);
      const services = moduleRef.get<Repository<ServiceEntity>>(
        getRepositoryToken(ServiceEntity),
      );
      serviceId = (
        await services.save(
          services.create({
            name: `Payout check service ${uniq}`,
            estimatedDurationMins: 60,
          }),
        )
      ).id;
    });

    it('holds a payout whose name no longer matches, tells the artisan once, and sends it after they fix their details', async () => {
      resolveAccount.mockResolvedValue({
        status: 'resolved',
        accountName: SAVED,
      });
      expect((await save(momo, 'P')).status).toBe(201);
      const p = await makeHeldPayment('Fix the gate hinge');

      // The account now belongs to someone else.
      resolveAccount.mockResolvedValue({
        status: 'resolved',
        accountName: 'ESI BOATENG',
      });
      await payments.capturePayment(p.reference, p.jobId);
      await settle();

      expect(initiateTransfer).not.toHaveBeenCalled();
      expect(await paymentRow(p.id)).toMatchObject({
        status: PaymentStatus.PENDING_TRANSFER,
        payout_hold_reason: 'payout_name_mismatch',
        transfer_code: null,
      });
      expect((await profileRow('P')).payout_account_name_verified).toBe(false);
      const told = await onHoldNotifications();
      expect(told).toHaveLength(1);
      expect(told[0].body).toBe(
        "We couldn't send your payout for Fix the gate hinge. The name on your payout account doesn't match. Update your payment details to receive it.",
      );
      expect(JSON.stringify(told)).not.toContain(NUMBER);

      // The artisan's retry says why, sends nothing and doesn't re-notify.
      const retry = await post(`/payments/retry-transfer/${p.jobId}`, {}, 'P');
      expect(retry.status).toBe(422);
      expect(body(retry).message).toBe(PAYOUT_NAME_MISMATCH_MESSAGE);
      await settle();
      expect(await onHoldNotifications()).toHaveLength(1);
      expect(initiateTransfer).not.toHaveBeenCalled();

      // The statement and its CSV say why it needs action.
      const statement = await request(server())
        .get('/api/v1/payments/my-earnings/statement?period=all')
        .set({ Authorization: `Bearer ${token.P}` });
      expect(statement.status).toBe(200);
      const items = body(statement).data.items as Array<
        Record<string, unknown>
      >;
      expect(items.find((i) => i.paymentId === p.id)).toMatchObject({
        stage: 'needs_action',
        holdReason: 'payout_name_mismatch',
      });
      const csv = await request(server())
        .get('/api/v1/payments/my-earnings/export.csv?period=all')
        .set({ Authorization: `Bearer ${token.P}` });
      expect(csv.status).toBe(200);
      expect(csv.text).toContain('Payout on hold');
      expect(csv.text).toContain("Payout account name doesn't match");

      // Saving corrected details retries it with the new account.
      resolveAccount.mockResolvedValue({
        status: 'resolved',
        accountName: SAVED,
      });
      createTransferRecipient.mockResolvedValue({
        recipient_code: 'RCP_fixed',
      });
      const fixed = await save({ ...momo, accountNumber: NEW_NUMBER }, 'P');
      expect(fixed.status).toBe(201);
      expect(body(fixed).data).toMatchObject({
        accountNameVerified: true,
        payoutsRetried: 1,
        payoutsStillOnHold: 0,
      });
      expect(resolveAccount).toHaveBeenLastCalledWith(NEW_NUMBER, 'MTN');
      expect(initiateTransfer).toHaveBeenCalledTimes(1);
      expect(initiateTransfer).toHaveBeenCalledWith(
        expect.objectContaining({ recipientCode: 'RCP_fixed' }),
      );
      expect(await paymentRow(p.id)).toMatchObject({
        status: PaymentStatus.HELD,
        payout_hold_reason: null,
        transfer_code: 'TRF_e2e',
      });
      expect((await profileRow('P')).payout_account_name_verified).toBe(true);
    });

    it('waits without blaming the artisan when the lookup is down, then the scheduler sends it', async () => {
      resolveAccount.mockResolvedValue({
        status: 'resolved',
        accountName: SAVED,
      });
      const p = await makeHeldPayment('Rehang the kitchen door');
      const before = (await onHoldNotifications()).length;

      resolveAccount.mockResolvedValue({ status: 'unavailable' });
      await payments.capturePayment(p.reference, p.jobId);
      await settle();

      expect(initiateTransfer).not.toHaveBeenCalled();
      const held = await paymentRow(p.id);
      expect(held).toMatchObject({
        status: PaymentStatus.PENDING_TRANSFER,
        payout_hold_reason: 'payout_check_pending',
        payout_check_attempts: 1,
      });
      expect(held.payout_check_next_at).not.toBeNull();
      expect((await profileRow('P')).payout_account_name_verified).toBe(true);
      expect(await onHoldNotifications()).toHaveLength(before);

      // Not due yet: nothing happens.
      expect(await payments.retryDuePayoutChecks(new Date())).toMatchObject({
        candidates: 0,
      });

      // Once due, with Paystack back, the scheduler's retry sends it.
      resolveAccount.mockResolvedValue({
        status: 'resolved',
        accountName: SAVED,
      });
      const later = new Date(Date.now() + 2 * 60 * 60_000);
      expect(await payments.retryDuePayoutChecks(later)).toEqual({
        candidates: 1,
        sent: 1,
        failed: 0,
      });
      expect(initiateTransfer).toHaveBeenCalledTimes(1);
      expect(await paymentRow(p.id)).toMatchObject({
        status: PaymentStatus.HELD,
        payout_hold_reason: null,
        payout_check_attempts: 0,
        payout_check_next_at: null,
      });
    });
  });
});

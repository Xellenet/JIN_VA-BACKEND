/**
 * Customer experience v2, B6 `GET /customers/me/overview` (test plan E-2.1 to
 * E-2.6, SEC-6/T-1, T-2, T-6). Fictional people and data only.
 */
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
import { ArtisanProfile } from '@users/entities/artisan-profile.entity';
import { UserTokenService } from '@users/token.service';
import { ServiceEntity } from '@services/entities/service.entity';
import { Role } from '@common/types/enums';
import { expectNoForbiddenFields } from './support/forbidden-fields';
import type { CustomerOverview } from '../src/customer-insights/customer-overview.service';

type Envelope = {
  message: string;
  data: CustomerOverview;
  meta: { error?: string; retryAfterSeconds?: number };
};
/** The overview body, typed as the documented contract. */
const bodyOf = (res: { body: unknown }): Envelope => res.body as Envelope;

jest.setTimeout(120000);

const PREV_LIMIT = process.env.CUSTOMER_ANALYTICS_RATE_LIMIT_PER_MINUTE;
process.env.CUSTOMER_ANALYTICS_RATE_LIMIT_PER_MINUTE = '5';

const DAY = 86_400_000;
const ymd = (offsetDays: number) =>
  new Date(Date.now() + offsetDays * DAY).toISOString().slice(0, 10);

describe('Customer overview rail (B6)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  const uniq = Date.now();
  const token: Record<string, string> = {};
  const userId: Record<string, number> = {};
  const profileId: Record<string, number> = {};
  const jobId: Record<string, number> = {};
  let serviceId = 0;
  let nextBookingId = 0;
  const server = () => app.getHttpServer();
  const as = (who: string) => ({ Authorization: `Bearer ${token[who]}` });
  const get = (path: string, who = 'a') =>
    request(server()).get(`/api/v1${path}`).set(as(who));
  const K_PHONE = '+233240000272';
  const K_EMAIL = `cxo-k-${uniq}@test.jinva.local`;

  const job = async (
    label: string,
    customer: string,
    status: string,
    extra = '',
  ) => {
    const [row] = await dataSource.query<Array<{ id: number }>>(
      `INSERT INTO jobs (customer_id, service_id, title, location, status${extra ? ', completion_requested_at' : ''})
       VALUES ($1, $2, $3, 'Osu, Accra', $4${extra ? ', NOW()' : ''}) RETURNING id`,
      [userId[customer], serviceId, `${label} title`, status],
    );
    jobId[label] = row.id;
    return row.id;
  };
  const apply = (job: string, artisan: string, status = 'PENDING') =>
    dataSource.query(
      `INSERT INTO job_applications (job_id, artisan_id, status) VALUES ($1, $2, $3)`,
      [jobId[job], userId[artisan], status],
    );
  const payment = (
    job: string,
    customer: string,
    artisan: string,
    status: string,
    amount: number,
    paid: boolean,
  ) =>
    dataSource.query(
      `INSERT INTO payments (job_id, customer_id, artisan_profile_id, amount, platform_fee, artisan_amount, status, reference, paid_at)
       VALUES ($1, $2, $3, $4, 0, $4, $5, $6, $7)`,
      [
        jobId[job],
        userId[customer],
        profileId[artisan],
        amount,
        status,
        `CXO-${uniq}-${job}-${status}`,
        paid ? new Date() : null,
      ],
    );
  const conversation = async (
    customer: string,
    other: string,
    messages: Array<[string, boolean]>,
  ) => {
    const [conv] = await dataSource.query<Array<{ id: number }>>(
      `INSERT INTO conversations (participant_a_id, participant_b_id, last_message_at) VALUES ($1, $2, NOW()) RETURNING id`,
      [userId[customer], userId[other]],
    );
    for (const [sender, read] of messages) {
      await dataSource.query(
        `INSERT INTO messages (conversation_id, sender_id, content, is_read) VALUES ($1, $2, 'Hello there', $3)`,
        [conv.id, userId[sender], read],
      );
    }
  };
  const booking = async (
    customer: string,
    artisan: string,
    date: string,
    start: string,
    end: string,
    status: string,
  ) => {
    const [row] = await dataSource.query<Array<{ id: number }>>(
      `INSERT INTO bookings (customer_id, artisan_profile_id, service_id, scheduled_date, start_time, end_time, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [
        userId[customer],
        profileId[artisan],
        serviceId,
        date,
        start,
        end,
        status,
      ],
    );
    return row.id;
  };

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

    const services: Repository<ServiceEntity> = moduleFixture.get(
      getRepositoryToken(ServiceEntity),
    );
    serviceId = (
      await services.save(
        services.create({
          name: `Overview Plumbing ${uniq}`,
          estimatedDurationMins: 60,
        }),
      )
    ).id;
    const users: Repository<User> = moduleFixture.get(getRepositoryToken(User));
    const profiles: Repository<ArtisanProfile> = moduleFixture.get(
      getRepositoryToken(ArtisanProfile),
    );
    const tokens = moduleFixture.get(UserTokenService);
    const make = async (
      label: string,
      role: Role,
      first: string,
      last: string,
      extra: Partial<User> = {},
    ) => {
      const u = await users.save(
        users.create({
          email: `cxo-${label.toLowerCase()}-${uniq}@test.jinva.local`,
          username: `cxo${label}${uniq}`,
          firstname: first,
          lastname: last,
          role,
          accountVerified: true,
          ...extra,
        }),
      );
      userId[label] = u.id;
      token[label] = (await tokens.createJWTTokens(u)).access_token;
      if (role === Role.ARTISAN) {
        profileId[label] = (
          await profiles.save(
            profiles.create({
              user: u,
              hourlyRate: 80,
              location: 'Tema',
              currency: 'GHS',
              isProfileComplete: true,
              payoutAccountNumber: '0240000888',
            }),
          )
        ).id;
      }
    };
    await make('a', Role.CUSTOMER, 'Ama', 'Owusu');
    await make('b', Role.CUSTOMER, 'Kwame', 'Boateng');
    await make('n', Role.CUSTOMER, 'Esi', 'Nyarko');
    await make('K', Role.ARTISAN, 'Kofi', 'Asante', {
      phoneNumber: K_PHONE,
      profilePicture: '/uploads/avatars/k.webp',
    });
    await make('K2', Role.ARTISAN, 'Akua', 'Sarpong');
    await make('K3', Role.ARTISAN, 'Yaw', 'Ofori');
    await make('K4', Role.ARTISAN, 'Adwoa', 'Kyei');
    await make('admin', Role.ADMIN, 'Efua', 'Badu');
    await dataSource.query(`UPDATE users SET email = $1 WHERE id = $2`, [
      K_EMAIL,
      userId.K,
    ]);

    // BU-2.1 data for A.
    await job('confirm', 'a', 'IN_PROGRESS', 'completion');
    await job('working', 'a', 'IN_PROGRESS'); // no completion requested
    await job('due', 'a', 'PENDING');
    await payment('due', 'a', 'K', 'PENDING', 350, false);
    await job('open1', 'a', 'OPEN');
    await job('open2', 'a', 'OPEN');
    await apply('open1', 'K');
    await apply('open1', 'K2');
    await apply('open1', 'K3');
    await apply('open1', 'K4', 'REJECTED');
    await apply('open2', 'K');
    await conversation('a', 'K', [
      ['K', false],
      ['K', false],
      ['a', true],
    ]);
    await conversation('a', 'K2', [['K2', false]]);
    await conversation('a', 'K3', [['a', false]]); // only A's own unread
    await conversation('a', 'K4', [['K4', true]]);

    // Bookings: yesterday, a cancelled earlier one, the expected next one, a later one.
    await booking('a', 'K', ymd(-1), '09:00', '11:00', 'CONFIRMED');
    await booking('a', 'K', ymd(1), '08:00', '09:00', 'CANCELLED');
    nextBookingId = await booking(
      'a',
      'K',
      ymd(1),
      '09:00',
      '11:00',
      'CONFIRMED',
    );
    await booking('a', 'K2', ymd(2), '10:00', '12:00', 'PENDING');

    // Spend for A: one held payment this month.
    await job('paid', 'a', 'IN_PROGRESS');
    await payment('paid', 'a', 'K', 'HELD', 650, true);

    // B: 2 applications on one job (jobId is set), plus a booking and payment.
    await job('bOpen', 'b', 'OPEN');
    await apply('bOpen', 'K');
    await apply('bOpen', 'K2');
    await booking('b', 'K', ymd(1), '07:00', '08:00', 'CONFIRMED');
    await job('bPaid', 'b', 'COMPLETED');
    await payment('bPaid', 'b', 'K', 'RELEASED', 4321, true);
  });

  afterAll(async () => {
    if (PREV_LIMIT === undefined)
      delete process.env.CUSTOMER_ANALYTICS_RATE_LIMIT_PER_MINUTE;
    else process.env.CUSTOMER_ANALYTICS_RATE_LIMIT_PER_MINUTE = PREV_LIMIT;
    await app.close();
  });

  it("E-2.1 returns the documented shape with A's action items, next booking and spend", async () => {
    const res = await get('/customers/me/overview');
    expect(res.status).toBe(200);
    expect(bodyOf(res).message).toBe('Overview retrieved');
    expect(res.headers['cache-control']).toBe('private, no-store');
    const d = bodyOf(res).data;
    expect(Object.keys(d).sort()).toEqual([
      'actionItems',
      'failedSections',
      'nextBooking',
      'spend',
    ]);
    expect(d.failedSections).toEqual([]);
    expect(d.actionItems).toEqual({
      completionsToConfirm: {
        count: 1,
        jobId: jobId.confirm,
        jobTitle: 'confirm title',
      },
      paymentsDue: { count: 1, jobId: jobId.due, jobTitle: 'due title' },
      applicationsToReview: { count: 4, jobId: null, jobTitle: null },
      unreadMessages: 2,
    });
    expect(d.nextBooking).toEqual({
      id: nextBookingId,
      scheduledDate: ymd(1),
      startTime: '09:00',
      endTime: '11:00',
      status: 'CONFIRMED',
      service: { id: serviceId, name: `Overview Plumbing ${uniq}` },
      artisan: {
        id: profileId.K,
        displayName: 'Kofi Asante',
        avatar: '/uploads/avatars/k.webp',
      },
    });
    expect(d.spend).toMatchObject({
      currency: 'GHS',
      hasPaymentsEver: true,
      held: '650.00',
      thisMonth: '650.00',
    });
    expect(d.spend!.last6Months).toHaveLength(6);
    expect(d.spend!.last6Months[5].month).toBe(
      new Date().toISOString().slice(0, 7),
    );
  });

  it('sets jobId when every item belongs to one job ([Δ] clarification)', async () => {
    const d = bodyOf(await get('/customers/me/overview', 'b')).data;
    expect(d.actionItems!.applicationsToReview).toEqual({
      count: 2,
      jobId: jobId.bOpen,
      jobTitle: 'bOpen title',
    });
  });

  it("E-2.2 / T-2 has no forbidden keys and none of the artisan's contact details", async () => {
    const res = await get('/customers/me/overview');
    expectNoForbiddenFields(res.body, {
      forbiddenValues: [K_PHONE, K_EMAIL, '0240000888'],
    });
    expect(JSON.stringify(res.body)).not.toMatch(
      /phone|email|payout|bank|account|platformFee|artisanAmount|transfer|fraud|authorization|accessCode/i,
    );
  });

  it("E-2.3 contains none of B's ids or amounts", async () => {
    const text = JSON.stringify((await get('/customers/me/overview')).body);
    expect(text).not.toContain('4321');
    expect(text).not.toContain(`"jobId":${jobId.bOpen}`);
    const bNext = bodyOf(await get('/customers/me/overview', 'b')).data
      .nextBooking;
    expect(bNext!.id).not.toBe(nextBookingId);
  });

  it('E-2.4 needs a token and the customer role; owner parameters are 400', async () => {
    expect(
      (await request(server()).get('/api/v1/customers/me/overview')).status,
    ).toBe(401);
    expect((await get('/customers/me/overview', 'K')).status).toBe(403);
    expect((await get('/customers/me/overview', 'admin')).status).toBe(403);
    expect(
      (await get(`/customers/me/overview?customerId=${userId.b}`)).status,
    ).toBe(400);
  });

  it('E-2.5 a customer with nothing gets zeros, no booking and six zero months', async () => {
    const d = bodyOf(await get('/customers/me/overview', 'n')).data;
    expect(d.actionItems).toEqual({
      completionsToConfirm: { count: 0, jobId: null, jobTitle: null },
      paymentsDue: { count: 0, jobId: null, jobTitle: null },
      applicationsToReview: { count: 0, jobId: null, jobTitle: null },
      unreadMessages: 0,
    });
    expect(d.nextBooking).toBeNull();
    expect(d.spend).toMatchObject({
      hasPaymentsEver: false,
      thisMonth: '0.00',
      lastMonth: '0.00',
      held: '0.00',
    });
    expect(
      d.spend!.last6Months.map((m: { netSpent: string }) => m.netSpent),
    ).toEqual(Array(6).fill('0.00'));
    expect(d.failedSections).toEqual([]);
  });

  it('E-2.6 / T-6 throttles per user with the customer-analytics contract', async () => {
    // Limit 5 for this file; A has used some already.
    let last = await get('/customers/me/overview');
    for (let i = 0; i < 6 && last.status === 200; i++)
      last = await get('/customers/me/overview');
    expect(last.status).toBe(429);
    expect(bodyOf(last).meta.error).toBe(
      'CUSTOMER_ANALYTICS_RATE_LIMIT_EXCEEDED',
    );
    expect(bodyOf(last).meta.retryAfterSeconds).toBeGreaterThan(0);
    expect(bodyOf(last).message).toBe(
      'Too many requests, please wait a moment.',
    );
    expect(last.headers['retry-after']).toBeDefined();
    // B is not affected.
    expect((await get('/customers/me/overview', 'b')).status).toBe(200);
  });
});

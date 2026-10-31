/**
 * Artisan fixes B1–B7 (docs/specs/artisan-fixes/api-contract.md): overview,
 * earnings statement and CSV, analytics 12m, hasApplied, party disputes,
 * bank list, review summary and the masked payout destination. Hermetic:
 * in-memory Postgres; Paystack's bank list is stubbed. Fictional data only.
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
import { PaystackService } from '../src/payments/paystack.service';
import type { ArtisanOverview } from '../src/artisan-insights/artisan-overview.service';
import type { ArtisanStatement } from '../src/payments/artisan-earnings.service';
import type { FilledEarningsPoint } from '../src/analytics/artisan-analytics.service';

jest.setTimeout(120000);

const PREV = {
  insights: process.env.ARTISAN_INSIGHTS_RATE_LIMIT_PER_MINUTE,
  exportLimit: process.env.ARTISAN_EXPORT_RATE_LIMIT_PER_10_MINUTES,
};
process.env.ARTISAN_INSIGHTS_RATE_LIMIT_PER_MINUTE = '100';
process.env.ARTISAN_EXPORT_RATE_LIMIT_PER_10_MINUTES = '3';

const DAY = 86_400_000;
const ymd = (offsetDays: number) =>
  new Date(Date.now() + offsetDays * DAY).toISOString().slice(0, 10);

type Body<T> = {
  message: string;
  data: T;
  meta: { error?: string; pagination?: unknown };
};
const body = <T = Record<string, unknown>>(res: { body: unknown }) =>
  res.body as Body<T>;
type JobRow = { id: number; hasApplied?: boolean };
type DisputeRow = { id: number; jobId: number | null; responseDue: boolean };

describe('Artisan insights (B1–B7)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  const uniq = Date.now();
  const token: Record<string, string> = {};
  const userId: Record<string, number> = {};
  const profileId: Record<string, number> = {};
  const jobId: Record<string, number> = {};
  const bookingId: Record<string, number> = {};
  const disputeId: Record<string, number> = {};
  let serviceId = 0;
  const listBanks = jest.fn();
  const server = () => app.getHttpServer();
  const get = (path: string, who = 'K') =>
    request(server())
      .get(`/api/v1${path}`)
      .set({ Authorization: `Bearer ${token[who]}` });

  const job = async (
    label: string,
    status: string,
    artisan: string | null,
    extra: { completion?: boolean; booking?: string; customer?: string } = {},
  ) => {
    const [row] = await dataSource.query<Array<{ id: number }>>(
      `INSERT INTO jobs (customer_id, service_id, title, location, status, accepted_artisan_id, completion_requested_at, booking_id)
       VALUES ($1, $2, $3, 'Osu, Accra', $4, $5, CASE WHEN $6::boolean THEN NOW() END, $7) RETURNING id`,
      [
        userId[extra.customer ?? 'a'],
        serviceId,
        `${label} title`,
        status,
        artisan ? userId[artisan] : null,
        !!extra.completion,
        extra.booking ? bookingId[extra.booking] : null,
      ],
    );
    jobId[label] = row.id;
  };
  const payment = (
    label: string,
    artisan: string,
    status: string,
    amounts: [number, number, number],
    extra: {
      paid?: boolean;
      released?: boolean;
      transferCode?: string;
      refunded?: number;
    } = {},
  ) =>
    dataSource.query(
      `INSERT INTO payments (job_id, customer_id, artisan_profile_id, amount, platform_fee, artisan_amount, status, reference, paid_at, released_at, transfer_code, transfer_reference, refunded_amount)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        jobId[label],
        userId.a,
        profileId[artisan],
        amounts[0],
        amounts[1],
        amounts[2],
        status,
        `AI-${uniq}-${label}`,
        extra.paid ? new Date(Date.now() - DAY) : null,
        extra.released ? new Date() : null,
        extra.transferCode ?? null,
        extra.transferCode ? `TRF-${uniq}-${label}` : null,
        extra.refunded ?? 0,
      ],
    );
  const booking = async (
    label: string,
    artisan: string,
    date: string,
    start: string,
    end: string,
    status: string,
    notes: string | null = null,
  ) => {
    const [row] = await dataSource.query<Array<{ id: number }>>(
      `INSERT INTO bookings (customer_id, artisan_profile_id, service_id, scheduled_date, start_time, end_time, status, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [
        userId.a,
        profileId[artisan],
        serviceId,
        date,
        start,
        end,
        status,
        notes,
      ],
    );
    bookingId[label] = row.id;
  };
  const review = (
    label: string,
    rating: number,
    text: string | null,
    reply: string | null = null,
    status = 'ACTIVE',
  ) =>
    dataSource.query(
      `INSERT INTO reviews (job_id, artisan_profile_id, reviewer_user_id, reviewed_user_id, rating, review, status, artisan_reply)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        jobId[label],
        profileId.K,
        userId.a,
        userId.K,
        rating,
        text,
        status,
        reply,
      ],
    );
  const dispute = async (label: string, booking: string, raiser: string) => {
    const [row] = await dataSource.query<Array<{ id: number }>>(
      `INSERT INTO disputes (booking_id, raised_by_id, reason, status, category)
       VALUES ($1, $2, 'The work was not finished as agreed.', 'OPEN', 'OTHER') RETURNING id`,
      [bookingId[booking], userId[raiser]],
    );
    disputeId[label] = row.id;
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
    jest
      .spyOn(PaystackService.prototype, 'listBanks')
      .mockImplementation(listBanks);
    listBanks.mockResolvedValue([
      { code: '280100', name: 'Access Bank', type: 'ghipss', active: true },
      { code: 'MTN', name: 'MTN', type: 'mobile_money', active: true },
      { code: 'GH010100', name: 'Absa Bank Ghana', type: 'ghipss' },
    ]);

    const services: Repository<ServiceEntity> = moduleFixture.get(
      getRepositoryToken(ServiceEntity),
    );
    serviceId = (
      await services.save(
        services.create({
          name: `Artisan Fixes Plumbing ${uniq}`,
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
      profileExtra: Partial<ArtisanProfile> = {},
    ) => {
      const u = await users.save(
        users.create({
          email: `ai-${label.toLowerCase()}-${uniq}@test.jinva.local`,
          username: `ai${label}${uniq}`,
          firstname: first,
          lastname: last,
          role,
          accountVerified: true,
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
              ...profileExtra,
            }),
          )
        ).id;
      }
    };
    await make('a', Role.CUSTOMER, 'Ama', 'Owusu');
    await make('K', Role.ARTISAN, 'Kofi', 'Asante', {
      payoutType: 'mobile_money' as never,
      payoutAccountNumber: '0201231234',
      payoutAccountName: 'Kofi Asante',
      payoutBankCode: 'VOD',
      paystackRecipientCode: `RCP_${uniq}`,
    });
    await make('K2', Role.ARTISAN, 'Akua', 'Sarpong');

    // Jobs K is the accepted artisan on, and their payments.
    await job('released', 'COMPLETED', 'K');
    await payment('released', 'K', 'RELEASED', [600, 60, 540], {
      paid: true,
      released: true,
      transferCode: 'TRF_code_1',
    });
    await job('held', 'IN_PROGRESS', 'K', { completion: true });
    await payment('held', 'K', 'HELD', [500, 50, 450], { paid: true });
    await job('onway', 'IN_PROGRESS', 'K');
    await payment('onway', 'K', 'HELD', [300, 30, 270], {
      paid: true,
      transferCode: 'TRF_code_2',
    });
    await job('stuck', 'COMPLETED', 'K');
    await payment('stuck', 'K', 'PENDING_TRANSFER', [200, 20, 180], {
      paid: true,
    });
    await job('refunded', 'CANCELLED', 'K');
    await payment('refunded', 'K', 'REFUNDED', [100, 10, 90], {
      paid: true,
      refunded: 100,
    });
    await job('unpaid', 'PENDING', 'K');
    await payment('unpaid', 'K', 'PENDING', [400, 40, 360]);
    // Another artisan's money must never appear.
    await job('other', 'COMPLETED', 'K2');
    await payment('other', 'K2', 'RELEASED', [999, 99, 900], {
      paid: true,
      released: true,
    });

    // Open jobs: K applied to one.
    await job('openApplied', 'OPEN', null);
    await job('openFresh', 'OPEN', null);
    await dataSource.query(
      `INSERT INTO job_applications (job_id, artisan_id, status) VALUES ($1, $2, 'PENDING')`,
      [jobId.openApplied, userId.K],
    );

    // Bookings.
    await booking('request', 'K', ymd(2), '09:00', '11:00', 'PENDING', 'Sink');
    await booking('today', 'K', ymd(0), '00:00', '23:59', 'CONFIRMED', 'Gate');
    await booking('later', 'K', ymd(3), '10:00', '12:00', 'CONFIRMED');
    await booking('k2', 'K2', ymd(1), '10:00', '12:00', 'PENDING');
    await job('fromBooking', 'PENDING', 'K', { booking: 'today' });
    await dispute('againstK', 'today', 'a');
    await dispute('byK', 'later', 'K');

    // Reviews of K.
    await review('released', 5, 'Great work, very tidy.');
    await review('stuck', 4.5, null);
    await review('held', 2, 'Late and messy.', 'Sorry, we fixed it.');
    await review('onway', 3, '   ');
    await review('refunded', 1, 'Flagged text', null, 'FLAGGED');
  });

  afterAll(async () => {
    for (const [key, value] of [
      ['ARTISAN_INSIGHTS_RATE_LIMIT_PER_MINUTE', PREV.insights],
      ['ARTISAN_EXPORT_RATE_LIMIT_PER_10_MINUTES', PREV.exportLimit],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    jest.restoreAllMocks();
    await app.close();
  });

  describe('B1 GET /artisans/me/overview', () => {
    it('returns stages, requests, bookings, earnings and disputes for the caller', async () => {
      const res = await get('/artisans/me/overview');
      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('private, no-store');
      const d = body<ArtisanOverview>(res).data;
      expect(d.failedSections).toEqual([]);
      expect(d.stageCounts).toEqual({
        toStart: 2,
        inProgress: 1,
        awaitingClient: 1,
        done: 2,
        closed: 1,
        total: 7,
        applied: 1,
      });
      expect(d.pendingRequests!.total).toBe(1);
      expect(d.pendingRequests!.items[0]).toMatchObject({
        bookingId: bookingId.request,
        clientName: 'Ama Owusu',
        service: { id: serviceId },
        scheduledDate: ymd(2),
        startTime: '09:00',
        endTime: '11:00',
        notes: 'Sink',
        location: null,
      });
      expect(typeof d.pendingRequests!.items[0].respondBy).toBe('string');
      expect(d.nextBooking).toMatchObject({
        bookingId: bookingId.today,
        status: 'CONFIRMED',
        jobId: jobId.fromBooking,
        location: 'Osu, Accra',
        notes: 'Gate',
      });
      expect(d.todayBookings!.map((b) => b.bookingId)).toEqual([
        bookingId.today,
      ]);
      expect(d.earnings).toEqual({
        currency: 'GHS',
        heldForSignOff: '450.00',
        onTheWay: '270.00',
        needsAction: '180.00',
        needsActionCount: 1,
        paidThisMonth: '540.00',
        hasPayoutMethod: true,
      });
      expect(d.disputesNeedingResponse).toBe(1);
      expect(JSON.stringify(d)).not.toContain('@test.jinva.local');
    });

    it('rejects a customer (403) and a stranger param (400); scopes another artisan to their own data', async () => {
      expect((await get('/artisans/me/overview', 'a')).status).toBe(403);
      expect(
        (await get(`/artisans/me/overview?userId=${userId.K2}`)).status,
      ).toBe(400);
      const res = await get('/artisans/me/overview', 'K2');
      expect(res.status).toBe(200);
      const other = body<ArtisanOverview>(res).data;
      expect(other.pendingRequests!.total).toBe(1);
      expect(other.earnings!.hasPayoutMethod).toBe(false);
    });
  });

  describe('B2 earnings statement', () => {
    it('returns period totals, balances, months and only my items', async () => {
      const res = await get('/payments/my-earnings/statement');
      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('private, no-store');
      const d = body<ArtisanStatement>(res).data;
      expect(d.period.key).toBe('12m');
      expect(d.summary).toEqual({
        gross: '1600.00',
        fee: '160.00',
        net: '1440.00',
        jobs: 4,
        paid: '540.00',
        refunded: '90.00',
        refundedCount: 1,
      });
      expect(d.balances).toMatchObject({
        heldForSignOff: '450.00',
        onTheWay: '270.00',
        needsAction: '180.00',
        paidThisMonth: '540.00',
      });
      expect(d.months).toHaveLength(12);
      expect(d.months[11]).toMatchObject({ net: '1440.00', jobs: 4 });
      expect(body(res).meta.pagination).toMatchObject({ total: 6, page: 1 });
      const ids = d.items.map((i) => i.jobId);
      expect(ids).not.toContain(jobId.other);
      const released = d.items.find((i) => i.jobId === jobId.released);
      expect(released).toMatchObject({
        gross: '600.00',
        fee: '60.00',
        net: '540.00',
        payout: '540.00',
        stage: 'paid',
        clientName: 'Ama Owusu',
        transferReference: `TRF-${uniq}-released`,
      });
      const refunded = d.items.find((i) => i.jobId === jobId.refunded);
      expect(refunded).toMatchObject({ payout: null, stage: 'refunded' });
      const text = JSON.stringify(res.body);
      expect(text).not.toContain('TRF_code');
      expect(text).not.toContain('RCP_');
      expect(text).not.toContain('@test.jinva.local');
    });

    it('filters items by stage and paginates', async () => {
      const res = await get(
        '/payments/my-earnings/statement?stage=needs_action,on_the_way&limit=1&page=2',
      );
      expect(res.status).toBe(200);
      expect(body(res).meta.pagination).toEqual({
        page: 2,
        limit: 1,
        total: 2,
        totalPages: 2,
      });
      expect(body<ArtisanStatement>(res).data.items).toHaveLength(1);
      const stuck = await get(
        '/payments/my-earnings/statement?stage=needs_action',
      );
      expect(body<ArtisanStatement>(stuck).data.items[0]).toMatchObject({
        stage: 'needs_action',
        failureReason: 'no_payout_method',
      });
    });

    it.each([
      '?period=7d',
      '?stage=escrow',
      '?limit=500',
      `?artisanProfileId=${1}`,
    ])('rejects %s with 400', async (q) => {
      expect((await get(`/payments/my-earnings/statement${q}`)).status).toBe(
        400,
      );
    });

    it('is artisan-only', async () => {
      expect((await get('/payments/my-earnings/statement', 'a')).status).toBe(
        403,
      );
    });

    it('exports a formula-safe CSV, then rate-limits the export', async () => {
      const res = await get('/payments/my-earnings/export.csv?period=all');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/csv');
      expect(res.headers['content-disposition']).toMatch(
        /attachment; filename="jinva-earnings-\d{4}-\d{2}-\d{2}\.csv"/,
      );
      const lines = res.text
        .replace(/^\ufeff/, '')
        .trim()
        .split('\r\n');
      expect(lines[0]).toBe(
        'Date,Job,Client,Status,Paid by client (GHS),Platform fee (GHS),Your payout (GHS),Refunded to client (GHS),Transfer reference,Client paid,Paid out',
      );
      expect(lines).toHaveLength(7);
      expect(res.text).not.toContain('other title');

      await get('/payments/my-earnings/export.csv');
      await get('/payments/my-earnings/export.csv');
      const limited = await get('/payments/my-earnings/export.csv');
      expect(limited.status).toBe(429);
      expect(body(limited).meta.error).toBe(
        'ARTISAN_EXPORT_RATE_LIMIT_EXCEEDED',
      );
    });
  });

  it('B2 profile carries a masked payout destination', async () => {
    const res = await get('/users/me/artisan-profile');
    expect(res.status).toBe(200);
    expect(body(res).data.payoutDestination).toEqual({
      type: 'mobile_money',
      label: 'Telecel Cash',
      last4: '1234',
      accountName: 'Kofi Asante',
    });
    expect(JSON.stringify(res.body)).not.toContain('0201231234');
    expect(JSON.stringify(res.body)).not.toContain('RCP_');
  });

  it('B3 GET /analytics/artisan?range=12m is zero-filled and private', async () => {
    const res = await get('/analytics/artisan?range=12m');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('private, no-store');
    const filled = body<{ series: { earningsFilled: FilledEarningsPoint[] } }>(
      res,
    ).data.series.earningsFilled;
    expect(filled).toHaveLength(12);
    expect(filled[11]).toMatchObject({ net: '540.00', payouts: 1 });
    expect((await get('/analytics/artisan?range=1y')).status).toBe(400);
  });

  it('B4 hasApplied on the job list and detail for an artisan only', async () => {
    const list = await get('/jobs?status=OPEN&limit=50');
    expect(list.status).toBe(200);
    const byId = new Map(
      body<JobRow[]>(list).data.map((j) => [j.id, j.hasApplied] as const),
    );
    expect(byId.get(jobId.openApplied)).toBe(true);
    expect(byId.get(jobId.openFresh)).toBe(false);
    const detail = await get(`/jobs/${jobId.openApplied}`);
    expect(body<JobRow>(detail).data.hasApplied).toBe(true);
    const asCustomer = await get(`/jobs/${jobId.openApplied}`, 'a');
    expect(body(asCustomer).data).not.toHaveProperty('hasApplied');
  });

  it('B5 party disputes carry jobId and responseDue; others get 404', async () => {
    const res = await get('/disputes/my');
    expect(res.status).toBe(200);
    const rows = body<DisputeRow[]>(res).data;
    expect(rows.find((r) => r.id === disputeId.againstK)).toMatchObject({
      jobId: jobId.fromBooking,
      responseDue: true,
    });
    expect(rows.find((r) => r.id === disputeId.byK)).toMatchObject({
      jobId: null,
      responseDue: false,
    });
    const due = await get('/disputes/my?responseDue=true');
    expect(body<DisputeRow[]>(due).data.map((r) => r.id)).toEqual([
      disputeId.againstK,
    ]);
    expect((await get('/disputes/my?responseDue=yes')).status).toBe(400);
    const one = await get(`/disputes/my/${disputeId.againstK}`);
    expect(body<DisputeRow>(one).data.jobId).toBe(jobId.fromBooking);
    expect((await get(`/disputes/my/${disputeId.againstK}`, 'K2')).status).toBe(
      404,
    );
  });

  it('B6 GET /payments/banks serves the cached Ghana bank list', async () => {
    const res = await get('/payments/banks');
    expect(res.status).toBe(200);
    expect(body(res).data).toEqual([
      { code: 'GH010100', name: 'Absa Bank Ghana' },
      { code: '280100', name: 'Access Bank' },
    ]);
    await get('/payments/banks');
    expect(listBanks).toHaveBeenCalledTimes(1);
    expect((await get('/payments/banks', 'a')).status).toBe(403);
    expect((await get('/payments/banks?country=ng')).status).toBe(400);
  });

  it('B7 GET /reviews/me/summary counts ACTIVE reviews from the server', async () => {
    const res = await get('/reviews/me/summary');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(body(res).data).toEqual({
      total: 4,
      average: (3.625).toFixed(2),
      byStar: { '1': 0, '2': 1, '3': 1, '4': 1, '5': 1 },
      fourPlus: 2,
      fourPlusShare: 0.5,
      awaitingReply: 1,
    });
    expect((await get('/reviews/me/summary', 'a')).status).toBe(403);
    const empty = await get('/reviews/me/summary', 'K2');
    expect(body(empty).data).toMatchObject({ total: 0, average: '0.00' });
  });
});

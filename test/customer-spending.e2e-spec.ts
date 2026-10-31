/**
 * Customer experience v2: B2 `GET /analytics/customer`, B3 `GET
 * /payments/history` (both forms), B3f `GET /payments/history/filters` and the
 * B4 index (test plan E-4.1 to E-4.19, E-2.7, SEC-6/T-1, T-2, T-6).
 *
 * The P12-style fixture is built relative to the real clock, and every
 * expected figure is recomputed in this file from the fixture rows by the
 * spend rules, independently of the SQL under test. All people, emails,
 * phone numbers, references and amounts are fictional.
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
import { PaymentStatus, Role } from '@common/types/enums';
import {
  CustomerSpendRange,
  resolveCustomerWindow,
} from '../src/customer-insights/customer-range';
import { AddPaymentsCustomerPaidAtIndex1783270000000 } from '../src/migrations/1783270000000-AddPaymentsCustomerPaidAtIndex';
import { expectNoForbiddenFields } from './support/forbidden-fields';
import type { CustomerSpendingAnalytics } from '../src/customer-insights/customer-analytics.service';
import type { CustomerOverview } from '../src/customer-insights/customer-overview.service';
import type { PaymentHistoryRow } from '../src/payments/customer-payment-history.service';

jest.setTimeout(180000);

const PREV_LIMIT = process.env.CUSTOMER_ANALYTICS_RATE_LIMIT_PER_MINUTE;
process.env.CUSTOMER_ANALYTICS_RATE_LIMIT_PER_MINUTE = '60';

const DAY = 86_400_000;
const COUNTED = [
  'HELD',
  'PENDING_TRANSFER',
  'TRANSFER_FAILED',
  'RELEASED',
  'REFUNDED',
];
const HELD = ['HELD', 'PENDING_TRANSFER', 'TRANSFER_FAILED'];

const SERVICE_NAMES = [
  'Plumbing',
  'Electrical',
  'Cleaning',
  'Carpentry',
  'Painting',
  'Masonry',
  'Tiling',
  'Welding',
];

interface Fixture {
  amount: number;
  refunded?: number;
  status: PaymentStatus;
  channel: string | null;
  svc: number;
  artisan: 'K' | 'K2' | 'D';
  daysAgo: number;
  title?: string;
  reference?: string;
  /** paid_at stays null (never paid). */
  unpaid?: boolean;
}

// P12-style: 19 counted payments across 8 services, plus non-counted rows.
const P12: Fixture[] = [
  {
    amount: 1000,
    status: PaymentStatus.RELEASED,
    channel: 'mobile_money',
    svc: 0,
    artisan: 'K',
    daysAgo: 2,
  },
  {
    amount: 500,
    status: PaymentStatus.HELD,
    channel: 'card',
    svc: 0,
    artisan: 'K',
    daysAgo: 4,
  },
  {
    amount: 300,
    refunded: 300,
    status: PaymentStatus.REFUNDED,
    channel: 'mobile_money',
    svc: 1,
    artisan: 'K2',
    daysAgo: 35,
  },
  {
    amount: 800,
    refunded: 200,
    status: PaymentStatus.RELEASED,
    channel: 'card',
    svc: 1,
    artisan: 'K',
    daysAgo: 70,
  },
  {
    amount: 2400,
    status: PaymentStatus.RELEASED,
    channel: 'card',
    svc: 1,
    artisan: 'K',
    daysAgo: 75,
    title: 'Rewire 3-bedroom flat',
    reference: 'JINVA-7F3K2Q',
  },
  {
    amount: 650,
    status: PaymentStatus.PENDING_TRANSFER,
    channel: 'bank',
    svc: 2,
    artisan: 'K2',
    daysAgo: 40,
  },
  {
    amount: 120,
    status: PaymentStatus.TRANSFER_FAILED,
    channel: null,
    svc: 2,
    artisan: 'K',
    daysAgo: 100,
  },
  {
    amount: 450,
    status: PaymentStatus.RELEASED,
    channel: 'mobile_money',
    svc: 3,
    artisan: 'K',
    daysAgo: 130,
  },
  {
    amount: 600,
    status: PaymentStatus.RELEASED,
    channel: 'mobile_money',
    svc: 4,
    artisan: 'D',
    daysAgo: 160,
  },
  {
    amount: 700,
    status: PaymentStatus.RELEASED,
    channel: 'bank_transfer',
    svc: 5,
    artisan: 'K',
    daysAgo: 190,
  },
  {
    amount: 350,
    status: PaymentStatus.RELEASED,
    channel: 'mobile_money',
    svc: 6,
    artisan: 'K2',
    daysAgo: 220,
  },
  {
    amount: 900,
    refunded: 900,
    status: PaymentStatus.REFUNDED,
    channel: 'card',
    svc: 7,
    artisan: 'K',
    daysAgo: 250,
  },
  {
    amount: 1100,
    status: PaymentStatus.RELEASED,
    channel: 'mobile_money',
    svc: 0,
    artisan: 'K',
    daysAgo: 280,
  },
  {
    amount: 1200,
    status: PaymentStatus.RELEASED,
    channel: 'mobile_money',
    svc: 0,
    artisan: 'K',
    daysAgo: 300,
  },
  {
    amount: 2400,
    status: PaymentStatus.RELEASED,
    channel: 'card',
    svc: 3,
    artisan: 'K2',
    daysAgo: 320,
  },
  {
    amount: 250,
    status: PaymentStatus.RELEASED,
    channel: 'mobile_money',
    svc: 5,
    artisan: 'D',
    daysAgo: 130,
  },
  {
    amount: 150,
    status: PaymentStatus.RELEASED,
    channel: 'card',
    svc: 6,
    artisan: 'K',
    daysAgo: 190,
    title: 'Tiles 50% off_cut',
  },
  {
    amount: 400,
    status: PaymentStatus.HELD,
    channel: 'mobile_money',
    svc: 2,
    artisan: 'K',
    daysAgo: 3,
  },
  {
    amount: 520,
    refunded: 100,
    status: PaymentStatus.RELEASED,
    channel: 'mobile_money',
    svc: 1,
    artisan: 'K',
    daysAgo: 72,
  },
  // Not counted.
  {
    amount: 300,
    status: PaymentStatus.PENDING,
    channel: null,
    svc: 0,
    artisan: 'K',
    daysAgo: 1,
    unpaid: true,
  },
  {
    amount: 200,
    status: PaymentStatus.FAILED,
    channel: 'card',
    svc: 0,
    artisan: 'K',
    daysAgo: 6,
    unpaid: true,
  },
  {
    amount: 150,
    status: PaymentStatus.CANCELLED,
    channel: null,
    svc: 1,
    artisan: 'K2',
    daysAgo: 50,
    unpaid: true,
  },
  // Older than 12 months (counted, for `all` and the previous period).
  {
    amount: 999,
    status: PaymentStatus.RELEASED,
    channel: 'card',
    svc: 0,
    artisan: 'K',
    daysAgo: 420,
  },
];

// P30 for customer C (AC-4.2).
const P30: Fixture[] = [
  {
    amount: 1000,
    status: PaymentStatus.RELEASED,
    channel: 'card',
    svc: 0,
    artisan: 'K',
    daysAgo: 3,
  },
  {
    amount: 500,
    status: PaymentStatus.HELD,
    channel: 'mobile_money',
    svc: 0,
    artisan: 'K',
    daysAgo: 5,
  },
  {
    amount: 300,
    refunded: 300,
    status: PaymentStatus.REFUNDED,
    channel: 'card',
    svc: 1,
    artisan: 'K',
    daysAgo: 8,
  },
  {
    amount: 200,
    status: PaymentStatus.FAILED,
    channel: 'card',
    svc: 1,
    artisan: 'K',
    daysAgo: 9,
    unpaid: true,
  },
];

type Analytics = CustomerSpendingAnalytics;
type Overview = CustomerOverview;
type Rows = PaymentHistoryRow[];
type Filters = {
  services: Array<{ id: number; name: string }>;
  artisans: Array<{ id: number; displayName: string }>;
};

type Body<T> = {
  status: string;
  message: string | string[];
  data: T;
  meta: {
    pagination?: {
      page: number;
      limit: number;
      total: number;
      totalPages: number;
    };
    error?: string;
    retryAfterSeconds?: number;
  };
};

/** A response body with its `data` typed as the documented contract. */
const bodyOf = <T>(res: { body: unknown }): Body<T> => res.body as Body<T>;

const money = (cents: number) => (cents / 100).toFixed(2);
const c = (n: number) => Math.round(n * 100);

describe('Customer spending report and payment history (B2, B3, B3f, B4)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  const uniq = Date.now();
  const now = new Date();
  const token: Record<string, string> = {};
  const userId: Record<string, number> = {};
  const profileId: Record<string, number> = {};
  const serviceIds: number[] = [];
  const rowsByCustomer: Record<
    string,
    Array<Fixture & { id: number; paidAt: Date | null; createdAt: Date }>
  > = {};
  const server = () => app.getHttpServer();
  const as = (who: string) => ({ Authorization: `Bearer ${token[who]}` });
  const get = (path: string, who = 'a') =>
    request(server()).get(`/api/v1${path}`).set(as(who));
  const K_PHONE = '+233240000171';
  const K_EMAIL = `cxs-k-${uniq}@test.jinva.local`;

  async function insertPayments(who: string, fixtures: Fixture[]) {
    rowsByCustomer[who] = [];
    let i = 0;
    for (const f of fixtures) {
      i++;
      const paidAt = f.unpaid
        ? null
        : new Date(now.getTime() - f.daysAgo * DAY);
      const createdAt = new Date(now.getTime() - f.daysAgo * DAY - 3_600_000);
      const jobStatus =
        f.status === PaymentStatus.PENDING ? 'PENDING' : 'COMPLETED';
      const [job] = await dataSource.query<Array<{ id: number }>>(
        `INSERT INTO jobs (customer_id, service_id, title, location, status)
         VALUES ($1, $2, $3, 'Osu, Accra', $4) RETURNING id`,
        [
          userId[who],
          serviceIds[f.svc],
          f.title ?? `${SERVICE_NAMES[f.svc]} job ${who}${i}`,
          jobStatus,
        ],
      );
      const [p] = await dataSource.query<Array<{ id: number }>>(
        `INSERT INTO payments (job_id, customer_id, artisan_profile_id, amount, platform_fee, artisan_amount,
           currency, status, reference, channel, refunded_amount, paid_at, released_at, created_at,
           transfer_code, transfer_reference, access_code, authorization_url, fraud_flagged, fraud_flag_reason)
         VALUES ($1,$2,$3,$4,$5,$6,'GHS',$7,$8,$9,$10,$11,$12,$13,'TRF_fake','TRR_fake','ACC_fake','https://checkout.example/x', true, 'fictional flag')
         RETURNING id`,
        [
          job.id,
          userId[who],
          profileId[f.artisan],
          f.amount,
          f.amount * 0.1,
          f.amount * 0.9,
          f.status,
          f.reference ?? `CXS-${uniq}-${who}-${i}`,
          f.channel,
          f.refunded ?? 0,
          paidAt,
          f.status === PaymentStatus.RELEASED && paidAt
            ? new Date(paidAt.getTime() + DAY)
            : null,
          createdAt,
        ],
      );
      rowsByCustomer[who].push({ ...f, id: p.id, paidAt, createdAt });
    }
  }

  /** The spend rules, in plain JS, over the fixture rows. */
  function expected(who: string, range: CustomerSpendRange) {
    const w = resolveCustomerWindow(range, now);
    const dated = rowsByCustomer[who].map((r) => ({
      ...r,
      date: r.paidAt ?? r.createdAt,
    }));
    const counted = dated.filter((r) => COUNTED.includes(r.status));
    const inWin = counted.filter(
      (r) => (!w.from || r.date >= w.from) && r.date <= now,
    );
    const net = (r: Fixture) => c(r.amount) - c(r.refunded ?? 0);
    const gross = inWin.reduce((s, r) => s + c(r.amount), 0);
    const refunded = inWin.reduce((s, r) => s + c(r.refunded ?? 0), 0);
    const prev = w.previous
      ? counted
          .filter((r) => r.date >= w.previous!.from && r.date < w.previous!.to)
          .reduce((s, r) => s + net(r), 0)
      : null;
    return {
      inWin,
      net,
      totals: {
        netSpent: money(gross - refunded),
        grossPaid: money(gross),
        refunded: money(refunded),
        held: money(
          counted
            .filter((r) => HELD.includes(r.status))
            .reduce((s, r) => s + net(r), 0),
        ),
        released: money(
          inWin
            .filter((r) => r.status === PaymentStatus.RELEASED)
            .reduce((s, r) => s + net(r), 0),
        ),
        paymentsCount: inWin.length,
        avgPayment: money(
          inWin.length ? Math.round((gross - refunded) / inWin.length) : 0,
        ),
        previousPeriodNetSpent: prev === null ? null : money(prev),
      },
    };
  }

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
    for (const name of SERVICE_NAMES) {
      serviceIds.push(
        (
          await services.save(
            services.create({
              name: `${name} ${uniq}`,
              estimatedDurationMins: 60,
            }),
          )
        ).id,
      );
    }

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
          email: `cxs-${label.toLowerCase()}-${uniq}@test.jinva.local`,
          username: `cxs${label}${uniq}`,
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
              location: 'Tema, Greater Accra',
              currency: 'GHS',
              isProfileComplete: true,
              payoutAccountName: 'Kofi Asante',
              payoutAccountNumber: '0240000999',
              paystackRecipientCode: 'RCP_fictional',
            }),
          )
        ).id;
      }
    };
    await make('a', Role.CUSTOMER, 'Ama', 'Owusu');
    await make('b', Role.CUSTOMER, 'Kwame', 'Boateng');
    await make('c', Role.CUSTOMER, 'Abena', 'Mensah');
    await make('n', Role.CUSTOMER, 'Esi', 'Nyarko');
    await make('t', Role.CUSTOMER, 'Kojo', 'Addo');
    await make('K', Role.ARTISAN, 'Kofi', 'Asante', { phoneNumber: K_PHONE });
    await make('K2', Role.ARTISAN, 'Akua', 'Sarpong');
    await make('D', Role.ARTISAN, 'Yaw', 'Ofori');
    await make('admin', Role.ADMIN, 'Efua', 'Badu');
    await dataSource.query(`UPDATE users SET email = $1 WHERE id = $2`, [
      K_EMAIL,
      userId.K,
    ]);

    await insertPayments('a', P12);
    await insertPayments('c', P30);
    // B paid for Plumbing with artisan K2, and has a held payment.
    await insertPayments('b', [
      {
        amount: 4321,
        status: PaymentStatus.RELEASED,
        channel: 'card',
        svc: 0,
        artisan: 'K2',
        daysAgo: 10,
      },
      {
        amount: 777,
        status: PaymentStatus.HELD,
        channel: 'card',
        svc: 0,
        artisan: 'K2',
        daysAgo: 1,
      },
    ]);
    // D is a deleted artisan (FR-4.19).
    await dataSource.query(
      `UPDATE users SET deleted_at = NOW() WHERE id = $1`,
      [userId.D],
    );
  });

  afterAll(async () => {
    if (PREV_LIMIT === undefined)
      delete process.env.CUSTOMER_ANALYTICS_RATE_LIMIT_PER_MINUTE;
    else process.env.CUSTOMER_ANALYTICS_RATE_LIMIT_PER_MINUTE = PREV_LIMIT;
    await app.close();
  });

  describe('B2 spending analytics', () => {
    it('E-4.1 P30: totals, 30 daily buckets, FAILED not counted', async () => {
      const res = await get('/analytics/customer?range=30d', 'c');
      expect(res.status).toBe(200);
      const d = bodyOf<Analytics>(res).data;
      expect(bodyOf<unknown>(res).message).toBe('Spending analytics retrieved');
      expect(res.headers['cache-control']).toBe('private, no-store');
      expect(d.range).toBe('30d');
      expect(d.bucket).toBe('day');
      expect(d.currency).toBe('GHS');
      expect(d.hasPaymentsEver).toBe(true);
      expect(d.totals).toMatchObject({
        netSpent: '1500.00',
        held: '500.00',
        refunded: '300.00',
        grossPaid: '1800.00',
        paymentsCount: 3,
        avgPayment: '500.00',
        released: '1000.00',
      });
      expect(d.series).toHaveLength(30);
      const seriesNet = d.series.reduce(
        (s: number, b) => s + c(Number(b.netSpent)),
        0,
      );
      expect(money(seriesNet)).toBe('1500.00');
      expect(d.series[29].bucketStart).toBe(now.toISOString().slice(0, 10));
    });

    it('E-4.2 P12 12m: totals, 12 ordered months, categories, channels, largest payment, previous period', async () => {
      const res = await get('/analytics/customer?range=12m');
      expect(res.status).toBe(200);
      const d = bodyOf<Analytics>(res).data;
      const exp = expected('a', '12m');
      expect(d.totals).toEqual(exp.totals);
      expect(d.bucket).toBe('month');
      expect(d.series).toHaveLength(12);
      const starts = d.series.map((s) => s.bucketStart);
      expect([...starts].sort()).toEqual(starts);
      expect(starts.every((s: string) => s.endsWith('-01'))).toBe(true);
      // Each month equals the JS bucketing of the fixture.
      for (const s of d.series as Array<{
        bucketStart: string;
        netSpent: string;
        count: number;
      }>) {
        const inMonth = exp.inWin.filter(
          (r) =>
            (r.paidAt ?? r.createdAt).toISOString().slice(0, 7) ===
            s.bucketStart.slice(0, 7),
        );
        expect(s.count).toBe(inMonth.length);
        expect(s.netSpent).toBe(
          money(inMonth.reduce((t, r) => t + exp.net(r), 0)),
        );
      }
      // 8 services → top 6 + "Other"; shares sum to 1.
      expect(d.byCategory).toHaveLength(7);
      expect(d.byCategory[6]).toMatchObject({
        serviceId: null,
        serviceName: 'Other',
      });
      const shareSum = d.byCategory.reduce((s: number, x) => s + x.share, 0);
      expect(Math.abs(shareSum - 1)).toBeLessThanOrEqual(0.002);
      const catNet = d.byCategory.reduce(
        (s: number, x) => s + c(Number(x.netSpent)),
        0,
      );
      expect(money(catNet)).toBe(exp.totals.netSpent);
      // Channels: bank_transfer folds into bank, null into other.
      const channels = d.byChannel.map((x) => x.channel).sort();
      expect(channels).toEqual(['bank', 'card', 'mobile_money', 'other']);
      // Largest: 2400 twice; the more recent wins.
      const largestFixture = exp.inWin.find(
        (r) => r.reference === 'JINVA-7F3K2Q',
      )!;
      expect(d.largestPayment).toMatchObject({
        id: largestFixture.id,
        jobTitle: 'Rewire 3-bedroom flat',
        amount: '2400.00',
      });
      expect(new Date(d.largestPayment!.paidAt).getTime()).toBe(
        largestFixture.paidAt!.getTime(),
      );
      expect(d.totals.previousPeriodNetSpent).toBe('999.00');
    });

    it('E-4.3 all: monthly from the first paid month, no previous period', async () => {
      const d = bodyOf<Analytics>(
        await get('/analytics/customer?range=all'),
      ).data;
      const exp = expected('a', 'all');
      expect(d.period.from).toBeNull();
      expect(d.totals).toEqual(exp.totals);
      const first = new Date(now.getTime() - 420 * DAY)
        .toISOString()
        .slice(0, 7);
      expect(d.series[0].bucketStart).toBe(`${first}-01`);
      expect(d.series[d.series.length - 1].bucketStart).toBe(
        `${now.toISOString().slice(0, 7)}-01`,
      );
      expect(d.totals.previousPeriodNetSpent).toBeNull();
    });

    it('90d uses Monday weeks covering the window', async () => {
      const d = bodyOf<Analytics>(
        await get('/analytics/customer?range=90d'),
      ).data;
      expect(d.bucket).toBe('week');
      expect(d.series.length).toBeGreaterThanOrEqual(13);
      expect(d.series.length).toBeLessThanOrEqual(14);
      for (const s of d.series)
        expect(new Date(`${s.bucketStart}T00:00:00Z`).getUTCDay()).toBe(1);
      expect(d.totals).toEqual(expected('a', '90d').totals);
    });

    it('a customer who never paid gets hasPaymentsEver false and empty all-time series', async () => {
      const d = bodyOf<Analytics>(
        await get('/analytics/customer?range=all', 'n'),
      ).data;
      expect(d.hasPaymentsEver).toBe(false);
      expect(d.series).toEqual([]);
      expect(d.largestPayment).toBeNull();
      expect(d.totals.avgPayment).toBe('0.00');
      const m = bodyOf<Analytics>(await get('/analytics/customer', 'n')).data;
      expect(m.series).toHaveLength(12);
    });

    it('E-4.4 validates range; no range is 12m', async () => {
      for (const r of ['7d', '1y', 'foo', '12M', '']) {
        expect({
          r,
          s: (await get(`/analytics/customer?range=${r}`)).status,
        }).toEqual({ r, s: 400 });
      }
      const res = await get('/analytics/customer');
      expect(res.status).toBe(200);
      expect(bodyOf<Analytics>(res).data.range).toBe('12m');
    });

    it("E-4.5 owner parameters are refused and B's data never appears", async () => {
      expect(
        (await get(`/analytics/customer?customerId=${userId.b}`)).status,
      ).toBe(400);
      expect((await get(`/analytics/customer?userId=${userId.b}`)).status).toBe(
        400,
      );
      const text = JSON.stringify(
        bodyOf<Analytics>(await get('/analytics/customer?range=all')),
      );
      expect(text).not.toContain('4321');
      expect(text).not.toContain('777.00');
    });

    it('E-4.9 (deleted artisan) shows D as "Former artisan" with no id or avatar, one row each', async () => {
      const d = bodyOf<Analytics>(
        await get('/analytics/customer?range=12m'),
      ).data;
      const former = d.byArtisan.filter(
        (x) => x.displayName === 'Former artisan',
      );
      expect(former).toHaveLength(1);
      expect(former[0]).toMatchObject({
        artisanProfileId: null,
        avatar: null,
        netSpent: '850.00',
        count: 2,
      });
      const k = d.byArtisan.find((x) => x.artisanProfileId === profileId.K);
      expect(k!.displayName).toBe('Kofi Asante');
    });
  });

  describe('B3 payment history', () => {
    it("E-4.9 legacy form: unpaginated array, today's keys plus the new ones, created_at order", async () => {
      const res = await get('/payments/history');
      expect(res.status).toBe(200);
      const body = bodyOf<Rows>(res);
      expect(body.message).toBe('Payment history retrieved.');
      expect(body.meta.pagination).toBeUndefined();
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.data).toHaveLength(P12.length);
      for (const key of [
        'id',
        'reference',
        'jobId',
        'job',
        'amount',
        'currency',
        'status',
        'refundedAmount',
        'paidAt',
        'releasedAt',
        'date',
        'bookingId',
        'service',
        'artisan',
        'netAmount',
        'channel',
      ]) {
        expect(body.data[0]).toHaveProperty(key);
      }
      const dates = body.data.map((r) => new Date(r.date).getTime());
      expect([...dates].sort((x, y) => y - x)).toEqual(dates);
      expectNoForbiddenFields(body, {
        forbiddenValues: [K_PHONE, K_EMAIL, '0240000999'],
      });
    });

    it('E-4.10 paginated: newest paid first, correct totals, no duplicates', async () => {
      const p1 = bodyOf<Rows>(await get('/payments/history?page=1&limit=20'));
      const p2 = bodyOf<Rows>(await get('/payments/history?page=2&limit=20'));
      expect(p1.message).toBe('Payment history retrieved');
      expect(p1.meta.pagination).toEqual({
        page: 1,
        limit: 20,
        total: P12.length,
        totalPages: 2,
      });
      expect(p1.data).toHaveLength(20);
      expect(p2.data).toHaveLength(P12.length - 20);
      const all = [...p1.data, ...p2.data];
      expect(new Set(all.map((r) => r.id)).size).toBe(P12.length);
      const keys = all.map((r) => new Date(r.paidAt ?? r.date).getTime());
      expect([...keys].sort((x, y) => y - x)).toEqual(keys);
      const row = all.find((r) => r.reference === 'JINVA-7F3K2Q');
      expect(row).toMatchObject({
        amount: '2400.00',
        refundedAmount: '0.00',
        netAmount: '2400.00',
        channel: 'card',
        status: 'RELEASED',
        service: { id: serviceIds[1], name: `Electrical ${uniq}` },
        artisan: { id: profileId.K, displayName: 'Kofi Asante', avatar: null },
        job: { title: 'Rewire 3-bedroom flat' },
        bookingId: null,
      });
      expectNoForbiddenFields(p1, {
        forbiddenValues: [K_PHONE, K_EMAIL, '0240000999'],
      });
    });

    it("E-4.11 / E-4.16 filters by service, never widening to B's rows", async () => {
      const res = bodyOf<Rows>(
        await get(`/payments/history?serviceId=${serviceIds[0]}&limit=100`),
      );
      const plumbing = P12.filter((f) => f.svc === 0).length;
      expect(res.meta.pagination?.total).toBe(plumbing);
      expect(res.data.every((r) => r.service.id === serviceIds[0])).toBe(true);
      expect(JSON.stringify(res)).not.toContain('4321');
    });

    it('E-4.12 filters by several statuses', async () => {
      const res = bodyOf<Rows>(
        await get('/payments/history?status=REFUNDED,FAILED'),
      );
      expect(res.data.map((r) => r.status).sort()).toEqual([
        'FAILED',
        'REFUNDED',
        'REFUNDED',
      ]);
    });

    it('E-4.13 filters by artisan; an artisan never paid gives an empty page', async () => {
      const res = bodyOf<Rows>(
        await get(
          `/payments/history?artisanProfileId=${profileId.K2}&limit=100`,
        ),
      );
      expect(res.data.length).toBe(
        P12.filter((f) => f.artisan === 'K2').length,
      );
      expect(res.data.every((r) => r.artisan.id === profileId.K2)).toBe(true);
      const none = await get(`/payments/history?artisanProfileId=999999`);
      expect(none.status).toBe(200);
      expect(bodyOf<Rows>(none).data).toEqual([]);
    });

    it('E-4.14 search matches title and reference; % and _ are literal; injection is inert', async () => {
      const s = async (q: string) =>
        bodyOf<Rows>(
          await get(`/payments/history?search=${encodeURIComponent(q)}`),
        ).data as Array<{ reference: string; job: { title: string } }>;
      expect((await s('rewire')).map((r) => r.reference)).toEqual([
        'JINVA-7F3K2Q',
      ]);
      expect((await s('JINVA-7F3K')).map((r) => r.reference)).toEqual([
        'JINVA-7F3K2Q',
      ]);
      expect((await s('%')).map((r) => r.job.title)).toEqual([
        'Tiles 50% off_cut',
      ]);
      expect((await s('_')).map((r) => r.job.title)).toEqual([
        'Tiles 50% off_cut',
      ]);
      const inj = await get(
        `/payments/history?search=${encodeURIComponent("' OR 1=1 --")}`,
      );
      expect(inj.status).toBe(200);
      expect(bodyOf<Rows>(inj).data).toEqual([]);
    });

    it('E-4.15 / BU-4.13 refuses bad filters', async () => {
      for (const q of [
        'from=2024-01-01&to=2026-10-30',
        'from=2026-10-30&to=2026-01-01',
        'limit=101',
        'page=0',
        'page=1001',
        `search=${'x'.repeat(101)}`,
        'search=',
        'status=HELD,FOO',
        'serviceId=abc',
        'artisanProfileId=0',
        'range=12m&from=2026-01-01',
        'range=7d',
        'from=2026-02-30',
        'from=30-10-2026',
        'sort=amount',
        `customerId=${userId.b}`,
      ]) {
        expect({ q, s: (await get(`/payments/history?${q}`)).status }).toEqual({
          q,
          s: 400,
        });
      }
    });

    it('filters by range and by an inclusive from/to window', async () => {
      const r30 = bodyOf<Rows>(
        await get('/payments/history?range=30d&limit=100'),
      );
      const w = resolveCustomerWindow('30d', now);
      const exp30 = rowsByCustomer.a.filter(
        (r) => (r.paidAt ?? r.createdAt) >= w.from!,
      );
      expect(r30.meta.pagination?.total).toBe(exp30.length);
      const day = new Date(now.getTime() - 75 * DAY).toISOString().slice(0, 10);
      const one = bodyOf<Rows>(
        await get(`/payments/history?from=${day}&to=${day}`),
      );
      expect(one.data.map((r) => r.reference)).toContain('JINVA-7F3K2Q');
    });

    it('E-4.17 a deleted artisan shows as "Former artisan" with no id', async () => {
      const res = bodyOf<Rows>(await get(`/payments/history?limit=100`));
      const rows = res.data.filter(
        (r) => r.artisan.displayName === 'Former artisan',
      );
      expect(rows).toHaveLength(2);
      expect(
        rows.every((r) => r.artisan.id === null && r.artisan.avatar === null),
      ).toBe(true);
    });

    it('E-4.6 the history and analytics are customer-only', async () => {
      for (const path of [
        '/payments/history?page=1',
        '/analytics/customer',
        '/payments/history/filters',
      ]) {
        expect((await get(path, 'K')).status).toBe(403);
        expect((await get(path, 'admin')).status).toBe(403);
        expect((await request(server()).get(`/api/v1${path}`)).status).toBe(
          401,
        );
      }
    });
  });

  describe('B3f filter options', () => {
    it("lists only the caller's services and live artisans, sorted by name", async () => {
      const res = await get('/payments/history/filters');
      expect(res.status).toBe(200);
      const d = bodyOf<Filters>(res).data;
      expect(bodyOf<unknown>(res).message).toBe(
        'Payment history filters retrieved',
      );
      expect(
        d.services.map((s) => s.id).sort((x: number, y: number) => x - y),
      ).toEqual([...serviceIds].sort((x, y) => x - y));
      const names = d.services.map((s) => s.name);
      expect([...names].sort()).toEqual(names);
      expect(d.artisans).toEqual([
        { id: profileId.K2, displayName: 'Akua Sarpong' },
        { id: profileId.K, displayName: 'Kofi Asante' },
      ]);
      expectNoForbiddenFields(res.body, {
        forbiddenValues: [K_PHONE, K_EMAIL],
      });
    });

    it("B sees only B's own options", async () => {
      const d = bodyOf<Filters>(
        await get('/payments/history/filters', 'b'),
      ).data;
      expect(d.services).toEqual([
        { id: serviceIds[0], name: `Plumbing ${uniq}` },
      ]);
      expect(d.artisans).toEqual([
        { id: profileId.K2, displayName: 'Akua Sarpong' },
      ]);
      expect(
        (await get(`/payments/history/filters?customerId=${userId.a}`, 'b'))
          .status,
      ).toBe(400);
    });
  });

  describe('B2 and B6 agree (E-2.7, E-4.19)', () => {
    it('overview this month and held equal the analytics October bucket and held total', async () => {
      const overview = bodyOf<Overview>(
        await get('/customers/me/overview'),
      ).data;
      const analytics = bodyOf<Analytics>(
        await get('/analytics/customer?range=12m'),
      ).data;
      const spend = overview.spend!;
      const current = analytics.series[analytics.series.length - 1];
      const previous = analytics.series[analytics.series.length - 2];
      expect(spend.thisMonth).toBe(current.netSpent);
      expect(spend.lastMonth).toBe(previous.netSpent);
      expect(spend.held).toBe(analytics.totals.held);
      expect(spend.held).toBe('1670.00');
      expect(spend.last6Months.map((m) => m.netSpent)).toEqual(
        analytics.series.slice(-6).map((s) => s.netSpent),
      );
    });
  });

  it('E-4.7 / T-2 no forbidden keys or artisan contact details in analytics', async () => {
    for (const range of ['30d', '90d', '12m', 'all']) {
      const res = await get(`/analytics/customer?range=${range}`);
      expectNoForbiddenFields(res.body, {
        forbiddenValues: [K_PHONE, K_EMAIL, '0240000999', 'RCP_fictional'],
      });
    }
  });

  it('E-4.18 / P-7 the payments(customer_id, paid_at) index exists and its migration reverses cleanly', async () => {
    const find = () =>
      dataSource.query<Array<{ indexdef: string }>>(
        `SELECT indexdef FROM pg_indexes WHERE tablename = 'payments' AND indexname = 'idx_payments_customer_id_paid_at'`,
      );
    const [row] = await find();
    expect(row.indexdef).toMatch(/\(customer_id, paid_at\)/);
    const migration = new AddPaymentsCustomerPaidAtIndex1783270000000();
    const runner = dataSource.createQueryRunner();
    try {
      await migration.down(runner);
      expect(await find()).toHaveLength(0);
      await migration.up(runner);
      await migration.up(runner); // idempotent
      expect(await find()).toHaveLength(1);
    } finally {
      await runner.release();
    }
  });

  it('E-4.8 / T-6 per-user, per-route buckets on customer-analytics, legacy history unthrottled', async () => {
    let last = await get('/analytics/customer?range=30d', 't');
    for (let i = 0; i < 60 && last.status === 200; i++) {
      last = await get('/analytics/customer?range=30d', 't');
    }
    expect(last.status).toBe(429);
    expect(bodyOf<unknown>(last).meta.error).toBe(
      'CUSTOMER_ANALYTICS_RATE_LIMIT_EXCEEDED',
    );
    expect(bodyOf<unknown>(last).message).toBe(
      'Too many requests, please wait a moment.',
    );
    expect(Number(last.headers['retry-after'])).toBeGreaterThan(0);
    // Same user, other routes: separate buckets.
    expect((await get('/customers/me/overview', 't')).status).toBe(200);
    expect((await get('/payments/history?page=1', 't')).status).toBe(200);
    // Same route, other user: separate bucket.
    expect((await get('/analytics/customer?range=30d', 'n')).status).toBe(200);

    // The paginated history is throttled, the legacy form never is.
    let h = await get('/payments/history?page=1', 't');
    for (let i = 0; i < 60 && h.status === 200; i++)
      h = await get('/payments/history?page=1', 't');
    expect(h.status).toBe(429);
    for (let i = 0; i < 3; i++)
      expect((await get('/payments/history', 't')).status).toBe(200);
  });
});

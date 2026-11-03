import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { ResponseInterceptor } from '../src/common/interceptors/response.interceptor';
import { User } from '@users/entities/user.entity';
import { ArtisanProfile } from '@users/entities/artisan-profile.entity';
import { UserTokenService } from '@users/token.service';
import { AdminInsightsService } from '../src/analytics/admin-insights.service';
import { percentileCont } from '../src/analytics/insights.util';
import { AnalyticsRange, Role } from '@common/types/enums';

/**
 * Admin platform insights (`GET /admin/analytics/insights`) against a real
 * (PGlite) database.
 *
 * The numbers are asserted on a small fictional dataset placed entirely in
 * June 2001, and computed by calling the service with "now" = 30 Jun 2001
 * 12:00 UTC. Every range-scoped figure only counts rows inside that window,
 * and every snapshot figure only counts rows that existed by then, so data
 * other suites create (always "today") cannot change a single number here.
 * The HTTP tests cover the guards, the headers, the envelope and the shape.
 *
 * Also pins the key set of the existing `GET /admin/analytics` response, so
 * adding insights can never rename or drop one of its fields.
 *
 * All names, emails and figures are made up. Everything is removed in afterAll.
 */
jest.setTimeout(180000);

const NOW = new Date('2001-06-30T12:00:00.000Z');
const T = (day: string, time = '10:00') => `2001-${day} ${time}:00`;

type Insights = Awaited<ReturnType<AdminInsightsService['build']>>;

describe('Admin platform insights (e2e)', () => {
  let app: INestApplication<App>;
  let db: DataSource;
  let userRepo: Repository<User>;
  let profileRepo: Repository<ArtisanProfile>;
  let tokens: UserTokenService;
  let insights: AdminInsightsService;

  const uniq = Date.now();
  const userIds: number[] = [];
  const serviceIds: number[] = [];
  const reviewIds: number[] = [];
  let adminToken: string;
  let customerToken: string;
  let artisanToken: string;
  let result: Insights;

  const server = () => app.getHttpServer();
  const sql = (text: string, params: unknown[] = []) =>
    db.query<Array<Record<string, unknown>>>(text, params);

  /** INSERT … RETURNING id, with one bound parameter per column. */
  async function ins(table: string, row: Record<string, unknown>) {
    const cols = Object.keys(row);
    const rows = await sql(
      `INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(', ')})
       VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
      cols.map((c) => row[c]),
    );
    return Number(rows[0].id);
  }

  async function makeUser(
    label: string,
    role: Role,
    createdAt: string,
    extra: Partial<User> = {},
  ): Promise<User> {
    const user = await userRepo.save(
      userRepo.create({
        email: `qa-ins-${label}-${uniq}@test.jinva.local`,
        password: null,
        firstname: 'QaIns',
        lastname: label,
        role,
        accountVerified: true,
        isBanned: false,
        isSuspended: false,
        ...extra,
      }),
    );
    userIds.push(user.id);
    await sql(`UPDATE users SET created_at = $1 WHERE id = $2`, [
      createdAt,
      user.id,
    ]);
    return user;
  }

  async function token(user: User) {
    return (await tokens.createJWTTokens(user)).access_token;
  }

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalInterceptors(new ResponseInterceptor());
    app.setGlobalPrefix('api/v1', { exclude: ['/'] });
    await app.init();

    db = moduleFixture.get(DataSource);
    userRepo = moduleFixture.get(getRepositoryToken(User));
    profileRepo = moduleFixture.get(getRepositoryToken(ArtisanProfile));
    tokens = moduleFixture.get(UserTokenService);
    insights = moduleFixture.get(AdminInsightsService);

    // Callers for the HTTP checks (created today; they never count in 2001).
    const admin = await makeUser('Admin', Role.ADMIN, '2026-01-01 00:00:00');
    adminToken = await token(admin);
    customerToken = await token(
      await makeUser('Caller', Role.CUSTOMER, '2026-01-01 00:00:00'),
    );
    artisanToken = await token(
      await makeUser('CallerArt', Role.ARTISAN, '2026-01-01 00:00:00'),
    );

    // ── Services ──────────────────────────────────────────────────────────
    const svc = async (name: string) => {
      const id = await ins('services', {
        name: `QA Insights ${name} ${uniq}`,
        estimated_duration_mins: 60,
      });
      serviceIds.push(id);
      return id;
    };
    const S1 = await svc('Plumbing');
    const S2 = await svc('Tiling');
    const S3 = await svc('Roofing');

    // ── People ────────────────────────────────────────────────────────────
    const C1 = await makeUser('C1', Role.CUSTOMER, T('04-10'));
    const C2 = await makeUser('C2', Role.CUSTOMER, T('04-20'));
    const C3 = await makeUser('C3', Role.CUSTOMER, T('06-01', '08:00'));
    const C4 = await makeUser('C4', Role.CUSTOMER, T('06-02', '08:00'));
    const C5 = await makeUser('C5', Role.CUSTOMER, T('06-03', '08:00'));
    const C6 = await makeUser('C6', Role.CUSTOMER, T('06-04', '08:00'), {
      isSuspended: true,
    });
    await sql(`UPDATE users SET suspended_at = $1 WHERE id = $2`, [
      T('06-20'),
      C6.id,
    ]);
    const AD = await makeUser('Staff', Role.ADMIN, T('01-01'));

    const A1 = await makeUser('A1', Role.ARTISAN, T('03-01'));
    const A2 = await makeUser('A2', Role.ARTISAN, T('03-01'));
    const A3 = await makeUser('A3', Role.ARTISAN, T('03-01'));
    await makeUser('A4', Role.ARTISAN, T('03-01')); // no profile at all

    const profile = async (user: User, p: Partial<ArtisanProfile>) =>
      (
        await profileRepo.save(
          profileRepo.create({ user, currency: 'GHS', ...p }),
        )
      ).id;
    const P_A1 = await profile(A1, {
      isProfileComplete: true,
      isVerified: true,
      paystackRecipientCode: 'RCP_qa_insights_fictional',
    });
    const P_A2 = await profile(A2, { isProfileComplete: true });
    const P_A3 = await profile(A3, { isProfileComplete: false });
    for (const [pid, sid] of [
      [P_A1, S1],
      [P_A1, S2],
      [P_A2, S1],
      [P_A3, S2],
    ]) {
      await sql(
        `INSERT INTO artisan_profile_services (artisan_profile_id, service_id) VALUES ($1, $2)`,
        [pid, sid],
      );
    }
    await ins('artisan_availability', {
      artisan_profile_id: P_A1,
      day_of_week: 1,
      start_time: '08:00',
      end_time: '17:00',
      is_active: true,
    });
    await ins('artisan_availability', {
      artisan_profile_id: P_A3,
      day_of_week: 2,
      start_time: '08:00',
      end_time: '17:00',
      is_active: false,
    });

    // ── Jobs ──────────────────────────────────────────────────────────────
    const job = (r: {
      customer: User;
      service: number;
      at: string;
      location: string;
      status: string;
      artisan?: User;
      booking?: number;
    }) =>
      ins('jobs', {
        customer_id: r.customer.id,
        service_id: r.service,
        title: 'QA insights fictional job',
        location: r.location,
        status: r.status,
        accepted_artisan_id: r.artisan?.id ?? null,
        booking_id: r.booking ?? null,
        created_at: r.at,
        updated_at: r.at,
      });
    const hist = (jobId: number, to: string, by: string, at: string) =>
      ins('job_status_history', {
        job_id: jobId,
        to_status: to,
        changed_by: by,
        created_at: at,
      });
    const apply = (jobId: number, artisan: User, at: string) =>
      ins('job_applications', {
        job_id: jobId,
        artisan_id: artisan.id,
        created_at: at,
        updated_at: at,
      });

    // Out of range (May): must not count anywhere range-scoped.
    const J0 = await job({
      customer: C1,
      service: S1,
      at: T('05-10'),
      location: 'Legon',
      status: 'COMPLETED',
      artisan: A2,
    });
    await hist(J0, 'COMPLETED', String(C1.id), T('05-12'));

    const J1 = await job({
      customer: C1,
      service: S1,
      at: T('06-01'),
      location: ' East Legon ',
      status: 'COMPLETED',
      artisan: A1,
    });
    await apply(J1, A1, T('06-01', '12:00')); // +2 h
    await apply(J1, A2, T('06-01', '14:00'));
    await hist(J1, 'OPEN', String(C1.id), T('06-01'));
    await hist(J1, 'PENDING', String(C1.id), T('06-02')); // hire +24 h
    await hist(J1, 'IN_PROGRESS', String(A1.id), T('06-03'));
    await hist(J1, 'COMPLETED', String(C1.id), T('06-05')); // +72 h after hire

    const J2 = await job({
      customer: C1,
      service: S1,
      at: T('06-02'),
      location: 'east legon',
      status: 'COMPLETED',
      artisan: A1,
    });
    await apply(J2, A1, T('06-02', '11:00')); // +1 h
    await hist(J2, 'PENDING', String(C1.id), T('06-02', '22:00')); // +12 h
    await hist(J2, 'IN_PROGRESS', String(A1.id), T('06-03'));
    await hist(J2, 'COMPLETED', String(C1.id), T('06-04', '22:00')); // +48 h

    const J3 = await job({
      customer: C3,
      service: S2,
      at: T('06-03'),
      location: 'Osu',
      status: 'CANCELLED',
      artisan: A1,
    });
    await apply(J3, A1, T('06-03', '13:00')); // +3 h
    await hist(J3, 'PENDING', String(C3.id), T('06-03', '16:00')); // +6 h
    await hist(J3, 'CANCELLED', String(A1.id), T('06-04')); // by the artisan

    const J4 = await job({
      customer: C3,
      service: S1,
      at: T('06-04'),
      location: 'Osu ',
      status: 'OPEN',
    });
    await apply(J4, A2, T('06-04', '14:00')); // +4 h

    const J5 = await job({
      customer: C4,
      service: S3,
      at: T('06-05'),
      location: 'Tema',
      status: 'EXPIRED',
    });
    await apply(J5, A2, T('06-05', '20:00')); // +10 h
    await hist(J5, 'EXPIRED', 'SYSTEM', T('06-08'));

    const J6 = await job({
      customer: C5,
      service: S3,
      at: T('06-06'),
      location: 'Kumasi',
      status: 'CANCELLED',
    });
    await hist(J6, 'CANCELLED', String(C5.id), T('06-06', '12:00'));

    await job({
      customer: C6,
      service: S1,
      at: T('06-08'),
      location: '   ',
      status: 'OPEN',
    });
    await job({
      customer: C3,
      service: S1,
      at: T('06-09'),
      location: 'Tema',
      status: 'OPEN',
    });

    // ── Bookings ──────────────────────────────────────────────────────────
    const booking = (customer: User, pid: number, at: string, status: string) =>
      ins('bookings', {
        customer_id: customer.id,
        artisan_profile_id: pid,
        service_id: S1,
        scheduled_date: '2001-06-25',
        start_time: '09:00',
        end_time: '10:00',
        status,
        created_at: at,
        updated_at: at,
      });
    const B1 = await booking(C2, P_A1, T('06-10', '08:00'), 'COMPLETED');
    await booking(C3, P_A1, T('06-11'), 'EXPIRED');
    await booking(C4, P_A2, T('06-12'), 'DECLINED');
    await booking(C5, P_A2, T('06-13'), 'PENDING');
    const B5 = await booking(C1, P_A1, T('06-14'), 'CANCELLED');

    const JB1 = await job({
      customer: C2,
      service: S1,
      at: T('06-10'), // confirmed 2 h after the request
      location: 'East  Legon',
      status: 'COMPLETED',
      artisan: A1,
      booking: B1,
    });
    await hist(JB1, 'PENDING', String(A1.id), T('06-10'));
    await hist(JB1, 'COMPLETED', String(C2.id), T('06-12'));

    // ── Payments ──────────────────────────────────────────────────────────
    const pay = (r: {
      job: number;
      customer: User;
      pid: number;
      amount: number;
      status: string;
      paidAt: string;
      releasedAt?: string;
      refunded?: number;
      hold?: string;
    }) =>
      ins('payments', {
        job_id: r.job,
        customer_id: r.customer.id,
        artisan_profile_id: r.pid,
        amount: r.amount,
        platform_fee: r.amount * 0.1,
        artisan_amount: r.amount * 0.9,
        status: r.status,
        reference: `qa-ins-${uniq}-${r.job}`,
        paid_at: r.paidAt,
        released_at: r.releasedAt ?? null,
        refunded_amount: r.refunded ?? 0,
        payout_hold_reason: r.hold ?? null,
        created_at: r.paidAt,
        updated_at: r.paidAt,
      });
    const P1 = await pay({
      job: J1,
      customer: C1,
      pid: P_A1,
      amount: 200,
      status: 'RELEASED',
      paidAt: T('06-02', '11:00'),
      releasedAt: T('06-05', '11:00'),
    });
    const P2 = await pay({
      job: J2,
      customer: C1,
      pid: P_A1,
      amount: 300,
      status: 'RELEASED',
      paidAt: T('06-03', '00:00'),
      releasedAt: T('06-05', '00:00'),
    });
    const P3 = await pay({
      job: J3,
      customer: C3,
      pid: P_A1,
      amount: 100,
      status: 'REFUNDED',
      paidAt: T('06-03', '17:00'),
      refunded: 100,
    });
    const P4 = await pay({
      job: JB1,
      customer: C2,
      pid: P_A1,
      amount: 150,
      status: 'PENDING_TRANSFER',
      paidAt: T('06-10'),
      hold: 'payout_name_mismatch',
    });
    await pay({
      job: J0,
      customer: C1,
      pid: P_A2,
      amount: 80,
      status: 'TRANSFER_FAILED',
      paidAt: T('05-11'),
    });

    let ref = 0;
    const charge = (
      paymentId: number,
      customer: User,
      method: string,
      status: string,
      at: string,
      refund?: { status: string; amount: number },
    ) =>
      ins('payment_charges', {
        payment_id: paymentId,
        customer_id: customer.id,
        reference: `qa-ins-ch-${uniq}-${++ref}`,
        method_type: method,
        status,
        refund_status: refund?.status ?? null,
        refund_amount: refund?.amount ?? null,
        created_at: at,
        updated_at: at,
      });
    await charge(P1, C1, 'card', 'succeeded', T('06-02'));
    await charge(P2, C1, 'mobile_money', 'failed', T('06-02'));
    await charge(P2, C1, 'mobile_money', 'succeeded', T('06-03'));
    await charge(P3, C3, 'hosted', 'expired', T('06-03'));
    await charge(P3, C3, 'mobile_money', 'succeeded', T('06-03'));
    await charge(P3, C3, 'mobile_money', 'duplicate', T('06-03'), {
      status: 'processed',
      amount: 100,
    });
    await charge(P4, C2, 'hosted', 'cancelled', T('06-10'));
    await charge(P4, C2, 'hosted', 'succeeded', T('06-10'));
    await charge(P4, C2, 'card', 'needs_otp', T('06-10'));

    // Saved methods (fictional, encrypted fields are placeholders).
    const momo = (user: User, network: string, last4: string) =>
      ins('customer_payment_methods', {
        user_id: user.id,
        type: 'mobile_money',
        network,
        number_last4: last4,
        number_encrypted: 'fictional',
        number_hash: `qa-ins-${uniq}-${last4}`,
        created_at: T('06-01'),
        updated_at: T('06-01'),
      });
    await momo(C1, 'MTN', '1111');
    await momo(C2, 'VOD', '2222');
    await ins('customer_payment_methods', {
      user_id: C3.id,
      type: 'card',
      card_last4: '4242',
      authorization_encrypted: 'fictional',
      signature_hash: `qa-ins-${uniq}-sig`,
      created_at: T('06-01'),
      updated_at: T('06-01'),
    });

    // ── Disputes ──────────────────────────────────────────────────────────
    await ins('disputes', {
      booking_id: B1,
      raised_by_id: C2.id,
      reason: 'Fictional dispute for the insights test.',
      category: 'WORK_QUALITY',
      status: 'RESOLVED',
      outcome: 'MUTUAL',
      created_at: T('06-13'),
      updated_at: T('06-14'),
      resolved_at: T('06-14'),
    });
    await ins('disputes', {
      booking_id: B1,
      raised_by_id: A1.id,
      reason: 'Fictional dispute for the insights test.',
      category: 'PAYMENT_AMOUNT',
      status: 'OPEN',
      created_at: T('06-15'),
      updated_at: T('06-15'),
    });
    await ins('disputes', {
      booking_id: B5,
      raised_by_id: C1.id,
      reason: 'Fictional dispute for the insights test.',
      status: 'OPEN',
      created_at: T('06-16'),
      updated_at: T('06-16'),
    });

    // ── Verifications ─────────────────────────────────────────────────────
    const verify = (
      pid: number,
      status: string,
      at: string,
      reviewed?: string,
    ) =>
      ins('artisan_verifications', {
        artisan_profile_id: pid,
        document_type: 'GHANA_CARD',
        status,
        created_at: at,
        updated_at: reviewed ?? at,
        reviewed_at: reviewed ?? null,
      });
    await verify(P_A1, 'APPROVED', T('06-01'), T('06-02'));
    await verify(P_A3, 'REJECTED', T('06-02'), T('06-03'));
    await verify(P_A2, 'PENDING', T('06-20', '12:00')); // 240 h old at NOW

    // ── Admin actions, reviews, moderation, security events ───────────────
    const audit = (action: string, target: User, at: string) =>
      ins('admin_actions', {
        action,
        target_type: 'USER',
        target_id: target.id,
        actor_id: AD.id,
        created_at: at,
      });
    await audit('USER_SUSPEND', C6, T('06-20'));
    await audit('USER_SUSPEND', A3, T('05-01')); // out of range

    const review = (jobId: number, rating: number, at: string) =>
      ins('reviews', {
        job_id: jobId,
        artisan_profile_id: P_A1,
        reviewed_user_id: A1.id,
        rating,
        status: 'ACTIVE',
        created_at: at,
        updated_at: at,
      });
    const R0 = await review(J0, 1, T('05-15'));
    const R1 = await review(J1, 5, T('06-06'));
    const R2 = await review(J2, 4, T('06-06', '15:00'));
    reviewIds.push(R0, R1, R2);
    const moderate = (reviewId: number, action: string, at: string) =>
      ins('review_moderation_actions', {
        review_id: reviewId,
        action,
        actor_id: AD.id,
        created_at: at,
      });
    await moderate(R2, 'FLAG', T('06-07'));
    await moderate(R2, 'RESTORE', T('06-08'));
    await moderate(R0, 'FLAG', T('05-20'));

    const event = (user: User, name: string, at: string) =>
      ins('account_security_events', {
        user_id: user.id,
        event: name,
        created_at: at,
      });
    await event(C1, 'payment_method.added', T('06-05'));
    await event(C2, 'payment_method.added', T('06-06'));
    await event(C3, 'spending_report.exported', T('06-07'));
    await event(C3, 'spending_report.exported', T('05-01')); // out of range

    result = await insights.build(AnalyticsRange.LAST_30_DAYS, NOW);
  });

  afterAll(async () => {
    const ignore = async (fn: () => Promise<unknown>) => {
      try {
        await fn();
      } catch {
        /* already gone */
      }
    };
    if (reviewIds.length) {
      await ignore(() =>
        sql(`DELETE FROM review_moderation_actions WHERE review_id = ANY($1)`, [
          reviewIds,
        ]),
      );
    }
    if (userIds.length) {
      await ignore(() =>
        sql(`DELETE FROM admin_actions WHERE actor_id = ANY($1)`, [userIds]),
      );
      await ignore(() =>
        sql(`DELETE FROM account_security_events WHERE user_id = ANY($1)`, [
          userIds,
        ]),
      );
      // Cascades to profiles, jobs, applications, history, bookings,
      // payments, charges, saved methods, disputes, verifications, reviews.
      await ignore(() =>
        sql(`DELETE FROM users WHERE id = ANY($1)`, [userIds]),
      );
    }
    if (serviceIds.length) {
      await ignore(() =>
        sql(`DELETE FROM services WHERE id = ANY($1)`, [serviceIds]),
      );
    }
    await app.close();
  });

  // ─── The numbers ──────────────────────────────────────────────────────────

  it('computes every section (nothing degraded)', () => {
    expect(result.degraded).toEqual([]);
    expect(result.range).toBe('30d');
    expect(result.from).toBe('2001-05-31T12:00:00.000Z');
    expect(result.to).toBe('2001-06-30T12:00:00.000Z');
    expect(result.minSample).toBe(5);
  });

  it('1. funnel', () => {
    expect(result.funnel).toEqual({
      steps: [
        { key: 'posted', count: 8, conversionFromPrevious: null },
        { key: 'applied', count: 5, conversionFromPrevious: 62.5 },
        { key: 'hired', count: 3, conversionFromPrevious: 60 },
        { key: 'started', count: 2, conversionFromPrevious: 66.7 },
        { key: 'completed', count: 2, conversionFromPrevious: 100 },
      ],
      overallConversion: 25,
      expiredWithoutHire: 1,
      cancelled: 2,
      cancelledBeforeHire: 1,
      inFlight: 3,
      fromBookings: 1,
    });
  });

  it('2. speed: medians and p90 from percentile_cont, null below 5 observations', () => {
    const s = result.speed!;
    // First application after 1, 2, 3, 4 and 10 hours.
    expect(s.firstApplication).toEqual({
      n: 5,
      medianHours: 3,
      p90Hours: 7.6,
    });
    // The SQL figure matches the same interpolation done in TypeScript.
    expect(percentileCont([2, 1, 3, 4, 10], 0.9)).toBeCloseTo(7.6, 10);
    expect(s.hire).toEqual({ n: 3, medianHours: null, p90Hours: null });
    expect(s.hireToCompletion).toEqual({
      n: 3,
      medianHours: null,
      p90Hours: null,
    });
    expect(s.bookingResponse).toEqual({
      n: 1,
      medianHours: null,
      p90Hours: null,
    });
    expect(s.payout).toEqual({ n: 2, medianHours: null, p90Hours: null });
    expect(s.disputeResolution).toEqual({
      n: 1,
      medianHours: null,
      p90Hours: null,
    });
    expect(s.verificationReview).toEqual({
      n: 2,
      medianHours: null,
      p90Hours: null,
    });
  });

  it('3. supply and demand by service and by area', () => {
    const m = result.marketplace!;
    const mine = m.byService.filter((s) => s.serviceName.includes(`${uniq}`));
    expect(
      mine.map((s) => ({
        name: s.serviceName.replace(` ${uniq}`, ''),
        jobs: s.jobs,
        hired: s.hired,
        artisans: s.artisans,
        ratio: s.demandPerArtisan,
        flag: s.flag,
      })),
    ).toEqual([
      {
        name: 'QA Insights Plumbing',
        jobs: 6,
        hired: 3,
        artisans: 2,
        ratio: 3,
        flag: 'few_artisans',
      },
      {
        name: 'QA Insights Roofing',
        jobs: 2,
        hired: 0,
        artisans: 0,
        ratio: null,
        flag: 'no_artisans',
      },
      {
        name: 'QA Insights Tiling',
        jobs: 1,
        hired: 1,
        artisans: 1,
        ratio: 1,
        flag: null,
      },
    ]);
    // Blank locations are left out; spacing and case are folded together.
    expect(m.byArea).toEqual({
      top: [
        { area: 'east legon', jobs: 3, share: 37.5 },
        { area: 'osu', jobs: 2, share: 25 },
        { area: 'tema', jobs: 2, share: 25 },
        { area: 'kumasi', jobs: 1, share: 12.5 },
      ],
      other: { jobs: 0, areas: 0, share: 0 },
      totalJobs: 8,
    });
  });

  it('4. unit economics', () => {
    const e = result.economics!;
    expect(e).toMatchObject({
      grossRevenue: '750.00',
      netRevenue: '75.00',
      paidPayments: 4,
      averageJobValue: '187.50',
      takeRate: 10,
      refundedAmount: '100.00',
      refundRateByAmount: 13.3,
      refundedPayments: 1,
      refundRateByCount: 25,
      cancellation: {
        cancelled: 2,
        terminalJobs: 6,
        rate: 33.3,
        byActor: {
          client: 1,
          artisan: 1,
          admin: 0,
          system: 0,
          unknown: 0,
          unrecorded: 0,
        },
      },
    });
    expect(
      e.revenueByService.map((r) => ({
        gross: r.gross,
        net: r.net,
        paidPayments: r.paidPayments,
        share: r.share,
      })),
    ).toEqual([
      { gross: '650.00', net: '65.00', paidPayments: 3, share: 86.7 },
      { gross: '100.00', net: '10.00', paidPayments: 1, share: 13.3 },
    ]);
  });

  it('5. payments health', () => {
    expect(result.payments).toEqual({
      attempts: {
        total: 9,
        succeeded: 4,
        failed: 1,
        expired: 1,
        cancelled: 1,
        duplicate: 1,
        inProgress: 1,
        successRate: 57.1,
      },
      methodMix: [
        { method: 'mobile_money', attempts: 4, succeeded: 3, share: 44.4 },
        { method: 'hosted', attempts: 3, succeeded: 1, share: 33.3 },
        { method: 'card', attempts: 2, succeeded: 1, share: 22.2 },
      ],
      payoutsOnHold: [
        { reason: 'payout_name_mismatch', count: 1, amount: '135.00' },
      ],
      transferFailed: { count: 1, amount: '72.00' },
      duplicateRefunds: {
        count: 1,
        amount: '100.00',
        byRefundStatus: [
          {
            refundStatus: 'processed',
            count: 1,
            amount: '100.00',
            refundedAmount: '100.00',
          },
        ],
      },
      savedMethods: {
        mobileMoney: 2,
        card: 1,
        momoNetworks: [
          { network: 'MTN', count: 1, share: 50 },
          { network: 'VOD', count: 1, share: 50 },
        ],
        customers: 6,
        customersWithMethod: 3,
        adoptionRate: 50,
      },
    });
  });

  it('6. trust and safety', () => {
    expect(result.trust).toEqual({
      disputes: {
        filed: 3,
        completedJobs: 3,
        per100CompletedJobs: 100,
        byCategory: [
          { key: 'PAYMENT_AMOUNT', count: 1 },
          { key: 'UNCATEGORISED', count: 1 },
          { key: 'WORK_QUALITY', count: 1 },
        ],
        byOutcome: [{ key: 'MUTUAL', count: 1 }],
      },
      verifications: {
        approved: 1,
        rejected: 1,
        approvalRate: 50,
        rejectionRate: 50,
        pendingBacklog: 1,
        oldestPendingHours: 240,
      },
      suspensions: { current: 1, newInRange: 1, bansInRange: 0 },
      moderationActions: [
        { key: 'FLAG', count: 1 },
        { key: 'RESTORE', count: 1 },
      ],
      securityEvents: [
        { key: 'payment_method.added', count: 2 },
        { key: 'spending_report.exported', count: 1 },
      ],
    });
  });

  it('7. artisan health', () => {
    expect(result.artisans).toEqual({
      activation: {
        total: 4,
        profileComplete: 2,
        verified: 1,
        hasService: 3,
        hasWorkingHours: 1,
        hasPayoutMethod: 1,
        visibleInSearch: 2,
        fullyActivated: 1,
        fullyActivatedRate: 25,
      },
      activeLast30Days: 2,
      activeLast30DaysRate: 50,
      // One artisan had payouts released: below the 5-artisan minimum.
      earnings: {
        n: 1,
        q1: null,
        median: null,
        q3: null,
        min: null,
        max: null,
      },
      bookingResponse: {
        requests: 5,
        responded: 2,
        expired: 1,
        pending: 1,
        withdrawn: 1,
        responseRate: 66.7,
      },
    });
  });

  it('8. retention: repeat clients, repeat pairs and sign-up cohorts', () => {
    const r = result.retention!;
    expect(r).toMatchObject({
      payingClients: 3,
      repeatClients: 1,
      repeatClientRate: 33.3,
      pairs: 3,
      repeatPairs: 1,
      repeatPairRate: 33.3,
    });
    expect(r.cohorts).toEqual([
      {
        cohort: '2001-01',
        size: 0,
        months: [null, null, null, null, null, null],
      },
      {
        cohort: '2001-02',
        size: 0,
        months: [null, null, null, null, null, null],
      },
      {
        cohort: '2001-03',
        size: 0,
        months: [null, null, null, null, null, null],
      },
      { cohort: '2001-04', size: 2, months: [0, 50, 100, null, null, null] },
      {
        cohort: '2001-05',
        size: 0,
        months: [null, null, null, null, null, null],
      },
      {
        cohort: '2001-06',
        size: 4,
        months: [100, null, null, null, null, null],
      },
    ]);
  });

  it('9. reviews', () => {
    const r = result.reviews!;
    expect(r).toMatchObject({
      count: 2,
      averageRating: 4.5,
      distribution: [
        { star: 1, count: 0 },
        { star: 2, count: 0 },
        { star: 3, count: 0 },
        { star: 4, count: 1 },
        { star: 5, count: 1 },
      ],
      completedJobs: 3,
      reviewedJobs: 2,
      reviewRate: 66.7,
    });
    expect(r.trend).toHaveLength(1);
    expect(r.trend[0]).toMatchObject({ averageRating: 4.5, count: 2 });
    expect(new Date(r.trend[0].bucket).toISOString().slice(0, 10)).toBe(
      '2001-06-06',
    );
  });

  it('an empty window gives zeros and nulls, never NaN or a division by zero', async () => {
    const empty = await insights.build(
      AnalyticsRange.LAST_7_DAYS,
      new Date('1990-01-15T00:00:00.000Z'),
    );
    expect(empty.degraded).toEqual([]);
    expect(empty.funnel!.overallConversion).toBeNull();
    expect(empty.funnel!.steps.every((s) => s.count === 0)).toBe(true);
    expect(empty.speed!.firstApplication).toEqual({
      n: 0,
      medianHours: null,
      p90Hours: null,
    });
    expect(empty.economics!.averageJobValue).toBeNull();
    expect(empty.economics!.takeRate).toBeNull();
    expect(empty.economics!.grossRevenue).toBe('0.00');
    expect(empty.payments!.attempts.successRate).toBeNull();
    expect(empty.trust!.disputes.per100CompletedJobs).toBeNull();
    expect(empty.trust!.verifications.oldestPendingHours).toBeNull();
    expect(empty.artisans!.activation.fullyActivatedRate).toBeNull();
    expect(empty.retention!.repeatClientRate).toBeNull();
    expect(empty.reviews!.averageRating).toBeNull();
    expect(empty.reviews!.reviewRate).toBeNull();
    expect(JSON.stringify(empty)).not.toMatch(/NaN|Infinity/);
  });

  it('a failing query degrades only its own section', async () => {
    const spy = jest
      .spyOn(
        insights as unknown as { reviews: () => Promise<unknown> },
        'reviews',
      )
      .mockRejectedValueOnce(new Error('fictional failure'));
    const partial = await insights.build(AnalyticsRange.LAST_30_DAYS, NOW);
    spy.mockRestore();
    expect(partial.degraded).toEqual(['reviews']);
    expect(partial.reviews).toBeNull();
    expect(partial.funnel).toEqual(result.funnel);
  });

  it('never returns personal data (no emails, names or ids of people)', () => {
    const text = JSON.stringify(result);
    expect(text).not.toMatch(/@/);
    expect(text).not.toMatch(/QaIns/);
    expect(text).not.toMatch(
      /"(email|firstname|lastname|ip|userAgent|user_agent)"/,
    );
  });

  // ─── HTTP: guards, headers, envelope ──────────────────────────────────────

  describe('GET /admin/analytics/insights', () => {
    it('serves an admin, private and uncached, with every section and a degraded list', async () => {
      const res = await request(server())
        .get('/api/v1/admin/analytics/insights?range=7d')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('private, no-store');
      const data = (res.body as { data: Record<string, unknown> }).data;
      expect(Object.keys(data).sort()).toEqual(
        [
          'artisans',
          'bucket',
          'cached',
          'degraded',
          'economics',
          'from',
          'funnel',
          'generatedAt',
          'marketplace',
          'minSample',
          'payments',
          'range',
          'retention',
          'reviews',
          'speed',
          'to',
          'trust',
        ].sort(),
      );
      expect(data.range).toBe('7d');
      expect(data.degraded).toEqual([]);
      expect(data.cached).toBe(false);

      const again = await request(server())
        .get('/api/v1/admin/analytics/insights?range=7d')
        .set('Authorization', `Bearer ${adminToken}`);
      expect((again.body as { data: { cached: boolean } }).data.cached).toBe(
        true,
      );
    });

    it('rejects a range the admin endpoints do not define', async () => {
      const res = await request(server())
        .get('/api/v1/admin/analytics/insights?range=all')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(res.status).toBe(400);
    });

    it.each([
      ['customer', () => customerToken],
      ['artisan', () => artisanToken],
    ])('answers a %s with 403', async (_label, tok) => {
      const res = await request(server())
        .get('/api/v1/admin/analytics/insights?range=30d')
        .set('Authorization', `Bearer ${tok()}`);
      expect(res.status).toBe(403);
    });

    it('answers an anonymous caller with 401', async () => {
      const res = await request(server()).get(
        '/api/v1/admin/analytics/insights?range=30d',
      );
      expect(res.status).toBe(401);
    });
  });

  // ─── The existing endpoint is unchanged ───────────────────────────────────

  it('GET /admin/analytics keeps exactly its existing response keys', async () => {
    const res = await request(server())
      .get('/api/v1/admin/analytics?range=30d')
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBeUndefined();
    const body = res.body as { message: string; data: Record<string, unknown> };
    expect(body.message).toBe('Platform analytics retrieved.');
    const data = body.data;
    expect(Object.keys(data).sort()).toEqual(
      [
        'bucket',
        'cached',
        'degraded',
        'disputes',
        'from',
        'generatedAt',
        'kpis',
        'previous',
        'range',
        'series',
        'to',
        'topArtisans',
        'topServiceCategories',
      ].sort(),
    );
    expect(Object.keys(data.kpis as object).sort()).toEqual(
      [
        'activeJobs',
        'artisanPayouts',
        'bookings',
        'bookingsThisMonth',
        'completedJobs',
        'completionRate',
        'grossRevenue',
        'netRevenue',
        'newArtisans',
        'newClients',
        'newUsers',
        'paidPayments',
        'refundedAmount',
        'terminalJobs',
        'totalArtisans',
        'totalClients',
        'totalUsers',
      ].sort(),
    );
    expect(Object.keys(data.series as object).sort()).toEqual([
      'bookingVolume',
      'revenue',
      'userGrowth',
    ]);
    expect(Object.keys(data.disputes as object).sort()).toEqual(
      [
        'averageResolutionHours',
        'breachesTarget',
        'filedCount',
        'openCount',
        'openPast48h',
        'resolvedCount',
        'slaHours',
      ].sort(),
    );
    // Money on the existing endpoint stays a number.
    expect(typeof (data.kpis as { grossRevenue: unknown }).grossRevenue).toBe(
      'number',
    );
  });
});

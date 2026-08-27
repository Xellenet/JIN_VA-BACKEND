import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { ResponseInterceptor } from '../src/common/interceptors/response.interceptor';
import { User } from '@users/entities/user.entity';
import { ArtisanProfile } from '@users/entities/artisan-profile.entity';
import { ServiceEntity } from '@services/entities/service.entity';
import { Booking } from '../src/bookings/entities/booking.entity';
import { Dispute } from '../src/disputes/entities/dispute.entity';
import { Notification } from '../src/notifications/entities/notification.entity';
import { AdminAction } from '../src/admin-audit/entities/admin-action.entity';
import { UserTokenService } from '@users/token.service';
import {
  AdminActionType,
  BookingStatus,
  DisputeCategory,
  DisputeMoneyAction,
  DisputeOutcome,
  DisputeStatus,
  Role,
} from '@common/types/enums';

/**
 * Role-boundary, money-safety and audit-trail coverage for the
 * analytics-admin-disputes round, against a real database.
 *
 * Deliberately covers the things a unit test cannot prove:
 *  - the analytics endpoints' role scoping is enforced by the *running* guards,
 *    not merely by the frontend not offering the route (AN1);
 *  - the admin-only cross-entity search and the audit log reject non-admins
 *    server-side (AT5, AT6);
 *  - the counterparty response rules hold end to end (DR4);
 *  - a party's read of their own dispute never contains admin notes (DP2);
 *  - a verdict is mandatory and a MUTUAL ruling records "no money moved"
 *    explicitly, with an audit row carrying the verdict (DR1, DR2, AT5);
 *  - the already-resolved guard still rejects a second ruling (DR1);
 *  - suspension actually blocks transacting and reactivation fully restores it
 *    (AT3).
 *
 * Money-*moving* verdicts are exercised at the unit level
 * (`disputes.service.spec.ts`) rather than here: REFUND_CLIENT and
 * RELEASE_ARTISAN reach live Paystack, which must never be called from a test.
 * Every ruling here is MUTUAL, which by design moves nothing.
 *
 * Run: npm run test:e2e -- analytics-admin-disputes
 *
 * Every fixture created here is removed in `afterAll`.
 */
jest.setTimeout(180000);

interface Envelope<T> {
  data: T;
  message?: string;
}
function envelope<T>(res: request.Response): T {
  return (res.body as Envelope<T>).data;
}
function envelopeMessage(res: request.Response): string | undefined {
  return (res.body as Envelope<unknown>).message;
}

interface AdminAnalytics {
  range: string;
  bucket: string;
  generatedAt: string;
  cached: boolean;
  kpis: {
    totalUsers: number;
    grossRevenue: number;
    netRevenue: number;
    completionRate: number;
    completedJobs: number;
    terminalJobs: number;
    bookingsThisMonth: number;
  };
  previous: Record<string, number> | null;
  series: {
    userGrowth: { bucket: string; clients: number; artisans: number }[];
    bookingVolume: { bucket: string; bookings: number }[];
    revenue: { bucket: string; gross: number; net: number }[];
  };
  topServiceCategories: { serviceName: string; jobs: number }[];
  topArtisans: {
    averageRating: number;
    weightedRating: number;
    totalReviews: number;
    completedJobs: number;
  }[];
  disputes: {
    averageResolutionHours: number;
    openPast48h: number;
    slaHours: number;
  };
}

interface ArtisanAnalytics {
  range: string;
  bucket: string;
  earnings: {
    allTime: number;
    thisMonth: number;
    lastMonth: number;
    pending: number;
    currency: string;
  };
  jobCounts: { completed: number; cancelled: number; inProgress: number };
  repeatClients: { totalClients: number; repeatClients: number; rate: number };
  ratingTrend: { points: unknown[]; hasEnoughDataForTrend: boolean };
  topServices: unknown[];
  overview: { completedJobsAllTime: number; averageRating: number };
}

interface PartyDispute {
  id: number;
  status: DisputeStatus;
  category: DisputeCategory;
  reason: string;
  response?: string;
  viewerRole: 'RAISER' | 'COUNTERPARTY';
  canRespond: boolean;
  outcome?: DisputeOutcome;
  moneyAction?: DisputeMoneyAction;
}

describe('Analytics, admin tooling & disputes (e2e)', () => {
  let app: INestApplication<App>;

  let userRepo: Repository<User>;
  let profileRepo: Repository<ArtisanProfile>;
  let serviceRepo: Repository<ServiceEntity>;
  let bookingRepo: Repository<Booking>;
  let disputeRepo: Repository<Dispute>;
  let notificationRepo: Repository<Notification>;
  let auditRepo: Repository<AdminAction>;
  let tokenService: UserTokenService;

  let artisanUser: User;
  let artisanToken: string;
  let artisanProfile: ArtisanProfile;
  let customer: User;
  let customerToken: string;
  let stranger: User;
  let strangerToken: string;
  let adminUser: User;
  let adminToken: string;
  let service: ServiceEntity;

  const createdDisputeIds: number[] = [];
  const createdBookingIds: number[] = [];
  const createdUserIds: number[] = [];

  const server = () => app.getHttpServer();
  const uniq = Date.now();

  async function makeUser(
    label: string,
    role: Role,
  ): Promise<{ user: User; token: string }> {
    const user = await userRepo.save(
      userRepo.create({
        email: `qa-aad-${label}-${uniq}@test.jinva.local`,
        password: null,
        firstname: 'QaAad',
        lastname: label,
        role,
        accountVerified: true,
        isBanned: false,
        isSuspended: false,
      }),
    );
    createdUserIds.push(user.id);
    return {
      user,
      token: (await tokenService.createJWTTokens(user)).access_token,
    };
  }

  /** A COMPLETED booking is the only state a dispute may be raised on. */
  async function makeBooking(): Promise<Booking> {
    const booking = await bookingRepo.save(
      bookingRepo.create({
        customer,
        artisanProfile,
        service,
        scheduledDate: '2026-08-01',
        startTime: '09:00:00',
        endTime: '10:00:00',
        status: BookingStatus.COMPLETED,
        agreedPrice: 150,
        currency: 'GHS',
      }),
    );
    createdBookingIds.push(booking.id);
    return booking;
  }

  /**
   * Notification listeners are `@OnEvent` handlers — `emit()` dispatches
   * synchronously but does not await the async handler, so the row can land a
   * few milliseconds after the HTTP response. Poll rather than sleep a fixed
   * amount, so the assertion is neither flaky nor needlessly slow.
   */
  async function waitForNotifications(
    userId: number,
    type: string,
    timeoutMs = 5000,
  ): Promise<Notification[]> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const rows = await notificationRepo.find({
        where: { user: { id: userId }, type: type as never },
      });
      if (rows.length > 0 || Date.now() > deadline) return rows;
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  async function raiseDispute(
    token: string,
    bookingId: number,
    category: DisputeCategory = DisputeCategory.WORK_QUALITY,
  ): Promise<number> {
    const res = await request(server())
      .post('/api/v1/disputes')
      .set('Authorization', `Bearer ${token}`)
      .send({
        bookingId,
        category,
        reason: `QA e2e dispute ${uniq} raised to verify the round's dispute rules end to end.`,
      });
    expect(res.status).toBe(201);
    const id = envelope<{ id: number }>(res).id;
    createdDisputeIds.push(id);
    return id;
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

    userRepo = moduleFixture.get(getRepositoryToken(User));
    profileRepo = moduleFixture.get(getRepositoryToken(ArtisanProfile));
    serviceRepo = moduleFixture.get(getRepositoryToken(ServiceEntity));
    bookingRepo = moduleFixture.get(getRepositoryToken(Booking));
    disputeRepo = moduleFixture.get(getRepositoryToken(Dispute));
    notificationRepo = moduleFixture.get(getRepositoryToken(Notification));
    auditRepo = moduleFixture.get(getRepositoryToken(AdminAction));
    tokenService = moduleFixture.get(UserTokenService);

    service = await serviceRepo.save(
      serviceRepo.create({
        name: `QA AAD Service ${uniq}`,
        estimatedDurationMins: 60,
      }),
    );

    ({ user: artisanUser, token: artisanToken } = await makeUser(
      'Artisan',
      Role.ARTISAN,
    ));
    artisanProfile = await profileRepo.save(
      profileRepo.create({
        user: artisanUser,
        currency: 'GHS',
        isVerified: true,
        isProfileComplete: true,
      }),
    );

    ({ user: customer, token: customerToken } = await makeUser(
      'Customer',
      Role.CUSTOMER,
    ));
    ({ user: stranger, token: strangerToken } = await makeUser(
      'Stranger',
      Role.CUSTOMER,
    ));
    ({ user: adminUser, token: adminToken } = await makeUser(
      'Admin',
      Role.ADMIN,
    ));
  });

  afterAll(async () => {
    const ignore = async (fn: () => Promise<unknown>) => {
      try {
        await fn();
      } catch {
        /* row already gone / FK ordering */
      }
    };

    if (createdUserIds.length) {
      await ignore(() =>
        notificationRepo
          .createQueryBuilder()
          .delete()
          .where('user_id IN (:...ids)', { ids: createdUserIds })
          .execute(),
      );
      await ignore(() =>
        auditRepo
          .createQueryBuilder()
          .delete()
          .where('actor_id IN (:...ids)', { ids: createdUserIds })
          .execute(),
      );
    }
    if (createdDisputeIds.length) {
      await ignore(() => disputeRepo.delete({ id: In(createdDisputeIds) }));
    }
    if (createdBookingIds.length) {
      await ignore(() => bookingRepo.delete({ id: In(createdBookingIds) }));
    }
    await ignore(() => profileRepo.delete({ id: artisanProfile.id }));
    if (createdUserIds.length) {
      await ignore(() => userRepo.delete({ id: In(createdUserIds) }));
    }
    await ignore(() => serviceRepo.delete({ id: service.id }));

    await app.close();
  });

  // ─── AN1: analytics role scoping ─────────────────────────────────────────────

  describe('AN1: analytics endpoints are role-scoped server-side', () => {
    it('GET /admin/analytics returns the platform rollup for an admin', async () => {
      const res = await request(server())
        .get('/api/v1/admin/analytics?range=30d')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      const data = envelope<AdminAnalytics>(res);
      expect(data.range).toBe('30d');
      expect(data.bucket).toBe('day');
      expect(typeof data.generatedAt).toBe('string');
      // Postgres returns COUNT/AVG/SUM as text; every aggregate must arrive as
      // a real number or the charts render subtly wrong instead of failing.
      expect(typeof data.kpis.totalUsers).toBe('number');
      expect(typeof data.kpis.grossRevenue).toBe('number');
      expect(typeof data.kpis.netRevenue).toBe('number');
      expect(typeof data.kpis.completionRate).toBe('number');
      expect(typeof data.disputes.averageResolutionHours).toBe('number');
      expect(typeof data.disputes.openPast48h).toBe('number');
      expect(data.disputes.slaHours).toBe(48);
      expect(Array.isArray(data.series.userGrowth)).toBe(true);
      expect(Array.isArray(data.topServiceCategories)).toBe(true);
      expect(Array.isArray(data.topArtisans)).toBe(true);
    });

    it('AP4: completion rate is consistent with the counts it is derived from', async () => {
      const res = await request(server())
        .get('/api/v1/admin/analytics?range=1y')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      const { kpis } = envelope<AdminAnalytics>(res);
      // Documented definition: completed / (completed + cancelled + expired).
      const expected =
        kpis.terminalJobs === 0
          ? 0
          : Number(((kpis.completedJobs / kpis.terminalJobs) * 100).toFixed(1));
      expect(kpis.completionRate).toBe(expected);
      // Never a division by zero, never above 100.
      expect(kpis.completionRate).toBeGreaterThanOrEqual(0);
      expect(kpis.completionRate).toBeLessThanOrEqual(100);
    });

    it('AN3: a prior-period comparison is present for a bounded range, so a trend is real or absent', async () => {
      const res = await request(server())
        .get('/api/v1/admin/analytics?range=7d')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(envelope<AdminAnalytics>(res).previous).not.toBeNull();
    });

    it('AN2: rejects a range the admin endpoint does not define (all-time is artisan-only)', async () => {
      const res = await request(server())
        .get('/api/v1/admin/analytics?range=all')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(400);
    });

    it.each([
      ['customer', () => customerToken],
      ['artisan', () => artisanToken],
    ])('rejects a %s from GET /admin/analytics with 403', async (_l, tok) => {
      const res = await request(server())
        .get('/api/v1/admin/analytics?range=30d')
        .set('Authorization', `Bearer ${tok()}`);

      expect(res.status).toBe(403);
    });

    it('GET /analytics/artisan returns only the calling artisan’s own data', async () => {
      const res = await request(server())
        .get('/api/v1/analytics/artisan?range=90d')
        .set('Authorization', `Bearer ${artisanToken}`);

      expect(res.status).toBe(200);
      const data = envelope<ArtisanAnalytics>(res);
      expect(data.range).toBe('90d');
      expect(data.bucket).toBe('week');
      expect(data.earnings.currency).toBe('GHS');
      expect(typeof data.earnings.allTime).toBe('number');
      expect(typeof data.earnings.thisMonth).toBe('number');
      expect(typeof data.earnings.lastMonth).toBe('number');
      expect(typeof data.jobCounts.completed).toBe('number');
      expect(typeof data.repeatClients.rate).toBe('number');
      expect(typeof data.overview.completedJobsAllTime).toBe('number');
      // A brand-new artisan must produce honest zeroes, never a fallback figure.
      expect(data.earnings.allTime).toBe(0);
      expect(data.repeatClients.totalClients).toBe(0);
      expect(data.repeatClients.rate).toBe(0);
      expect(data.ratingTrend.hasEnoughDataForTrend).toBe(false);
      // Deliberately absent (no view-tracking mechanism exists).
      expect(data).not.toHaveProperty('portfolioViews');
    });

    it('accepts all-time on the artisan endpoint and buckets it monthly', async () => {
      const res = await request(server())
        .get('/api/v1/analytics/artisan?range=all')
        .set('Authorization', `Bearer ${artisanToken}`);

      expect(res.status).toBe(200);
      expect(envelope<ArtisanAnalytics>(res).bucket).toBe('month');
    });

    it('rejects the admin-only 1y range on the artisan endpoint', async () => {
      const res = await request(server())
        .get('/api/v1/analytics/artisan?range=1y')
        .set('Authorization', `Bearer ${artisanToken}`);

      expect(res.status).toBe(400);
    });

    it.each([
      ['customer', () => customerToken],
      ['admin', () => adminToken],
    ])('rejects a %s from GET /analytics/artisan with 403', async (_l, tok) => {
      const res = await request(server())
        .get('/api/v1/analytics/artisan')
        .set('Authorization', `Bearer ${tok()}`);

      expect(res.status).toBe(403);
    });
  });

  // ─── AT5 / AT6: admin-only reach ─────────────────────────────────────────────

  describe('AT5/AT6: the admin-only surfaces reject non-admins server-side', () => {
    it('finds a user by email via the cross-entity search', async () => {
      const res = await request(server())
        .get(`/api/v1/admin/search?q=${encodeURIComponent(customer.email)}`)
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      const data = envelope<{
        users: { id: number }[];
        jobs: unknown[];
        disputes: unknown[];
      }>(res);
      expect(data.users.map((u) => u.id)).toContain(customer.id);
      expect(Array.isArray(data.jobs)).toBe(true);
      expect(Array.isArray(data.disputes)).toBe(true);
    });

    it('says so plainly when nothing matches, rather than returning a bare empty shape', async () => {
      const res = await request(server())
        .get(`/api/v1/admin/search?q=zzz-no-such-thing-${uniq}`)
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      expect(envelopeMessage(res)).toMatch(/no users, jobs or disputes/i);
    });

    it('rejects a 1-character search term', async () => {
      const res = await request(server())
        .get('/api/v1/admin/search?q=a')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(400);
    });

    it.each([
      ['/api/v1/admin/search?q=test', 'cross-entity search'],
      ['/api/v1/admin/actions', 'audit log'],
      ['/api/v1/admin/disputes', 'dispute queue'],
      ['/api/v1/admin/platform-config', 'platform config'],
    ])('rejects a customer from %s (%s)', async (path) => {
      const res = await request(server())
        .get(path)
        .set('Authorization', `Bearer ${customerToken}`);

      expect(res.status).toBe(403);
    });

    it('AT9: exposes the platform fee percentage the backend actually applies', async () => {
      const res = await request(server())
        .get('/api/v1/admin/platform-config')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      const data = envelope<{
        platformFeePercent: number;
        platformFeeEditable: boolean;
        currency: string;
      }>(res);
      expect(typeof data.platformFeePercent).toBe('number');
      expect(data.platformFeePercent).toBeGreaterThanOrEqual(0);
      expect(data.platformFeePercent).toBeLessThanOrEqual(100);
      expect(data.platformFeeEditable).toBe(false);
      expect(data.currency).toBe('GHS');
    });
  });

  // ─── DR1/DR2/DR4/DR5/DP2: the dispute lifecycle ──────────────────────────────

  describe('the dispute lifecycle, end to end', () => {
    it('DR5: rejects a dispute filed with no category', async () => {
      const booking = await makeBooking();

      const res = await request(server())
        .post('/api/v1/disputes')
        .set('Authorization', `Bearer ${customerToken}`)
        .send({
          bookingId: booking.id,
          reason:
            'A reason long enough to pass validation but with no category set.',
        });

      expect(res.status).toBe(400);
    });

    it('DR4: notifies the counterparty when a dispute is filed against them', async () => {
      const booking = await makeBooking();
      await raiseDispute(customerToken, booking.id);

      const notes = await waitForNotifications(artisanUser.id, 'DISPUTE_FILED');
      expect(notes.length).toBeGreaterThan(0);
      // Their copy asks for a response — it is not the admin's queue copy.
      expect(notes[0].body).toMatch(/submit your response/i);
    });

    it('DR4/DP2: the counterparty can read and answer once, and the raiser cannot answer at all', async () => {
      const booking = await makeBooking();
      const disputeId = await raiseDispute(customerToken, booking.id);

      // The counterparty can read it even though they didn't file it.
      const read = await request(server())
        .get(`/api/v1/disputes/my/${disputeId}`)
        .set('Authorization', `Bearer ${artisanToken}`);
      expect(read.status).toBe(200);
      const asCounterparty = envelope<PartyDispute>(read);
      expect(asCounterparty.viewerRole).toBe('COUNTERPARTY');
      expect(asCounterparty.canRespond).toBe(true);
      // DP2: a party must never see admin-internal notes.
      expect(asCounterparty).not.toHaveProperty('adminNotes');

      const first = await request(server())
        .post(`/api/v1/disputes/${disputeId}/respond`)
        .set('Authorization', `Bearer ${artisanToken}`)
        .send({
          response:
            'I attended on the agreed date and completed the work as described.',
        });
      expect(first.status).toBe(201);
      expect(envelope<PartyDispute>(first).canRespond).toBe(false);

      // Only one response is allowed.
      const second = await request(server())
        .post(`/api/v1/disputes/${disputeId}/respond`)
        .set('Authorization', `Bearer ${artisanToken}`)
        .send({
          response:
            'Actually there is one more thing I would like to add to this.',
        });
      expect(second.status).toBe(400);

      // The raiser's claim is already their statement.
      const byRaiser = await request(server())
        .post(`/api/v1/disputes/${disputeId}/respond`)
        .set('Authorization', `Bearer ${customerToken}`)
        .send({
          response:
            'Adding further detail to the complaint I originally filed here.',
        });
      expect(byRaiser.status).toBe(403);

      // A non-participant is told nothing — 404, never 403.
      const byStranger = await request(server())
        .get(`/api/v1/disputes/my/${disputeId}`)
        .set('Authorization', `Bearer ${strangerToken}`);
      expect(byStranger.status).toBe(404);
    });

    it('DQ1: filters the admin queue by category and searches the whole set', async () => {
      const booking = await makeBooking();
      const disputeId = await raiseDispute(
        customerToken,
        booking.id,
        DisputeCategory.PROPERTY_DAMAGE,
      );

      const byCategory = await request(server())
        .get('/api/v1/admin/disputes?category=PROPERTY_DAMAGE&limit=100')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(byCategory.status).toBe(200);
      const ids = envelope<{ id: number; category: string }[]>(byCategory).map(
        (d) => d.id,
      );
      expect(ids).toContain(disputeId);

      // Searching by the dispute's own id must find it regardless of paging.
      const byId = await request(server())
        .get(`/api/v1/admin/disputes?q=${disputeId}`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(byId.status).toBe(200);
      expect(envelope<{ id: number }[]>(byId).map((d) => d.id)).toContain(
        disputeId,
      );

      // A filter that matches nothing is an honest empty set, not an error.
      const none = await request(server())
        .get(`/api/v1/admin/disputes?q=zzz-nothing-${uniq}`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(none.status).toBe(200);
      expect(envelope<unknown[]>(none)).toHaveLength(0);
    });

    it('DQ2/DR6: the queue summary counts the whole set and carries the SLA figures', async () => {
      const res = await request(server())
        .get('/api/v1/admin/disputes/summary')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      const data = envelope<{
        counts: {
          open: number;
          underReview: number;
          resolved: number;
          closed: number;
          total: number;
        };
        sla: {
          averageResolutionHours: number;
          openPast48h: number;
          slaHours: number;
        };
      }>(res);

      const { counts } = data;
      expect(
        counts.open + counts.underReview + counts.resolved + counts.closed,
      ).toBe(counts.total);
      // At least the disputes this spec filed are in there — proof the counts
      // are not scoped to a page.
      expect(counts.total).toBeGreaterThanOrEqual(createdDisputeIds.length);
      expect(data.sla.slaHours).toBe(48);
      expect(typeof data.sla.averageResolutionHours).toBe('number');
      expect(typeof data.sla.openPast48h).toBe('number');
    });

    it('DQ3: the admin detail response carries the job/booking detail and the money options', async () => {
      const booking = await makeBooking();
      const disputeId = await raiseDispute(customerToken, booking.id);

      const res = await request(server())
        .get(`/api/v1/admin/disputes/${disputeId}`)
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      const data = envelope<{
        work: {
          bookingId: number;
          service: { name: string } | null;
          scheduledDate: string;
          bookingStatus: string;
          agreedPrice: number | null;
        } | null;
        counterparty: { id: number; role: string } | null;
        payment: unknown;
        moneyOptions: {
          canRefund: boolean;
          canRelease: boolean;
          reason?: string;
        };
        siblingDisputes: unknown[];
      }>(res);

      expect(data.work?.bookingId).toBe(booking.id);
      expect(data.work?.service?.name).toBe(service.name);
      expect(data.work?.bookingStatus).toBe(BookingStatus.COMPLETED);
      expect(data.work?.agreedPrice).toBe(150);
      expect(data.counterparty?.id).toBe(artisanUser.id);
      // This booking never produced a paid job, which is an expected state:
      // both money verdicts are refused with a stated reason.
      expect(data.payment).toBeNull();
      expect(data.moneyOptions.canRefund).toBe(false);
      expect(data.moneyOptions.canRelease).toBe(false);
      expect(data.moneyOptions.reason).toMatch(/no payment is linked/i);
      expect(Array.isArray(data.siblingDisputes)).toBe(true);
    });

    it('DR1/DR2/AT5: a verdict is mandatory, MUTUAL records that no money moved, and the ruling is audited', async () => {
      const booking = await makeBooking();
      const disputeId = await raiseDispute(customerToken, booking.id);

      // A resolution note alone is no longer a valid ruling.
      const noVerdict = await request(server())
        .patch(`/api/v1/admin/disputes/${disputeId}/resolve`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ resolution: 'Resolved somehow, without saying which way.' });
      expect(noVerdict.status).toBe(400);

      const resolved = await request(server())
        .patch(`/api/v1/admin/disputes/${disputeId}/resolve`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          outcome: DisputeOutcome.MUTUAL,
          resolution: 'Both parties settled this between themselves.',
          adminNotes: 'QA internal note that no party may ever see.',
        });
      expect(resolved.status).toBe(200);
      const outcome = envelope<{
        outcome: DisputeOutcome;
        moneyAction: DisputeMoneyAction;
        moneyAmount: number | null;
      }>(resolved);
      expect(outcome.outcome).toBe(DisputeOutcome.MUTUAL);
      expect(outcome.moneyAction).toBe(DisputeMoneyAction.NONE);
      expect(outcome.moneyAmount).toBeNull();

      // The existing already-resolved guard must not regress.
      const again = await request(server())
        .patch(`/api/v1/admin/disputes/${disputeId}/resolve`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          outcome: DisputeOutcome.MUTUAL,
          resolution: 'Trying to rule on this a second time.',
        });
      expect(again.status).toBe(400);

      // AT5: the ruling wrote an audit row carrying the verdict.
      const rows = await auditRepo.find({
        where: {
          action: AdminActionType.DISPUTE_RESOLVE,
          targetId: disputeId,
        },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].actorId).toBe(adminUser.id);
      expect(rows[0].outcome).toBe(DisputeOutcome.MUTUAL);
      expect(rows[0].moneyAction).toBe(DisputeMoneyAction.NONE);
      // No FKs: the row snapshots who acted and what was acted on.
      expect(rows[0].actorEmail).toBe(adminUser.email);
      expect(rows[0].targetLabel).toContain(`Dispute #${disputeId}`);

      // DR4: the counterparty can no longer respond once it is resolved.
      const lateResponse = await request(server())
        .post(`/api/v1/disputes/${disputeId}/respond`)
        .set('Authorization', `Bearer ${artisanToken}`)
        .send({
          response: 'Responding after the ruling has already been recorded.',
        });
      expect(lateResponse.status).toBe(400);

      // DP2: still no admin notes on the party-facing read.
      const partyRead = await request(server())
        .get(`/api/v1/disputes/my/${disputeId}`)
        .set('Authorization', `Bearer ${customerToken}`);
      expect(partyRead.status).toBe(200);
      const asParty = envelope<PartyDispute>(partyRead);
      expect(asParty).not.toHaveProperty('adminNotes');
      expect(asParty.outcome).toBe(DisputeOutcome.MUTUAL);
      expect(asParty.moneyAction).toBe(DisputeMoneyAction.NONE);

      // The conversation route's settled 403 still applies once resolved.
      const conversation = await request(server())
        .get(`/api/v1/admin/disputes/${disputeId}/conversation`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(conversation.status).toBe(403);
    });

    it('DP2: /disputes/my covers disputes filed against the caller, not just the ones they filed', async () => {
      const res = await request(server())
        .get('/api/v1/disputes/my')
        .set('Authorization', `Bearer ${artisanToken}`);

      expect(res.status).toBe(200);
      const mine = envelope<PartyDispute[]>(res);
      // The artisan filed none of these — they are all against them.
      expect(mine.length).toBeGreaterThan(0);
      expect(mine.every((d) => d.viewerRole === 'COUNTERPARTY')).toBe(true);
    });
  });

  // ─── AT3: suspension ─────────────────────────────────────────────────────────

  describe('AT3: suspension blocks transacting and reactivation restores it', () => {
    it('suspends, blocks a new booking, then fully restores on activate', async () => {
      const suspend = await request(server())
        .patch(`/api/v1/admin/users/${stranger.id}/suspend`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ reason: 'QA suspension check for the e2e boundary test.' });
      expect(suspend.status).toBe(200);

      // A suspended user can still authenticate — suspension is not a ban.
      const read = await request(server())
        .get('/api/v1/disputes/my')
        .set('Authorization', `Bearer ${strangerToken}`);
      expect(read.status).toBe(200);

      // But cannot transact.
      const booking = await request(server())
        .post('/api/v1/bookings')
        .set('Authorization', `Bearer ${strangerToken}`)
        .send({
          artisanProfileId: artisanProfile.id,
          serviceId: service.id,
          scheduledDate: '2026-12-01',
          startTime: '09:00',
        });
      expect(booking.status).toBe(403);
      expect(JSON.stringify(booking.body)).toMatch(/suspended/i);

      const activate = await request(server())
        .patch(`/api/v1/admin/users/${stranger.id}/activate`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(activate.status).toBe(200);

      const after = await userRepo.findOne({ where: { id: stranger.id } });
      expect(after?.isSuspended).toBe(false);
      expect(after?.suspendedAt ?? null).toBeNull();
      expect(after?.suspensionReason ?? null).toBeNull();

      // The suspend and activate actions are both audited.
      const rows = await auditRepo.find({
        where: { targetId: stranger.id, actorId: adminUser.id },
      });
      const actions = rows.map((r) => r.action);
      expect(actions).toContain(AdminActionType.USER_SUSPEND);
      expect(actions).toContain(AdminActionType.USER_ACTIVATE);
    });

    it('refuses to let an admin suspend their own account', async () => {
      const res = await request(server())
        .patch(`/api/v1/admin/users/${adminUser.id}/suspend`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ reason: 'Attempting to suspend my own admin account.' });

      expect(res.status).toBe(400);
      expect(JSON.stringify(res.body)).toMatch(/cannot suspend yourself/i);
    });

    it('requires a reason of at least 10 characters', async () => {
      const res = await request(server())
        .patch(`/api/v1/admin/users/${stranger.id}/suspend`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ reason: 'nope' });

      expect(res.status).toBe(400);
    });
  });

  // ─── AT5: the audit log read path ────────────────────────────────────────────

  describe('AT5: the audit log is readable, paginated and filterable', () => {
    it('returns newest-first rows filterable by action type and acting admin', async () => {
      const res = await request(server())
        .get(
          `/api/v1/admin/actions?actorId=${adminUser.id}&action=${AdminActionType.USER_SUSPEND}`,
        )
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      const rows =
        envelope<
          { action: AdminActionType; actorId: number; createdAt: string }[]
        >(res);
      expect(rows.length).toBeGreaterThan(0);
      expect(
        rows.every(
          (r) =>
            r.action === AdminActionType.USER_SUSPEND &&
            r.actorId === adminUser.id,
        ),
      ).toBe(true);
    });

    it('scopes to one entity, which is what the shared action-history dialog needs', async () => {
      const res = await request(server())
        .get(`/api/v1/admin/actions?targetType=USER&targetId=${stranger.id}`)
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      const rows = envelope<{ targetId: number; targetType: string }[]>(res);
      expect(rows.length).toBeGreaterThan(0);
      expect(
        rows.every(
          (r) => r.targetType === 'USER' && r.targetId === stranger.id,
        ),
      ).toBe(true);
    });
  });
});

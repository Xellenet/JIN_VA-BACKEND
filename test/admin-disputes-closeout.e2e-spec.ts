import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, FindOneOptions, Repository } from 'typeorm';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { ResponseInterceptor } from '../src/common/interceptors/response.interceptor';
import { User } from '@users/entities/user.entity';
import { ArtisanProfile } from '@users/entities/artisan-profile.entity';
import { ServiceEntity } from '@services/entities/service.entity';
import { Booking } from '../src/bookings/entities/booking.entity';
import { Job } from '@jobs/entities/job.entity';
import { Payment } from '../src/payments/entities/payment.entity';
import { Dispute } from '../src/disputes/entities/dispute.entity';
import { UserTokenService } from '@users/token.service';
import { PaystackService } from '../src/payments/paystack.service';
import {
  BookingStatus,
  DisputeCategory,
  DisputeMoneyAction,
  DisputeStatus,
  PaymentStatus,
  Role,
  Status,
} from '@common/types/enums';

/**
 * Regression suite for the `admin-disputes-closeout` fix round — the findings
 * `security-report.md` (B1-B5) and `qa-report.md` (QA-DC1-01) raised against
 * the dispute money path.
 *
 * Each test here exists because a reviewer found the behaviour it asserts to be
 * wrong, and every one of them fails on the code as it shipped:
 *
 *  - **B1 (HIGH)** — a party's `respond()` used `repo.save(dispute)` on the
 *    entity it loaded at the top of the request. `save()` writes back every
 *    column that differs from a fresh read, so an admin's `resolve()`
 *    committing in between was reverted: a dispute whose money had already
 *    moved went back to `OPEN`, which re-opened the money path and un-revoked
 *    AD2's admin access to the two parties' private thread. Reproduced here
 *    deterministically by committing a real resolve *between* the party's load
 *    and their write.
 *  - **B2 / QA-DC1-01** — the rollback after a failed money action passed
 *    `undefined` for five columns, which `UpdateQueryBuilder` strips from the
 *    statement entirely, so a ruling that never took effect left its verdict,
 *    note, resolver and timestamp on the row.
 *  - **B3** — the sibling-dispute money guard read `money_action`, which was
 *    only written *after* the provider call, so two disputes on one payment
 *    could both move money and the DB unique index then surfaced as a `500`.
 *  - **B4** — `GET /admin/disputes/:id` returned the raw `Payment` entity,
 *    including live Paystack checkout/payout handles.
 *  - **B5** — neither `respond` nor `resolve` was rate-limited.
 *
 * `PaystackService` is the only stubbed boundary: it is genuinely external and
 * must never be called from a test. Everything on our side of it is asserted
 * against the real committed rows in Postgres.
 *
 * Every row this spec creates is removed in `afterAll`.
 *
 * Run: npm run test:e2e -- admin-disputes-closeout
 */
jest.setTimeout(180000);

interface Envelope<T> {
  data: T;
  message?: string;
}
function body<T>(res: request.Response): Envelope<T> {
  return res.body as Envelope<T>;
}

/** The one repository method this spec re-points to stage B1's race. */
type DisputeFindOne = (
  options: FindOneOptions<Dispute>,
) => Promise<Dispute | null>;

describe('admin-disputes-closeout — fix-round regressions (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let userRepo: Repository<User>;
  let profileRepo: Repository<ArtisanProfile>;
  let serviceRepo: Repository<ServiceEntity>;
  let bookingRepo: Repository<Booking>;
  let jobRepo: Repository<Job>;
  let paymentRepo: Repository<Payment>;
  let disputeRepo: Repository<Dispute>;
  let tokenService: UserTokenService;

  const paystack = {
    createRefund: jest.fn(),
    initiateTransfer: jest.fn(),
    verifyTransaction: jest.fn(),
    initializeTransaction: jest.fn(),
    verifyWebhookSignature: jest.fn().mockReturnValue(true),
    createRecipient: jest.fn(),
  };

  let customer: User;
  let customerToken: string;
  let artisanUser: User;
  let artisanToken: string;
  let artisanProfile: ArtisanProfile;
  let adminToken: string;
  let service: ServiceEntity;

  const createdUserIds: number[] = [];
  const createdProfileIds: number[] = [];
  const createdBookingIds: number[] = [];
  const createdJobIds: number[] = [];
  const createdPaymentIds: number[] = [];
  const createdDisputeIds: number[] = [];

  const server = () => app.getHttpServer();
  const uniq = Date.now();
  const NOTE =
    'Fix-round regression check on the dispute money path and its guards.';

  async function makeUser(
    label: string,
    role: Role,
  ): Promise<{ user: User; token: string }> {
    const user = await userRepo.save(
      userRepo.create({
        email: `fix-dc-${label}-${uniq}@test.jinva.local`,
        password: null,
        firstname: 'FixDc',
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

  /** A COMPLETED booking, a booking-derived job, and a `HELD` payment on it. */
  async function makeDisputableChain(opts: { withPayment: boolean }): Promise<{
    booking: Booking;
    payment: Payment | null;
  }> {
    const booking = await bookingRepo.save(
      bookingRepo.create({
        customer,
        artisanProfile,
        service,
        scheduledDate: '2026-08-01',
        startTime: '09:00:00',
        endTime: '10:00:00',
        status: BookingStatus.COMPLETED,
        agreedPrice: 200,
        currency: 'GHS',
      }),
    );
    createdBookingIds.push(booking.id);

    const job = await jobRepo.save(
      jobRepo.create({
        customer,
        service,
        title: `Fix DC chain ${uniq}-${booking.id}`,
        description: 'Fixture job derived from a confirmed booking.',
        location: 'Accra',
        currency: 'GHS',
        budgetMin: 200,
        budgetMax: 200,
        status: Status.COMPLETED,
        acceptedArtisan: artisanUser,
        booking,
      }),
    );
    createdJobIds.push(job.id);

    let payment: Payment | null = null;
    if (opts.withPayment) {
      payment = await paymentRepo.save(
        paymentRepo.create({
          jobId: job.id,
          customerId: customer.id,
          artisanProfileId: artisanProfile.id,
          amount: 200,
          platformFee: 10,
          artisanAmount: 190,
          currency: 'GHS',
          status: PaymentStatus.HELD,
          reference: `fix-dc-${uniq}-${job.id}`,
          channel: 'mobile_money',
          paidAt: new Date('2026-08-02T10:00:00Z'),
          // The provider handles B4 must not publish to the browser.
          accessCode: `ACCESS_fix_dc_${uniq}`,
          authorizationUrl: `https://checkout.paystack.test/fix-dc-${uniq}`,
          transferReference: `TRFREF_fix_dc_${uniq}`,
        }),
      );
      createdPaymentIds.push(payment.id);
    }

    return { booking, payment };
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
        reason: `Fix-round dispute ${uniq} filed to verify the write guards.`,
      });
    expect(res.status).toBe(201);
    const id = body<{ id: number }>(res).data.id;
    createdDisputeIds.push(id);
    return id;
  }

  function resolve(
    disputeId: number,
    payload: Record<string, unknown>,
    token = adminToken,
  ) {
    return request(server())
      .patch(`/api/v1/admin/disputes/${disputeId}/resolve`)
      .set('Authorization', `Bearer ${token}`)
      .send(payload);
  }

  function respond(disputeId: number, response: string, token = artisanToken) {
    return request(server())
      .post(`/api/v1/disputes/${disputeId}/respond`)
      .set('Authorization', `Bearer ${token}`)
      .send({ response });
  }

  /**
   * Runs `act()` and, the first time the dispute repository loads
   * `disputeId`, commits `duringLoad()` before handing the (now stale) entity
   * back to the caller.
   *
   * That is exactly B1's race, made deterministic: the party's request has its
   * pre-ruling copy of the row in hand, the admin's ruling commits, and only
   * then does the party's write run.
   */
  async function withCommitDuringLoad<T>(
    disputeId: number,
    duringLoad: () => Promise<unknown>,
    act: () => Promise<T>,
  ): Promise<T> {
    let armed = true;
    const holder = disputeRepo as unknown as { findOne: DisputeFindOne };
    const hadOwnFindOne = Object.hasOwn(disputeRepo, 'findOne');
    const load = holder.findOne.bind(disputeRepo) as DisputeFindOne;

    holder.findOne = async (options) => {
      const loaded = await load(options);
      if (armed && loaded?.id === disputeId) {
        // Disarm first: `duringLoad` reads through the same repository.
        armed = false;
        await duringLoad();
      }
      return loaded;
    };
    try {
      return await act();
    } finally {
      if (hadOwnFindOne) holder.findOne = load;
      else Reflect.deleteProperty(disputeRepo, 'findOne');
    }
  }

  /**
   * Runs `act()` and, the first time a ruling's **sibling-money guard** reads
   * the dispute table, commits `duringGuard()` afterwards — so `act()`'s guard
   * result is the pre-ruling one.
   *
   * That is B3's race with the timing pinned: the guard answers "no sibling has
   * moved money on this payment", the other ruling then moves it, and only
   * afterwards does this ruling reach its own write. The guard is recognised by
   * the one query in the service that filters on `moneyPaymentId`.
   */
  async function withCommitDuringSiblingGuard<T>(
    duringGuard: () => Promise<unknown>,
    act: () => Promise<T>,
  ): Promise<T> {
    let armed = true;
    const holder = disputeRepo as unknown as { findOne: DisputeFindOne };
    const hadOwnFindOne = Object.hasOwn(disputeRepo, 'findOne');
    const load = holder.findOne.bind(disputeRepo) as DisputeFindOne;

    holder.findOne = async (options) => {
      const where = options?.where;
      const isSiblingGuard =
        !!where && !Array.isArray(where) && 'moneyPaymentId' in where;
      const loaded = await load(options);
      if (armed && isSiblingGuard) {
        armed = false;
        await duringGuard();
      }
      return loaded;
    };
    try {
      return await act();
    } finally {
      if (hadOwnFindOne) holder.findOne = load;
      else Reflect.deleteProperty(disputeRepo, 'findOne');
    }
  }

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PaystackService)
      .useValue(paystack)
      .compile();

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

    dataSource = moduleFixture.get(DataSource);
    userRepo = moduleFixture.get(getRepositoryToken(User));
    profileRepo = moduleFixture.get(getRepositoryToken(ArtisanProfile));
    serviceRepo = moduleFixture.get(getRepositoryToken(ServiceEntity));
    bookingRepo = moduleFixture.get(getRepositoryToken(Booking));
    jobRepo = moduleFixture.get(getRepositoryToken(Job));
    paymentRepo = moduleFixture.get(getRepositoryToken(Payment));
    disputeRepo = moduleFixture.get(getRepositoryToken(Dispute));
    tokenService = moduleFixture.get(UserTokenService);

    service = await serviceRepo.save(
      serviceRepo.create({
        name: `Fix DC Service ${uniq}`,
        estimatedDurationMins: 60,
      }),
    );

    ({ user: customer, token: customerToken } = await makeUser(
      'Client',
      Role.CUSTOMER,
    ));
    ({ user: artisanUser, token: artisanToken } = await makeUser(
      'Artisan',
      Role.ARTISAN,
    ));
    ({ token: adminToken } = await makeUser('Admin', Role.ADMIN));

    artisanProfile = await profileRepo.save(
      profileRepo.create({
        user: artisanUser,
        currency: 'GHS',
        paystackRecipientCode: `RCP_fix_dc_${uniq}`,
      }),
    );
    createdProfileIds.push(artisanProfile.id);
  });

  afterAll(async () => {
    if (createdDisputeIds.length) {
      await disputeRepo.delete(createdDisputeIds);
    }
    if (createdPaymentIds.length) {
      await paymentRepo.delete(createdPaymentIds);
    }
    if (createdJobIds.length) {
      await dataSource.query(
        `DELETE FROM job_status_history WHERE job_id = ANY($1)`,
        [createdJobIds],
      );
      await jobRepo.delete(createdJobIds);
    }
    if (createdBookingIds.length) {
      await bookingRepo.delete(createdBookingIds);
    }
    if (createdProfileIds.length) {
      await profileRepo.delete(createdProfileIds);
    }
    if (createdUserIds.length) {
      await dataSource.query(
        `DELETE FROM notifications WHERE user_id = ANY($1)`,
        [createdUserIds],
      );
      await userRepo.delete(createdUserIds);
    }
    await serviceRepo.delete(service.id);
    await app.close();
  });

  beforeEach(() => {
    paystack.createRefund.mockReset().mockResolvedValue({ status: true });
    paystack.initiateTransfer
      .mockReset()
      .mockResolvedValue({ transfer_code: `TRF_fix_${uniq}` });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // B1 — a response must never revert a ruling
  // ───────────────────────────────────────────────────────────────────────────

  describe('B1: a response committed during a resolve cannot revert the ruling', () => {
    it('keeps the dispute RESOLVED, refuses the response, and does not move money twice', async () => {
      const { booking, payment } = await makeDisputableChain({
        withPayment: true,
      });
      const disputeId = await raiseDispute(customerToken, booking.id);

      // The counterparty's response request loads the dispute while it is
      // still OPEN; the admin's REFUND_CLIENT ruling then commits in the gap
      // before the response is written.
      const res = await withCommitDuringLoad(
        disputeId,
        () =>
          resolve(disputeId, {
            outcome: 'REFUND_CLIENT',
            resolution: NOTE,
          }).expect(200),
        () =>
          respond(disputeId, 'My side of it, submitted as the admin rules.'),
      );

      // The response is refused with the state that actually applies now...
      expect(res.status).toBe(400);
      expect(body<unknown>(res).message).toMatch(
        /RESOLVED and can no longer receive a response/i,
      );

      // ...and the ruling stands, untouched.
      const after = await disputeRepo.findOneByOrFail({ id: disputeId });
      expect(after.status).toBe(DisputeStatus.RESOLVED);
      expect(after.outcome).toBe('REFUND_CLIENT');
      expect(after.moneyAction).toBe(DisputeMoneyAction.REFUND);
      expect(Number(after.moneyAmount)).toBe(200);
      // Nothing of the response was written.
      expect(after.response ?? null).toBeNull();
      expect(after.respondedById ?? null).toBeNull();

      // The reverted dispute used to become actionable again, which is what
      // made a second money movement on one payment reachable.
      expect(paystack.createRefund).toHaveBeenCalledTimes(1);
      const paymentAfter = await paymentRepo.findOneByOrFail({
        id: payment!.id,
      });
      expect(Number(paymentAfter.refundedAmount)).toBe(200);
      expect(paymentAfter.status).toBe(PaymentStatus.REFUNDED);
    });

    it('also holds when the ruling is a CLOSE rather than a RESOLVE', async () => {
      const { booking } = await makeDisputableChain({ withPayment: false });
      const disputeId = await raiseDispute(customerToken, booking.id);

      const res = await withCommitDuringLoad(
        disputeId,
        () =>
          request(server())
            .patch(`/api/v1/admin/disputes/${disputeId}/close`)
            .set('Authorization', `Bearer ${adminToken}`)
            .send({})
            .expect(200),
        () => respond(disputeId, 'Responding just as support closes this out.'),
      );

      expect(res.status).toBe(400);
      const after = await disputeRepo.findOneByOrFail({ id: disputeId });
      expect(after.status).toBe(DisputeStatus.CLOSED);
      expect(after.response ?? null).toBeNull();
    });

    it('records the response normally when no ruling intervenes', async () => {
      const { booking } = await makeDisputableChain({ withPayment: false });
      const disputeId = await raiseDispute(customerToken, booking.id);

      const res = await respond(
        disputeId,
        'I attended as agreed but nobody was there to let me in.',
      );

      expect(res.status).toBe(201);
      const after = await disputeRepo.findOneByOrFail({ id: disputeId });
      expect(after.response).toMatch(/nobody was there/);
      expect(after.respondedById).toBe(artisanUser.id);
      expect(after.respondedAt).toBeTruthy();
      // The response write must not disturb anything else on the row.
      expect(after.status).toBe(DisputeStatus.OPEN);
      expect(after.outcome ?? null).toBeNull();

      // And a second response is still refused — now atomically.
      const second = await respond(disputeId, 'Actually, one more thing.');
      expect(second.status).toBe(400);
      expect(body<unknown>(second).message).toMatch(/already responded/i);
    });

    it('start-review cannot revert a ruling either', async () => {
      const { booking } = await makeDisputableChain({ withPayment: false });
      const disputeId = await raiseDispute(customerToken, booking.id);

      const res = await withCommitDuringLoad(
        disputeId,
        () =>
          resolve(disputeId, { outcome: 'MUTUAL', resolution: NOTE }).expect(
            200,
          ),
        () =>
          request(server())
            .patch(`/api/v1/admin/disputes/${disputeId}/start-review`)
            .set('Authorization', `Bearer ${adminToken}`)
            .send({}),
      );

      expect(res.status).toBe(400);
      expect(body<unknown>(res).message).toMatch(/current status is RESOLVED/i);
      const after = await disputeRepo.findOneByOrFail({ id: disputeId });
      expect(after.status).toBe(DisputeStatus.RESOLVED);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // B2 / QA-DC1-01 — a rolled-back ruling must leave no trace
  // ───────────────────────────────────────────────────────────────────────────

  describe('B2: a failed money action rolls the whole ruling back', () => {
    it('restores all six verdict columns, not just status', async () => {
      const { booking, payment } = await makeDisputableChain({
        withPayment: true,
      });
      const disputeId = await raiseDispute(customerToken, booking.id);

      paystack.createRefund.mockRejectedValueOnce(
        new Error('Paystack declined the refund (forced failure)'),
      );

      const res = await resolve(disputeId, {
        outcome: 'REFUND_CLIENT',
        resolution: NOTE,
        adminNotes: 'Internal note attached to a ruling that never happened.',
      });

      expect(res.status).toBe(400);
      expect(body<unknown>(res).message).toMatch(/has NOT been resolved/i);

      const after = await disputeRepo.findOneByOrFail({ id: disputeId });
      expect(after.status).toBe(DisputeStatus.OPEN);
      expect(after.outcome ?? null).toBeNull();
      expect(after.resolution ?? null).toBeNull();
      expect(after.resolvedById ?? null).toBeNull();
      expect(after.resolvedAt ?? null).toBeNull();
      expect(after.moneyAction ?? null).toBeNull();
      // Not in either report's list, but written by the same claim and cleared
      // by the same rollback.
      expect(after.adminNotes ?? null).toBeNull();
      // B3's claim columns have to come back off the row too, or the payment
      // stays claimed by a ruling that never happened.
      expect(after.moneyAmount ?? null).toBeNull();
      expect(after.moneyPaymentId ?? null).toBeNull();

      const paymentAfter = await paymentRepo.findOneByOrFail({
        id: payment!.id,
      });
      expect(Number(paymentAfter.refundedAmount ?? 0)).toBe(0);
      expect(paymentAfter.status).toBe(PaymentStatus.HELD);
    });

    it('leaves no verdict on the admin read and no phantom outcome on the party read', async () => {
      const { booking } = await makeDisputableChain({ withPayment: true });
      const disputeId = await raiseDispute(customerToken, booking.id);

      paystack.createRefund.mockRejectedValueOnce(
        new Error('Paystack declined the refund (forced failure)'),
      );
      await resolve(disputeId, {
        outcome: 'REFUND_CLIENT',
        resolution: NOTE,
      }).expect(400);

      const adminRead = await request(server())
        .get(`/api/v1/admin/disputes/${disputeId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      const adminDispute = body<Record<string, unknown>>(adminRead).data;
      expect(adminDispute.status).toBe(DisputeStatus.OPEN);
      // DC1.5: no row badge change on a rolled-back ruling. The queue renders
      // the badge straight off `outcome`, so it has to be absent.
      expect(adminDispute.outcome ?? null).toBeNull();
      expect(adminDispute.resolvedAt ?? null).toBeNull();

      const partyRead = await request(server())
        .get(`/api/v1/disputes/my/${disputeId}`)
        .set('Authorization', `Bearer ${customerToken}`)
        .expect(200);
      const partyDispute = body<Record<string, unknown>>(partyRead).data;
      expect(partyDispute.outcome ?? null).toBeNull();
      expect(partyDispute.resolution ?? null).toBeNull();
      expect(partyDispute.resolvedAt ?? null).toBeNull();
    });

    it('keeps the dispute out of the resolved side of the SLA figures', async () => {
      const { booking } = await makeDisputableChain({ withPayment: true });
      const disputeId = await raiseDispute(customerToken, booking.id);

      paystack.createRefund.mockRejectedValueOnce(
        new Error('Paystack declined the refund (forced failure)'),
      );
      await resolve(disputeId, {
        outcome: 'REFUND_CLIENT',
        resolution: NOTE,
      }).expect(400);

      // `getResolutionMetrics` counts a dispute as resolved on
      // `resolved_at IS NOT NULL` and as open on its status, so a rolled-back
      // ruling used to land in both and drag a fabricated resolution time into
      // the platform average.
      const summary = await request(server())
        .get('/api/v1/admin/disputes/summary')
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);
      const { counts, sla } = body<{
        counts: { resolved: number; closed: number };
        sla: { resolvedCount: number };
      }>(summary).data;
      expect(sla.resolvedCount).toBeLessThanOrEqual(
        counts.resolved + counts.closed,
      );
    });

    it('is still resolvable afterwards, with the money moving exactly once', async () => {
      const { booking, payment } = await makeDisputableChain({
        withPayment: true,
      });
      const disputeId = await raiseDispute(customerToken, booking.id);

      paystack.createRefund.mockRejectedValueOnce(
        new Error('Paystack declined the refund (forced failure)'),
      );
      await resolve(disputeId, {
        outcome: 'REFUND_CLIENT',
        resolution: NOTE,
      }).expect(400);

      // The dispute is actionable again, which is the whole point of rolling
      // back — and the retry must not be blocked by a stale money claim.
      const retry = await resolve(disputeId, {
        outcome: 'REFUND_CLIENT',
        resolution: NOTE,
      });
      expect(retry.status).toBe(200);
      const { data } = body<{ moneyAction: string; moneyAmount: number }>(
        retry,
      );
      expect(data.moneyAction).toBe('REFUND');
      expect(Number(data.moneyAmount)).toBe(200);

      const paymentAfter = await paymentRepo.findOneByOrFail({
        id: payment!.id,
      });
      expect(Number(paymentAfter.refundedAmount)).toBe(200);
      expect(paystack.createRefund).toHaveBeenCalledTimes(2); // one failed, one accepted
    });

    it('never leaves an actionable dispute carrying a verdict (the migration invariant)', async () => {
      // The state the repair migration cleared, asserted as an invariant so a
      // future regression shows up as a failing test rather than as a wrong
      // badge in the admin queue.
      const contradictory = await disputeRepo
        .createQueryBuilder('d')
        .where('d.status IN (:...active)', {
          active: [DisputeStatus.OPEN, DisputeStatus.UNDER_REVIEW],
        })
        .andWhere(
          '(d.outcome IS NOT NULL OR d.resolution IS NOT NULL ' +
            'OR d.resolved_by_id IS NOT NULL OR d.resolved_at IS NOT NULL)',
        )
        .getCount();
      expect(contradictory).toBe(0);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // B3 — two disputes, one payment, one movement
  // ───────────────────────────────────────────────────────────────────────────

  describe('B3: two disputes on one payment cannot both move the money', () => {
    it('lets only one claim the payment when the sibling guard is raced, with no 500', async () => {
      const { booking, payment } = await makeDisputableChain({
        withPayment: true,
      });
      const clientDispute = await raiseDispute(
        customerToken,
        booking.id,
        DisputeCategory.WORK_QUALITY,
      );
      const artisanDispute = await raiseDispute(
        artisanToken,
        booking.id,
        DisputeCategory.PAYMENT_AMOUNT,
      );

      // The artisan's dispute is ruled first in wall-clock terms, but its
      // sibling guard has already answered "nothing has moved" by the time the
      // client's dispute refunds the whole payment.
      const second = await withCommitDuringSiblingGuard(
        () =>
          resolve(clientDispute, {
            outcome: 'REFUND_CLIENT',
            resolution: NOTE,
          }).expect(200),
        () =>
          resolve(artisanDispute, {
            outcome: 'RELEASE_ARTISAN',
            resolution: NOTE,
          }),
      );

      // Before the fix this reached the provider, released the money a second
      // time, and *then* hit the unique index on the too-late write — i.e. a
      // 500 after money had moved twice.
      expect(second.status).toBe(200);
      const { data } = body<{
        moneyAction: string;
        moneySkippedReason: string | null;
      }>(second);
      expect(data.moneyAction).toBe('NONE');
      expect(data.moneySkippedReason).toMatch(/claimed the money action/i);

      // Exactly one movement across both rulings.
      expect(paystack.createRefund).toHaveBeenCalledTimes(1);
      expect(paystack.initiateTransfer).not.toHaveBeenCalled();

      const paymentAfter = await paymentRepo.findOneByOrFail({
        id: payment!.id,
      });
      expect(Number(paymentAfter.refundedAmount)).toBe(200);
      expect(paymentAfter.transferCode ?? null).toBeNull();

      // Both verdicts are recorded; only one holds the payment.
      const first = await disputeRepo.findOneByOrFail({ id: clientDispute });
      const other = await disputeRepo.findOneByOrFail({ id: artisanDispute });
      expect(first.moneyAction).toBe(DisputeMoneyAction.REFUND);
      expect(first.moneyPaymentId).toBe(payment!.id);
      expect(other.status).toBe(DisputeStatus.RESOLVED);
      expect(other.outcome).toBe('RELEASE_ARTISAN');
      expect(other.moneyAction).toBe(DisputeMoneyAction.NONE);
      expect(other.moneyPaymentId ?? null).toBeNull();
    });

    it('holds under two genuinely simultaneous rulings on one payment', async () => {
      const { booking, payment } = await makeDisputableChain({
        withPayment: true,
      });
      const clientDispute = await raiseDispute(
        customerToken,
        booking.id,
        DisputeCategory.WORK_QUALITY,
      );
      const artisanDispute = await raiseDispute(
        artisanToken,
        booking.id,
        DisputeCategory.PAYMENT_AMOUNT,
      );

      const [a, b] = await Promise.all([
        resolve(clientDispute, {
          outcome: 'REFUND_CLIENT',
          resolution: NOTE,
          refundAmountGhs: 120,
        }),
        resolve(artisanDispute, {
          outcome: 'RELEASE_ARTISAN',
          resolution: NOTE,
        }),
      ]);

      // Which of the two wins the payment claim is a genuine race and is
      // deliberately not asserted. What must hold either way: both are valid
      // rulings, neither is a 500 (the pre-fix failure mode), and the money
      // moves exactly once.
      expect([a.status, b.status]).toEqual([200, 200]);
      const actions = [a, b].map(
        (res) => body<{ moneyAction: string }>(res).data.moneyAction,
      );
      const movedActions = actions.filter((action) => action !== 'NONE');
      expect(movedActions).toHaveLength(1);

      const gatewayCalls =
        paystack.createRefund.mock.calls.length +
        paystack.initiateTransfer.mock.calls.length;
      expect(gatewayCalls).toBe(1);

      const paymentAfter = await paymentRepo.findOneByOrFail({
        id: payment!.id,
      });
      if (movedActions[0] === 'REFUND') {
        expect(Number(paymentAfter.refundedAmount)).toBe(120);
        expect(paymentAfter.transferCode ?? null).toBeNull();
      } else {
        expect(Number(paymentAfter.refundedAmount ?? 0)).toBe(0);
        expect(paymentAfter.transferCode).toBeTruthy();
      }
    });

    it('leaves the payment claimable again when the winner’s money action fails', async () => {
      const { booking, payment } = await makeDisputableChain({
        withPayment: true,
      });
      const clientDispute = await raiseDispute(
        customerToken,
        booking.id,
        DisputeCategory.WORK_QUALITY,
      );
      const artisanDispute = await raiseDispute(
        artisanToken,
        booking.id,
        DisputeCategory.PAYMENT_AMOUNT,
      );

      paystack.createRefund.mockRejectedValueOnce(
        new Error('Paystack declined the refund (forced failure)'),
      );
      await resolve(clientDispute, {
        outcome: 'REFUND_CLIENT',
        resolution: NOTE,
      }).expect(400);

      // The failed ruling released its claim, so the sibling can still act.
      const second = await resolve(artisanDispute, {
        outcome: 'RELEASE_ARTISAN',
        resolution: NOTE,
      });
      expect(second.status).toBe(200);
      expect(body<{ moneyAction: string }>(second).data.moneyAction).toBe(
        'RELEASE',
      );

      const paymentAfter = await paymentRepo.findOneByOrFail({
        id: payment!.id,
      });
      expect(paymentAfter.transferCode).toBeTruthy();
    });

    it('at most one dispute holds the money claim on any payment (the index invariant)', async () => {
      const duplicates = await disputeRepo
        .createQueryBuilder('d')
        .select('d.money_payment_id', 'paymentId')
        .where('d.money_payment_id IS NOT NULL')
        .andWhere('d.money_action <> :none', {
          none: DisputeMoneyAction.NONE,
        })
        .groupBy('d.money_payment_id')
        .having('COUNT(*) > 1')
        .getRawMany();
      expect(duplicates).toEqual([]);
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // B4 — the payment block carries no provider handles
  // ───────────────────────────────────────────────────────────────────────────

  describe('B4: GET /admin/disputes/:id no longer returns the raw Payment entity', () => {
    it('exposes only the five fields the dispute surface reads', async () => {
      const { booking, payment } = await makeDisputableChain({
        withPayment: true,
      });
      const disputeId = await raiseDispute(customerToken, booking.id);

      const res = await request(server())
        .get(`/api/v1/admin/disputes/${disputeId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      const paymentBlock = body<{ payment: Record<string, unknown> }>(res).data
        .payment;
      expect(Object.keys(paymentBlock).sort()).toEqual([
        'amount',
        'id',
        'paidAt',
        'refundedAmount',
        'status',
      ]);
      expect(paymentBlock.id).toBe(payment!.id);
      expect(Number(paymentBlock.amount)).toBe(200);
      expect(paymentBlock.status).toBe(PaymentStatus.HELD);

      // The handles that used to ride along, asserted by value so a rename
      // cannot make this test pass vacuously.
      const raw = JSON.stringify(res.body);
      expect(raw).not.toContain(`ACCESS_fix_dc_${uniq}`);
      expect(raw).not.toContain(`TRFREF_fix_dc_${uniq}`);
      expect(raw).not.toContain('checkout.paystack.test');
      expect(raw).not.toContain(payment!.reference);
      for (const leaked of [
        'accessCode',
        'authorizationUrl',
        'transferCode',
        'transferReference',
      ]) {
        expect(raw).not.toContain(leaked);
      }
    });

    it('still reports no payment as null rather than as an error', async () => {
      const { booking } = await makeDisputableChain({ withPayment: false });
      const disputeId = await raiseDispute(customerToken, booking.id);

      const res = await request(server())
        .get(`/api/v1/admin/disputes/${disputeId}`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      expect(body<{ payment: unknown }>(res).data.payment).toBeNull();
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // B5 — the amplifier is capped (defence in depth, not the fix)
  // ───────────────────────────────────────────────────────────────────────────

  describe('B5: respond and resolve are rate-limited per user', () => {
    /**
     * The limit is `DISPUTE_WRITE_RATE_LIMIT_PER_MINUTE` (default 20) per user
     * **per route**. Each test below uses a freshly created account so it
     * cannot be affected by, or affect, the other cases in this file — the
     * tracker is the user id and the bucket key includes the handler.
     *
     * The requests deliberately target a nonexistent dispute: the guard runs
     * before the handler, so a `404` still consumes quota, and nothing needs
     * to be written to prove the limit exists.
     */
    const DISPUTE_WRITE_LIMIT = 20;

    it('429s a party who bursts responses, with a specific code and retry hint', async () => {
      const { token } = await makeUser(`Burst${uniq}`, Role.CUSTOMER);
      const statuses: number[] = [];

      for (let i = 0; i <= DISPUTE_WRITE_LIMIT; i++) {
        const res = await request(server())
          .post('/api/v1/disputes/99999999/respond')
          .set('Authorization', `Bearer ${token}`)
          .send({
            response: `Burst attempt ${i} against a dispute that does not exist.`,
          });
        statuses.push(res.status);
      }

      // Everything up to the limit is answered on its merits (404 — no such
      // dispute); the one past it is refused by the guard.
      expect(statuses.slice(0, DISPUTE_WRITE_LIMIT)).not.toContain(429);
      expect(statuses[DISPUTE_WRITE_LIMIT]).toBe(429);

      const blocked = await request(server())
        .post('/api/v1/disputes/99999999/respond')
        .set('Authorization', `Bearer ${token}`)
        .send({ response: 'One more attempt after the limit was reached.' });
      expect(blocked.status).toBe(429);
      // Never a bare "Too many requests".
      const payload = blocked.body as { message?: string };
      expect(payload.message).toMatch(/too many dispute updates/i);
    });

    it('429s an admin who bursts rulings, on a counter of its own', async () => {
      const { token } = await makeUser(`BurstAdmin${uniq}`, Role.ADMIN);
      let last = 0;

      for (let i = 0; i <= DISPUTE_WRITE_LIMIT; i++) {
        const res = await request(server())
          .patch('/api/v1/admin/disputes/99999999/resolve')
          .set('Authorization', `Bearer ${token}`)
          .send({ outcome: 'MUTUAL', resolution: NOTE });
        last = res.status;
      }

      expect(last).toBe(429);

      // A *different* route for the same admin is unaffected: the limit is
      // shared configuration, not a shared counter.
      const otherRoute = await request(server())
        .get('/api/v1/admin/disputes/summary')
        .set('Authorization', `Bearer ${token}`);
      expect(otherRoute.status).toBe(200);
    });
  });
});

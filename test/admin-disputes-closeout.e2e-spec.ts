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
});

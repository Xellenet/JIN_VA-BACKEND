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
import { ServiceEntity } from '@services/entities/service.entity';
import { Booking } from '../src/bookings/entities/booking.entity';
import { Job } from '@jobs/entities/job.entity';
import { Payment } from '../src/payments/entities/payment.entity';
import { Dispute } from '../src/disputes/entities/dispute.entity';
import { AdminAction } from '../src/admin-audit/entities/admin-action.entity';
import { DisputesService } from '../src/disputes/disputes.service';
import { UserTokenService } from '@users/token.service';
import { PaystackService } from '../src/payments/paystack.service';
import {
  AdminActionType,
  BookingStatus,
  DisputeCategory,
  DisputeMoneyAction,
  DisputeStatus,
  NotificationType,
  PaymentStatus,
  Role,
  Status,
} from '@common/types/enums';

/**
 * QA verification for `dispute-rollback-status-guard` — security finding B6.
 *
 * The unit tests in `disputes.service.spec.ts` prove the guard against a fake
 * query builder. This spec proves the same thing the only way that settles it:
 * two real admin sessions, the real HTTP routes, the real Postgres rows, with
 * **only** the external payment gateway (`PaystackService`) stubbed — a test
 * must never call a live gateway, and the provider failure has to be forced
 * anyway.
 *
 * The race is driven deterministically rather than by timing luck: the stubbed
 * gateway call is where admin A's provider round-trip happens, so admin B's
 * real `PATCH /admin/disputes/:id/close` request is issued *from inside* that
 * stub, and only then does the gateway reject. That is exactly the interleaving
 * the finding describes, with no sleeps and no flakiness.
 *
 * B6-LIVE-2 additionally executes the pre-fix `WHERE id = :id` UPDATE shape
 * directly against a live row in the post-race state, alongside the shipped
 * predicate, to show the new clauses are load-bearing rather than decorative —
 * the equivalent of mutation-testing the guard without touching product code
 * (QA does not edit feature code).
 *
 * Every row this spec creates is removed in `afterAll`.
 *
 * Run: npm run test:e2e -- dc-b6-rollback-guard
 */
jest.setTimeout(180000);

interface Envelope<T> {
  data: T;
  message?: string;
}

/** A `notifications` row as the raw SQL reads it. */
interface NotificationRow {
  type: string;
  user_id: number;
}
function body<T>(res: request.Response): Envelope<T> {
  return res.body as Envelope<T>;
}

describe('B6: dispute money-action rollback status guard — QA verification (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let userRepo: Repository<User>;
  let profileRepo: Repository<ArtisanProfile>;
  let serviceRepo: Repository<ServiceEntity>;
  let bookingRepo: Repository<Booking>;
  let jobRepo: Repository<Job>;
  let paymentRepo: Repository<Payment>;
  let disputeRepo: Repository<Dispute>;
  let auditRepo: Repository<AdminAction>;
  let tokenService: UserTokenService;
  let disputesService: DisputesService;

  /** The only stubbed boundary: the external payment gateway. */
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
  /** Admin A — the one whose money action fails. */
  let adminA: User;
  let adminAToken: string;
  /** Admin B — the one who legitimately settles the dispute mid-flight. */
  let adminB: User;
  let adminBToken: string;
  let service: ServiceEntity;

  const createdUserIds: number[] = [];
  const createdProfileIds: number[] = [];
  const createdBookingIds: number[] = [];
  const createdJobIds: number[] = [];
  const createdPaymentIds: number[] = [];
  const createdDisputeIds: number[] = [];

  const server = () => app.getHttpServer();
  const uniq = Date.now();

  const PROVIDER_REASON =
    'Paystack declined the refund: insufficient settlement balance (QA forced failure)';
  const NOTE_A = 'Admin A ruling note that must never displace another admin.';
  const NOTE_B = 'Admin B: both parties settled by phone — closing this out.';
  const RESOLUTION_A =
    'Ruling for the client on the photo evidence supplied by both parties.';

  async function makeUser(
    label: string,
    role: Role,
  ): Promise<{ user: User; token: string }> {
    const user = await userRepo.save(
      userRepo.create({
        email: `qa-b6-${label}-${uniq}@test.jinva.local`,
        password: null,
        firstname: 'QaB6',
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

  /** COMPLETED booking + booking-derived job + a payment actually at HELD. */
  async function makeDisputableChain(): Promise<{
    booking: Booking;
    job: Job;
    payment: Payment;
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
        title: `QA B6 chain ${uniq}-${booking.id}`,
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

    const payment = await paymentRepo.save(
      paymentRepo.create({
        jobId: job.id,
        customerId: customer.id,
        artisanProfileId: artisanProfile.id,
        amount: 200,
        platformFee: 10,
        artisanAmount: 190,
        currency: 'GHS',
        status: PaymentStatus.HELD,
        reference: `qa-b6-${uniq}-${job.id}`,
        channel: 'mobile_money',
        paidAt: new Date('2026-08-02T10:00:00Z'),
      }),
    );
    createdPaymentIds.push(payment.id);

    return { booking, job, payment };
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
        reason: `QA B6 dispute ${uniq} filed to verify the rollback status guard.`,
      });
    expect(res.status).toBe(201);
    const id = body<{ id: number }>(res).data.id;
    createdDisputeIds.push(id);
    return id;
  }

  function resolve(
    disputeId: number,
    payload: Record<string, unknown>,
    token: string,
  ) {
    return request(server())
      .patch(`/api/v1/admin/disputes/${disputeId}/resolve`)
      .set('Authorization', `Bearer ${token}`)
      .send(payload);
  }

  function close(
    disputeId: number,
    payload: Record<string, unknown>,
    token: string,
  ) {
    return request(server())
      .patch(`/api/v1/admin/disputes/${disputeId}/close`)
      .set('Authorization', `Bearer ${token}`)
      .send(payload);
  }

  function disputeAudit(disputeId: number) {
    return auditRepo.find({
      where: { targetId: disputeId },
      order: { id: 'ASC' },
    });
  }

  /**
   * The outcome notification is fanned out to both parties by an event
   * listener, so it lands some time after the HTTP response — and noticeably
   * later when the whole e2e suite is hammering the same database. Polls until
   * `expected` rows of `type` exist, then returns every party notification
   * there is (so the caller can also assert on what is *absent*).
   */
  async function partyNotifications(
    type: NotificationType,
    expected: number,
  ): Promise<NotificationRow[]> {
    const deadline = Date.now() + 30000;
    let rows: NotificationRow[] = [];
    do {
      rows = await rawQuery<NotificationRow[]>(
        `SELECT type, user_id FROM notifications WHERE user_id = ANY($1)`,
        [[customer.id, artisanUser.id]],
      );
      if (rows.filter((row) => row.type === String(type)).length >= expected) {
        return rows;
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    } while (Date.now() < deadline);
    return rows;
  }

  /**
   * `dataSource.query` hands back `[rows, affectedCount]` for an UPDATE, so
   * both halves are read explicitly here — the affected count is the whole
   * point of B6-LIVE-2.
   */
  async function updateReturning(
    sql: string,
    params: unknown[],
  ): Promise<{ rows: unknown[]; affected: number }> {
    const [rows, affected] = await rawQuery<[unknown[], number]>(sql, params);
    return { rows, affected };
  }

  /**
   * `dataSource.query` is typed `any`. Routed through `unknown` so the cast is
   * a real narrowing the linter keeps, rather than one `--fix` strips as
   * redundant on `any`.
   */
  async function rawQuery<T>(sql: string, params: unknown[]): Promise<T> {
    const result: unknown = await dataSource.query(sql, params);
    return result as T;
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
    auditRepo = moduleFixture.get(getRepositoryToken(AdminAction));
    tokenService = moduleFixture.get(UserTokenService);
    disputesService = moduleFixture.get(DisputesService);

    service = await serviceRepo.save(
      serviceRepo.create({
        name: `QA B6 Service ${uniq}`,
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
    ({ user: adminA, token: adminAToken } = await makeUser(
      'AdminA',
      Role.ADMIN,
    ));
    ({ user: adminB, token: adminBToken } = await makeUser(
      'AdminB',
      Role.ADMIN,
    ));

    artisanProfile = await profileRepo.save(
      profileRepo.create({
        user: artisanUser,
        currency: 'GHS',
        paystackRecipientCode: `RCP_qa_b6_${uniq}`,
      }),
    );
    createdProfileIds.push(artisanProfile.id);
  });

  afterAll(async () => {
    if (createdDisputeIds.length) {
      await dataSource.query(
        `DELETE FROM admin_actions WHERE target_type = 'DISPUTE' AND target_id = ANY($1)`,
        [createdDisputeIds],
      );
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
        `DELETE FROM admin_actions WHERE actor_id = ANY($1)`,
        [createdUserIds],
      );
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
      .mockResolvedValue({ transfer_code: `TRF_qa_b6_${uniq}` });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // B6-LIVE-1 — the finding itself, two real admin sessions
  // ───────────────────────────────────────────────────────────────────────────

  describe('B6-LIVE-1: admin B closes while admin A’s refund is in flight', () => {
    it("leaves B's close standing, fails A with the provider reason, and logs the abandoned ruling", async () => {
      const { booking, payment } = await makeDisputableChain();
      const disputeId = await raiseDispute(customerToken, booking.id);

      const abandonLog = jest
        .spyOn(disputesService['logger'], 'error')
        .mockImplementation();

      let closeStatus = 0;
      let closeBody: unknown;
      let rowDuringFlight: Dispute | null = null;

      // The gateway call *is* A's provider round-trip. B's real close request
      // goes out from inside it, then the gateway declines.
      paystack.createRefund.mockImplementation(async () => {
        // What A's claim actually committed, observed mid-flight.
        rowDuringFlight = await disputeRepo.findOneByOrFail({ id: disputeId });
        const res = await close(disputeId, { adminNotes: NOTE_B }, adminBToken);
        closeStatus = res.status;
        closeBody = res.body;
        throw new Error(PROVIDER_REASON);
      });

      const aRes = await resolve(
        disputeId,
        {
          outcome: 'REFUND_CLIENT',
          resolution: RESOLUTION_A,
          adminNotes: NOTE_A,
        },
        adminAToken,
      );

      // ── B's close genuinely succeeded, mid-flight.
      expect(closeStatus).toBe(200);
      expect((closeBody as Envelope<unknown>).message).toMatch(/closed/i);
      // A's claim really had committed before B acted (so this is the race,
      // not a pre-claim ordering).
      expect(rowDuringFlight!.status).toBe(DisputeStatus.RESOLVED);
      expect(rowDuringFlight!.resolvedById).toBe(adminA.id);

      // ── A's request fails, as the exception class the admin UI handles.
      expect(aRes.status).toBe(400);
      const aMessage = String(body<unknown>(aRes).message);
      // Names the provider's own reason — never reads as success.
      expect(aMessage).toContain('insufficient settlement balance');
      // No longer claims the dispute is actionable, because it is CLOSED.
      expect(aMessage).not.toMatch(/still actionable/i);
      expect(aMessage).toMatch(
        /another admin resolved or closed this dispute/i,
      );
      /**
       * F2 is asserted in `disputes.service.spec.ts` rather than here: this
       * spec boots the app the Nest testing docs way, without production's
       * global `AllExceptionsFilter`, so the `{ status, message, meta }`
       * envelope that carries `meta.error` does not exist on these responses.
       * The message assertions above are what this spec can see, and they are
       * unchanged by the code.
       */

      // ── The row is exactly what B left.
      const after = await disputeRepo.findOneByOrFail({ id: disputeId });
      expect(after.status).toBe(DisputeStatus.CLOSED);
      expect(after.resolvedById).toBe(adminB.id);
      expect(after.adminNotes).toBe(NOTE_B);
      expect(after.resolvedAt).not.toBeNull();
      // Not reverted to an actionable status, A's note did not displace B's.
      expect(after.status).not.toBe(DisputeStatus.OPEN);
      expect(after.status).not.toBe(DisputeStatus.UNDER_REVIEW);
      expect(after.adminNotes).not.toBe(NOTE_A);
      expect(after.resolvedById).not.toBe(adminA.id);

      // ── No money moved, and nothing moved twice.
      expect(paystack.createRefund).toHaveBeenCalledTimes(1);
      const paymentAfter = await paymentRepo.findOneByOrFail({
        id: payment.id,
      });
      expect(paymentAfter.status).toBe(PaymentStatus.HELD);
      expect(Number(paymentAfter.refundedAmount ?? 0)).toBe(0);

      // ── Open Question 1: the abandoned claim is deliberately left in place.
      expect(after.moneyAction).toBe(DisputeMoneyAction.REFUND);
      expect(after.moneyPaymentId).toBe(payment.id);
      expect(after.moneyAmount ?? null).toBeNull();

      // ── Audit: B's close recorded, A's ruling not.
      const audit = await disputeAudit(disputeId);
      const actions = audit.map((row) => `${row.action}:${row.actorId}`);
      expect(actions).toContain(
        `${AdminActionType.DISPUTE_CLOSE}:${adminB.id}`,
      );
      expect(actions).not.toContain(
        `${AdminActionType.DISPUTE_RESOLVE}:${adminA.id}`,
      );
      expect(
        audit.filter((row) => row.action === AdminActionType.DISPUTE_RESOLVE),
      ).toHaveLength(0);

      // ── Notifications: the parties were told "closed", never "resolved".
      // The outcome notification is fanned out by an event listener, so this
      // polls for both rows rather than asserting on a single read.
      const notes = await partyNotifications(
        NotificationType.DISPUTE_CLOSED,
        2,
      );
      const closedNotes = notes.filter(
        (n) => n.type === String(NotificationType.DISPUTE_CLOSED),
      );
      const resolvedNotes = notes.filter(
        (n) => n.type === String(NotificationType.DISPUTE_RESOLVED),
      );
      // Both parties were told the dispute closed…
      expect(closedNotes.map((n) => n.user_id).sort()).toEqual(
        [customer.id, artisanUser.id].sort(),
      );
      // …and nobody was told it resolved, for a ruling that never took.
      expect(resolvedNotes).toHaveLength(0);

      // ── The abandoned ruling is logged with enough detail to reconcile.
      const lines = abandonLog.mock.calls.map((call) => String(call[0]));
      const abandoned = lines.find((line) => /matched no row/i.test(line));
      expect(abandoned).toBeDefined();
      // Transcribed verbatim into qa-report.md as the evidence for AC5.
      console.log(`[B6-LIVE-1 abandoned-ruling log] ${abandoned}`);
      expect(abandoned).toContain(`Dispute ${disputeId}`);
      expect(abandoned).toContain(`admin ${adminA.id}`);
      expect(abandoned).toContain(DisputeMoneyAction.REFUND);
      expect(abandoned).toContain(`payment ${payment.id}`);
      // Money in the log line is GH₵-formatted, never a bare number.
      expect(abandoned).toContain('GH₵');
      expect(abandoned).toContain('insufficient settlement balance');

      abandonLog.mockRestore();
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // B6-LIVE-2 — the guard is load-bearing (mutation check, in SQL not code)
  // ───────────────────────────────────────────────────────────────────────────

  describe('B6-LIVE-2: the pre-fix UPDATE shape, replayed against a live row', () => {
    it('would have un-closed the dispute, where the shipped predicate affects zero rows', async () => {
      const { booking, payment } = await makeDisputableChain();
      const disputeId = await raiseDispute(customerToken, booking.id);

      // Put the row in the exact post-race state: A claimed it, B then closed
      // it, A's provider call is about to fail.
      await dataSource.query(
        `UPDATE disputes
            SET status = $2, resolved_by_id = $3, resolved_at = now(),
                admin_notes = $4, money_action = $5, money_payment_id = $6,
                money_amount = NULL
          WHERE id = $1`,
        [
          disputeId,
          DisputeStatus.CLOSED,
          adminB.id,
          NOTE_B,
          DisputeMoneyAction.REFUND,
          payment.id,
        ],
      );

      // (a) The shipped predicate: still RESOLVED **and** still A's ruling.
      const shipped = await updateReturning(
        `UPDATE disputes
            SET status = $2, outcome = NULL, resolution = NULL, admin_notes = $3,
                resolved_by_id = NULL, resolved_at = NULL,
                money_action = NULL, money_amount = NULL, money_payment_id = NULL
          WHERE id = $1 AND status = $4 AND resolved_by_id = $5
          RETURNING id`,
        [
          disputeId,
          DisputeStatus.OPEN,
          NOTE_A,
          DisputeStatus.RESOLVED,
          adminA.id,
        ],
      );
      expect(shipped.affected).toBe(0);
      expect(shipped.rows).toHaveLength(0);

      const afterShipped = await disputeRepo.findOneByOrFail({ id: disputeId });
      expect(afterShipped.status).toBe(DisputeStatus.CLOSED);
      expect(afterShipped.resolvedById).toBe(adminB.id);
      expect(afterShipped.adminNotes).toBe(NOTE_B);

      // (b) The pre-fix shape: `WHERE id = :id` alone. This is the finding.
      const preFix = await updateReturning(
        `UPDATE disputes
            SET status = $2, outcome = NULL, resolution = NULL, admin_notes = $3,
                resolved_by_id = NULL, resolved_at = NULL,
                money_action = NULL, money_amount = NULL, money_payment_id = NULL
          WHERE id = $1
          RETURNING id`,
        [disputeId, DisputeStatus.OPEN, NOTE_A],
      );
      expect(preFix.affected).toBe(1);

      const afterPreFix = await disputeRepo.findOneByOrFail({ id: disputeId });
      // Exactly the damage B6 describes, reproduced on a live row.
      expect(afterPreFix.status).toBe(DisputeStatus.OPEN);
      expect(afterPreFix.resolvedById ?? null).toBeNull();
      expect(afterPreFix.adminNotes).toBe(NOTE_A);
      console.log(
        `[B6-LIVE-2] pre-fix shape affected ${preFix.affected} row(s) and left ` +
          `dispute ${disputeId} at status=${afterPreFix.status} ` +
          `resolvedById=${String(afterPreFix.resolvedById)} ` +
          `adminNotes="${String(afterPreFix.adminNotes)}"; ` +
          `shipped predicate affected ${shipped.affected}.`,
      );
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // B6-LIVE-3 — a second *resolve* that wins the row
  // ───────────────────────────────────────────────────────────────────────────

  describe('B6-LIVE-3: the row is still RESOLVED but by a different admin', () => {
    it('is the same logged no-op — A never rolls back B’s ruling', async () => {
      const { booking, payment } = await makeDisputableChain();
      const disputeId = await raiseDispute(customerToken, booking.id);

      const abandonLog = jest
        .spyOn(disputesService['logger'], 'error')
        .mockImplementation();

      const RESOLUTION_B =
        'A second ruling that won the row after A claimed it.';
      // A second resolve cannot be driven through the API here (A's claim
      // already holds the row), so the winning ruling is written directly —
      // the state the service's rollback actually has to cope with.
      paystack.createRefund.mockImplementation(async () => {
        await dataSource.query(
          `UPDATE disputes SET resolved_by_id = $2, resolution = $3, admin_notes = $4
             WHERE id = $1`,
          [disputeId, adminB.id, RESOLUTION_B, NOTE_B],
        );
        throw new Error(PROVIDER_REASON);
      });

      const aRes = await resolve(
        disputeId,
        {
          outcome: 'REFUND_CLIENT',
          resolution: RESOLUTION_A,
          adminNotes: NOTE_A,
        },
        adminAToken,
      );

      expect(aRes.status).toBe(400);
      expect(String(body<unknown>(aRes).message)).toContain(
        'insufficient settlement balance',
      );

      const after = await disputeRepo.findOneByOrFail({ id: disputeId });
      // B's ruling stands, untouched by A's rollback.
      expect(after.status).toBe(DisputeStatus.RESOLVED);
      expect(after.resolvedById).toBe(adminB.id);
      expect(after.resolution).toBe(RESOLUTION_B);
      expect(after.adminNotes).toBe(NOTE_B);

      const paymentAfter = await paymentRepo.findOneByOrFail({
        id: payment.id,
      });
      expect(paymentAfter.status).toBe(PaymentStatus.HELD);
      expect(Number(paymentAfter.refundedAmount ?? 0)).toBe(0);

      expect(
        abandonLog.mock.calls.map((call) => String(call[0])).join('\n'),
      ).toMatch(/matched no row/i);
      abandonLog.mockRestore();
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // B6-LIVE-4 — the uncontested case is unregressed
  // ───────────────────────────────────────────────────────────────────────────

  describe('B6-LIVE-4: nobody else touches the dispute', () => {
    it('still restores all nine columns and still names the provider reason', async () => {
      const { booking, payment } = await makeDisputableChain();
      const disputeId = await raiseDispute(customerToken, booking.id);

      const abandonLog = jest
        .spyOn(disputesService['logger'], 'error')
        .mockImplementation();

      paystack.createRefund.mockRejectedValueOnce(new Error(PROVIDER_REASON));

      const aRes = await resolve(
        disputeId,
        {
          outcome: 'REFUND_CLIENT',
          resolution: RESOLUTION_A,
          adminNotes: NOTE_A,
        },
        adminAToken,
      );

      expect(aRes.status).toBe(400);
      const aMessage = String(body<unknown>(aRes).message);
      // Wording for the uncontested path is unchanged.
      expect(aMessage).toMatch(
        /has NOT been resolved and is still actionable/i,
      );
      expect(aMessage).toContain('insufficient settlement balance');
      expect(aMessage).not.toMatch(/another admin/i);

      // All nine columns back to their pre-ruling values / explicit nulls.
      const after = await disputeRepo.findOneByOrFail({ id: disputeId });
      expect(after.status).toBe(DisputeStatus.OPEN);
      expect(after.outcome ?? null).toBeNull();
      expect(after.resolution ?? null).toBeNull();
      expect(after.adminNotes ?? null).toBeNull();
      expect(after.resolvedById ?? null).toBeNull();
      expect(after.resolvedAt ?? null).toBeNull();
      expect(after.moneyAction ?? null).toBeNull();
      expect(after.moneyAmount ?? null).toBeNull();
      expect(after.moneyPaymentId ?? null).toBeNull();

      const paymentAfter = await paymentRepo.findOneByOrFail({
        id: payment.id,
      });
      expect(paymentAfter.status).toBe(PaymentStatus.HELD);
      expect(Number(paymentAfter.refundedAmount ?? 0)).toBe(0);

      // No resolve audit row, and the abandoned-ruling line must NOT fire on
      // an ordinary failed money action (log-noise criterion).
      const audit = await disputeAudit(disputeId);
      expect(
        audit.filter((row) => row.action === AdminActionType.DISPUTE_RESOLVE),
      ).toHaveLength(0);
      expect(
        abandonLog.mock.calls.map((call) => String(call[0])).join('\n'),
      ).not.toMatch(/matched no row/i);

      // The dispute is genuinely still actionable: A can rule again and win.
      const retry = await resolve(
        disputeId,
        { outcome: 'MUTUAL', resolution: RESOLUTION_A },
        adminAToken,
      );
      expect(retry.status).toBe(200);

      abandonLog.mockRestore();
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // B6-LIVE-5 — Open Question 1: the abandoned claim must not let money move
  // ───────────────────────────────────────────────────────────────────────────

  describe('B6-LIVE-5: the abandoned payment claim left on a closed dispute', () => {
    it('keeps the payment unmovable by a later ruling on a sibling dispute', async () => {
      const { booking, payment } = await makeDisputableChain();
      // The client's dispute: A rules on it, B closes it mid-flight, so the
      // claim on the payment is abandoned on a CLOSED row.
      const abandonedId = await raiseDispute(customerToken, booking.id);

      const abandonLog = jest
        .spyOn(disputesService['logger'], 'error')
        .mockImplementation();

      paystack.createRefund.mockImplementation(async () => {
        await close(abandonedId, { adminNotes: NOTE_B }, adminBToken);
        throw new Error(PROVIDER_REASON);
      });

      const aRes = await resolve(
        abandonedId,
        { outcome: 'REFUND_CLIENT', resolution: RESOLUTION_A },
        adminAToken,
      );
      expect(aRes.status).toBe(400);

      const abandoned = await disputeRepo.findOneByOrFail({ id: abandonedId });
      expect(abandoned.status).toBe(DisputeStatus.CLOSED);
      expect(abandoned.moneyPaymentId).toBe(payment.id);
      expect(abandoned.moneyAction).toBe(DisputeMoneyAction.REFUND);

      // A sibling dispute on the same booking, raised by the other party.
      const siblingId = await raiseDispute(
        artisanToken,
        booking.id,
        DisputeCategory.PAYMENT_AMOUNT,
      );

      paystack.createRefund.mockReset().mockResolvedValue({ status: true });
      paystack.initiateTransfer
        .mockReset()
        .mockResolvedValue({ transfer_code: `TRF_qa_b6_${uniq}` });

      // A release verdict on the sibling would move the very payment the
      // abandoned claim still holds.
      const siblingRes = await resolve(
        siblingId,
        { outcome: 'RELEASE_ARTISAN', resolution: RESOLUTION_A },
        adminAToken,
      );

      expect(siblingRes.status).toBe(200);
      const siblingData = body<{
        moneyAction: string | null;
        moneyAmount: number | null;
        moneySkippedReason: string | null;
      }>(siblingRes).data;
      // The verdict is recorded, but no money action is taken, and the reason
      // names the dispute holding the claim.
      expect(siblingData.moneyAction ?? 'NONE').toBe('NONE');
      expect(siblingData.moneyAmount ?? null).toBeNull();
      expect(String(siblingData.moneySkippedReason)).toContain(
        `#${abandonedId}`,
      );
      console.log(
        `[B6-LIVE-5] sibling ruling skipped the money action: ` +
          `"${String(siblingData.moneySkippedReason)}"`,
      );

      // Nothing moved on the payment, in either direction.
      expect(paystack.createRefund).not.toHaveBeenCalled();
      expect(paystack.initiateTransfer).not.toHaveBeenCalled();
      const paymentAfter = await paymentRepo.findOneByOrFail({
        id: payment.id,
      });
      expect(paymentAfter.status).toBe(PaymentStatus.HELD);
      expect(Number(paymentAfter.refundedAmount ?? 0)).toBe(0);
      expect(paymentAfter.transferCode ?? null).toBeNull();

      // And a further ruling on the abandoned dispute itself is refused
      // outright, because it is settled.
      const reRule = await resolve(
        abandonedId,
        { outcome: 'MUTUAL', resolution: RESOLUTION_A },
        adminAToken,
      );
      expect(reRule.status).toBe(400);
      expect(String(body<unknown>(reRule).message)).toMatch(/already CLOSED/i);

      // The admin surface for the sibling permanently disables both money
      // verdicts. The disabling is correct and unchanged (safe direction); the
      // wording used to state the reason as money having *moved*, which was
      // false — QA-B6-01 / security-report B7. It now describes the claim as
      // abandoned and awaiting reconciliation instead.
      const siblingRead = await request(server())
        .get(`/api/v1/admin/disputes/${siblingId}`)
        .set('Authorization', `Bearer ${adminAToken}`);
      expect(siblingRead.status).toBe(200);
      const options = body<{
        moneyOptions: {
          canRefund: boolean;
          canRelease: boolean;
          reason?: string | null;
        };
      }>(siblingRead).data.moneyOptions;
      expect(options.canRefund).toBe(false);
      expect(options.canRelease).toBe(false);
      console.log(
        `[QA-B6-01] admin read of sibling dispute ${siblingId} reports ` +
          `canRefund=${options.canRefund} canRelease=${options.canRelease} ` +
          `reason="${String(options.reason)}"`,
      );
      // B7: the block stands, the false statement does not.
      expect(String(options.reason)).not.toContain('already moved money');
      expect(String(options.reason)).toContain(`#${abandonedId}`);
      expect(String(options.reason)).toMatch(/abandoned mid-flight/i);
      expect(String(options.reason)).toMatch(/needs reconciliation/i);

      abandonLog.mockRestore();
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // B6-LIVE-6 — adjacent races unchanged
  // ───────────────────────────────────────────────────────────────────────────

  describe('B6-LIVE-6: the adjacent races still answer as they did', () => {
    it('close-then-close and resolve-after-close keep their existing messages', async () => {
      const { booking } = await makeDisputableChain();
      const disputeId = await raiseDispute(customerToken, booking.id);

      const first = await close(disputeId, { adminNotes: NOTE_B }, adminBToken);
      expect(first.status).toBe(200);

      const second = await close(
        disputeId,
        { adminNotes: NOTE_A },
        adminAToken,
      );
      expect(second.status).toBe(400);
      expect(String(body<unknown>(second).message)).toMatch(
        /Dispute is already closed\./i,
      );

      const afterClose = await resolve(
        disputeId,
        { outcome: 'MUTUAL', resolution: RESOLUTION_A },
        adminAToken,
      );
      expect(afterClose.status).toBe(400);
      expect(String(body<unknown>(afterClose).message)).toMatch(
        /already CLOSED/i,
      );

      // B's close is intact after both refusals.
      const after = await disputeRepo.findOneByOrFail({ id: disputeId });
      expect(after.status).toBe(DisputeStatus.CLOSED);
      expect(after.resolvedById).toBe(adminB.id);
      expect(after.adminNotes).toBe(NOTE_B);
    });

    it('403s a customer and an artisan on both admin routes', async () => {
      const { booking } = await makeDisputableChain();
      const disputeId = await raiseDispute(customerToken, booking.id);

      for (const token of [customerToken, artisanToken]) {
        const r = await resolve(
          disputeId,
          { outcome: 'MUTUAL', resolution: RESOLUTION_A },
          token,
        );
        expect(r.status).toBe(403);
        const c = await close(disputeId, { adminNotes: NOTE_A }, token);
        expect(c.status).toBe(403);
      }

      const after = await disputeRepo.findOneByOrFail({ id: disputeId });
      expect(after.status).toBe(DisputeStatus.OPEN);
      expect(after.resolvedById ?? null).toBeNull();
    });
  });
});

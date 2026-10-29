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
import { UserTokenService } from '@users/token.service';
import { PaystackService } from '../src/payments/paystack.service';
import {
  BookingStatus,
  DisputeCategory,
  DisputeStatus,
  PaymentStatus,
  Role,
  Status,
} from '@common/types/enums';

/**
 * QA verification for the `admin-disputes-closeout` round (DC1-DC3).
 *
 * Written by QA, not by the build engineers, to close the two evidence gaps the
 * round handed over with:
 *
 *  1. **The refund verdict's actual money movement had never been verified.**
 *     The existing e2e spec rules `MUTUAL` on every dispute on purpose, because
 *     `REFUND_CLIENT` and `RELEASE_ARTISAN` reach `PaystackService` and a test
 *     must never call a live payment gateway. That left the whole DC1 money
 *     path — the arithmetic, the status transitions, the over-balance guard,
 *     the double-move guard, the rollback and the concurrency mutex —
 *     unexercised against a database.
 *
 *     This spec stubs **only** the `PaystackService` boundary (the one thing
 *     that is genuinely external and must not be called) and asserts the real
 *     committed rows for everything on our side of it. What it therefore
 *     proves: the amounts, the `payments` row transitions, the `disputes`
 *     money columns, the guards and the rollback. What it explicitly does
 *     **not** prove: that Paystack itself accepts the refund. See
 *     `qa-report.md` DC1-EVIDENCE for why that leg is not verifiable here.
 *
 *  2. **DC2.1 requires the pre-fix failure to be reproduced and its actual
 *     Postgres error text recorded.** The fix landed before any QA pass, so the
 *     reproduction is done here by executing the historical SQL shape directly
 *     against the live database, rather than by reverting production code.
 *
 * Every row this spec creates is removed in `afterAll`.
 *
 * Run: npm run test:e2e -- dc-closeout
 */
jest.setTimeout(180000);

interface Envelope<T> {
  data: T;
  message?: string;
}
function body<T>(res: request.Response): Envelope<T> {
  return res.body as Envelope<T>;
}

describe('admin-disputes-closeout — QA verification (e2e)', () => {
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
  let adminUser: User;
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
  const NOTE = 'QA closeout verification of the dispute money path end to end.';

  async function makeUser(
    label: string,
    role: Role,
  ): Promise<{ user: User; token: string }> {
    const user = await userRepo.save(
      userRepo.create({
        email: `qa-dc-${label}-${uniq}@test.jinva.local`,
        password: null,
        firstname: 'QaDc',
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

  /**
   * The exact fixture shape the round could not test against: a COMPLETED
   * booking, a booking-derived job, and a payment actually sitting at `HELD` on
   * it. Booking-derived jobs never get a payment hold in production (a known,
   * separately-tracked gap), which is why this has to be built explicitly.
   */
  async function makeDisputableChain(opts: { withPayment: boolean }): Promise<{
    booking: Booking;
    job: Job;
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
        title: `QA DC chain ${uniq}-${booking.id}`,
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
          reference: `qa-dc-${uniq}-${job.id}`,
          channel: 'mobile_money',
          paidAt: new Date('2026-08-02T10:00:00Z'),
        }),
      );
      createdPaymentIds.push(payment.id);
    }

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
        reason: `QA closeout dispute ${uniq} filed to verify the money path end to end.`,
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
        name: `QA DC Service ${uniq}`,
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
    ({ user: adminUser, token: adminToken } = await makeUser(
      'Admin',
      Role.ADMIN,
    ));
    void adminUser;

    artisanProfile = await profileRepo.save(
      profileRepo.create({
        user: artisanUser,
        currency: 'GHS',
        // Present so a RELEASE verdict reaches the transfer call rather than
        // short-circuiting to PENDING_TRANSFER for a missing payout method.
        paystackRecipientCode: `RCP_qa_dc_${uniq}`,
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
      .mockResolvedValue({ transfer_code: `TRF_qa_${uniq}` });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // DC2.1 — reproduce the pre-fix failure and capture the real error text
  // ───────────────────────────────────────────────────────────────────────────

  describe('DC2.1: the pre-fix analytics failure, reproduced against Postgres', () => {
    it('records the actual Postgres error the unquoted reserved-word alias produced', async () => {
      // The historical shape of topArtisans()' correlated subquery: the join
      // alias was `user` (a reserved word) and the subquery referenced
      // `user.id` unquoted, because TypeORM's rewriter swallowed the trailing
      // newline and never quoted it. Reproduced as raw SQL so no production
      // code has to be reverted to observe it.
      const preFixSql = `
        SELECT ap.id AS "artisanProfileId",
               (SELECT COUNT(*) FROM jobs j
                    WHERE j.accepted_artisan_id = user.id
                      AND j.status = 'COMPLETED'
                      AND j.deleted_at IS NULL)
               AS "completedJobs"
        FROM artisan_profiles ap
        INNER JOIN users "user" ON "user".id = ap.user_id
        LIMIT 1
      `;

      let code: string | undefined;
      let message = '';
      try {
        await dataSource.query(preFixSql);
        throw new Error('Expected the pre-fix SQL to fail, but it succeeded.');
      } catch (e) {
        const err = e as { code?: string; message: string };
        code = err.code;
        message = err.message;
      }

      // Transcribed into qa-report.md per DC2.1.
      console.log(
        `[DC2.1 pre-fix reproduction] SQLSTATE=${code ?? '(none)'} message="${message}"`,
      );

      expect(code).toBe('42601');
      expect(message).toMatch(/syntax error at or near/i);

      // And the shipped query, on the same database, does not fail.
      const fixedSql = `
        SELECT ap.id AS "artisanProfileId",
               (SELECT COUNT(*) FROM jobs j
                    WHERE j.accepted_artisan_id = "au"."id"
                      AND j.status = $1
                      AND j.deleted_at IS NULL)
               AS "completedJobs"
        FROM artisan_profiles ap
        INNER JOIN users "au" ON "au".id = ap.user_id
        LIMIT 1
      `;
      await expect(
        dataSource.query(fixedSql, [Status.COMPLETED]),
      ).resolves.toBeDefined();
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // DC1 — the money movement behind each verdict, on real rows
  // ───────────────────────────────────────────────────────────────────────────

  describe('DC1: a REFUND_CLIENT verdict on a HELD payment', () => {
    it('refunds the full remaining balance and records exactly what moved', async () => {
      const { booking, payment } = await makeDisputableChain({
        withPayment: true,
      });
      const disputeId = await raiseDispute(customerToken, booking.id);

      const res = await resolve(disputeId, {
        outcome: 'REFUND_CLIENT',
        resolution: NOTE,
      });

      expect(res.status).toBe(200);
      const { data, message } = body<{
        outcome: string;
        moneyAction: string;
        moneyAmount: number | null;
        moneyPaymentId: number | null;
        moneySkippedReason: string | null;
      }>(res);

      expect(data.outcome).toBe('REFUND_CLIENT');
      expect(data.moneyAction).toBe('REFUND');
      expect(Number(data.moneyAmount)).toBe(200);
      expect(data.moneyPaymentId).toBe(payment!.id);
      expect(data.moneySkippedReason).toBeNull();
      // The server's own sentence already carries a formatted GH₵ amount, which
      // is what the dialog displays verbatim (DC1.5).
      expect(message).toContain('GH₵');

      // The gateway was asked for exactly the right amount, exactly once.
      expect(paystack.createRefund).toHaveBeenCalledTimes(1);
      expect(paystack.createRefund).toHaveBeenCalledWith(
        payment!.reference,
        200,
      );

      // The committed payment row.
      const after = await paymentRepo.findOneByOrFail({ id: payment!.id });
      expect(Number(after.refundedAmount)).toBe(200);
      expect(after.status).toBe(PaymentStatus.REFUNDED);

      // The committed dispute row.
      const dispute = await disputeRepo.findOneByOrFail({ id: disputeId });
      expect(dispute.status).toBe(DisputeStatus.RESOLVED);
      expect(dispute.outcome).toBe('REFUND_CLIENT');
      expect(Number(dispute.moneyAmount)).toBe(200);
      expect(dispute.moneyPaymentId).toBe(payment!.id);
    });

    it('refunds exactly the partial amount entered and leaves the rest withheld', async () => {
      const { booking, payment } = await makeDisputableChain({
        withPayment: true,
      });
      const disputeId = await raiseDispute(customerToken, booking.id);

      const res = await resolve(disputeId, {
        outcome: 'REFUND_CLIENT',
        resolution: NOTE,
        refundAmountGhs: 75.5,
      });

      expect(res.status).toBe(200);
      expect(Number(body<{ moneyAmount: number }>(res).data.moneyAmount)).toBe(
        75.5,
      );
      expect(paystack.createRefund).toHaveBeenCalledWith(
        payment!.reference,
        75.5,
      );

      const after = await paymentRepo.findOneByOrFail({ id: payment!.id });
      expect(Number(after.refundedAmount)).toBe(75.5);
      // Not fully refunded, so it stays HELD rather than flipping to REFUNDED.
      expect(after.status).toBe(PaymentStatus.HELD);
    });

    it('refuses an amount above the remaining balance before writing anything', async () => {
      const { booking, payment } = await makeDisputableChain({
        withPayment: true,
      });
      const disputeId = await raiseDispute(customerToken, booking.id);

      const res = await resolve(disputeId, {
        outcome: 'REFUND_CLIENT',
        resolution: NOTE,
        refundAmountGhs: 250,
      });

      expect(res.status).toBe(400);
      expect(body<unknown>(res).message).toMatch(/refundable balance/i);

      // Nothing was attempted and nothing was written — the dispute is still
      // actionable and the payment is untouched.
      expect(paystack.createRefund).not.toHaveBeenCalled();
      const after = await paymentRepo.findOneByOrFail({ id: payment!.id });
      expect(Number(after.refundedAmount ?? 0)).toBe(0);
      expect(after.status).toBe(PaymentStatus.HELD);

      const dispute = await disputeRepo.findOneByOrFail({ id: disputeId });
      expect(dispute.status).toBe(DisputeStatus.OPEN);
      expect(dispute.outcome ?? null).toBeNull();
      expect(dispute.resolvedAt ?? null).toBeNull();
    });

    it('leaves the dispute unresolved and still actionable when the money action fails', async () => {
      const { booking, payment } = await makeDisputableChain({
        withPayment: true,
      });
      const disputeId = await raiseDispute(customerToken, booking.id);

      paystack.createRefund.mockRejectedValueOnce(
        new Error('Paystack declined the refund (QA forced failure)'),
      );

      const res = await resolve(disputeId, {
        outcome: 'REFUND_CLIENT',
        resolution: NOTE,
      });

      expect(res.status).toBe(400);
      expect(body<unknown>(res).message).toMatch(/has NOT been resolved/i);

      // The ruling was claimed, then rolled back: the dispute must read as
      // actionable, with no verdict and no resolver recorded.
      const dispute = await disputeRepo.findOneByOrFail({ id: disputeId });

      // Reported as QA-DC1-01. `status` *is* restored, but the rollback's
      // other five columns are assigned `undefined`, and TypeORM's
      // UpdateQueryBuilder omits an `undefined` value from the UPDATE
      // entirely — the identical failure mode commit 1d5ce20 fixed in
      // AdminService for the suspension columns. So a rolled-back dispute
      // keeps the verdict, the note, the resolver and the resolved
      // timestamp of a ruling that never happened.
      console.log(
        `[QA-DC1-01] after a failed money action, dispute ${disputeId} reads: ` +
          `status=${dispute.status} outcome=${String(dispute.outcome)} ` +
          `resolution=${dispute.resolution ? 'SET' : 'null'} ` +
          `resolvedById=${String(dispute.resolvedById)} ` +
          `resolvedAt=${dispute.resolvedAt ? 'SET' : 'null'} ` +
          `moneyAction=${String(dispute.moneyAction)}`,
      );

      expect(dispute.status).toBe(DisputeStatus.OPEN);
      expect(dispute.outcome ?? null).toBeNull();
      expect(dispute.resolution ?? null).toBeNull();
      expect(dispute.resolvedById ?? null).toBeNull();
      expect(dispute.resolvedAt ?? null).toBeNull();
      expect(dispute.moneyAction ?? null).toBeNull();

      const after = await paymentRepo.findOneByOrFail({ id: payment!.id });
      expect(Number(after.refundedAmount ?? 0)).toBe(0);
      expect(after.status).toBe(PaymentStatus.HELD);
    });
  });

  describe('DC1: a RELEASE_ARTISAN verdict on a HELD payment', () => {
    it('initiates the payout for the artisan amount and records the release', async () => {
      const { booking, payment } = await makeDisputableChain({
        withPayment: true,
      });
      const disputeId = await raiseDispute(customerToken, booking.id);

      const res = await resolve(disputeId, {
        outcome: 'RELEASE_ARTISAN',
        resolution: NOTE,
      });

      expect(res.status).toBe(200);
      const { data } = body<{ moneyAction: string; moneyAmount: number }>(res);
      expect(data.moneyAction).toBe('RELEASE');
      // The artisan's net share, not the gross the client paid.
      expect(Number(data.moneyAmount)).toBe(190);

      expect(paystack.initiateTransfer).toHaveBeenCalledTimes(1);
      // `capturePayment` forwards the raw entity value, which Postgres returns
      // as the string "190.00" for a decimal column. Harmless — the gateway
      // wrapper does `Math.round(amountGhs * 100)` and JS coerces — but it is
      // why this asserts the numeric value rather than strict equality. This
      // is pre-existing payments code, untouched by this round.
      const transferCalls = paystack.initiateTransfer.mock.calls as [
        { amountGhs: number | string },
      ][];
      const transferArg = transferCalls[0][0];
      expect(Number(transferArg.amountGhs)).toBe(190);

      const after = await paymentRepo.findOneByOrFail({ id: payment!.id });
      expect(after.transferCode).toBe(`TRF_qa_${uniq}`);
      // Documented asynchrony: RELEASED lands on the transfer.success webhook,
      // so immediately after the ruling the row is still HELD with a transfer
      // in flight. Recorded in qa-report.md so it is not mistaken for a bug.
      expect(after.status).toBe(PaymentStatus.HELD);
      expect(Number(after.refundedAmount ?? 0)).toBe(0);
    });
  });

  describe('DC1: a MUTUAL verdict', () => {
    it('records the verdict and moves nothing, on a payment that could have moved', async () => {
      const { booking, payment } = await makeDisputableChain({
        withPayment: true,
      });
      const disputeId = await raiseDispute(customerToken, booking.id);

      const res = await resolve(disputeId, {
        outcome: 'MUTUAL',
        resolution: NOTE,
      });

      expect(res.status).toBe(200);
      const { data } = body<{
        moneyAction: string;
        moneyAmount: number | null;
        moneySkippedReason: string | null;
      }>(res);
      expect(data.moneyAction).toBe('NONE');
      expect(data.moneyAmount).toBeNull();
      expect(data.moneySkippedReason).toMatch(/no money moves by design/i);

      expect(paystack.createRefund).not.toHaveBeenCalled();
      expect(paystack.initiateTransfer).not.toHaveBeenCalled();

      const after = await paymentRepo.findOneByOrFail({ id: payment!.id });
      expect(after.status).toBe(PaymentStatus.HELD);
      expect(Number(after.refundedAmount ?? 0)).toBe(0);
      expect(after.transferCode ?? null).toBeNull();
    });

    it('rejects a refund amount supplied with a verdict that moves no money', async () => {
      const { booking } = await makeDisputableChain({ withPayment: true });
      const disputeId = await raiseDispute(customerToken, booking.id);

      const res = await resolve(disputeId, {
        outcome: 'MUTUAL',
        resolution: NOTE,
        refundAmountGhs: 10,
      });

      expect(res.status).toBe(400);
      const dispute = await disputeRepo.findOneByOrFail({ id: disputeId });
      expect(dispute.status).toBe(DisputeStatus.OPEN);
    });
  });

  describe('DC1: a money verdict on a dispute with no linked payment', () => {
    it('records the verdict and states why no money moved', async () => {
      const { booking } = await makeDisputableChain({ withPayment: false });
      const disputeId = await raiseDispute(customerToken, booking.id);

      const res = await resolve(disputeId, {
        outcome: 'REFUND_CLIENT',
        resolution: NOTE,
      });

      expect(res.status).toBe(200);
      const { data } = body<{
        outcome: string;
        moneyAction: string;
        moneySkippedReason: string | null;
      }>(res);
      expect(data.outcome).toBe('REFUND_CLIENT');
      expect(data.moneyAction).toBe('NONE');
      expect(data.moneySkippedReason).toMatch(/no payment is linked/i);
      expect(paystack.createRefund).not.toHaveBeenCalled();

      const dispute = await disputeRepo.findOneByOrFail({ id: disputeId });
      expect(dispute.status).toBe(DisputeStatus.RESOLVED);
      expect(dispute.outcome).toBe('REFUND_CLIENT');

      // GAP 2, as handed over: `moneySkippedReason` is computed per request and
      // is not a column, so it cannot be read back afterwards. Pinned here so
      // the limitation is a known, asserted fact rather than a surprise.
      const adminRead = await request(server())
        .get(`/api/v1/admin/disputes/${disputeId}`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(adminRead.status).toBe(200);
      expect(
        (adminRead.body as { data: Record<string, unknown> }).data
          .moneySkippedReason,
      ).toBeUndefined();

      const partyRead = await request(server())
        .get(`/api/v1/disputes/my/${disputeId}`)
        .set('Authorization', `Bearer ${customerToken}`);
      expect(partyRead.status).toBe(200);
      expect(
        (partyRead.body as { data: Record<string, unknown> }).data
          .moneySkippedReason,
      ).toBeUndefined();
      // The verdict itself does survive, which is what DC1.8/DC3.5 render.
      expect(
        (partyRead.body as { data: Record<string, unknown> }).data.moneyAction,
      ).toBe('NONE');
    });
  });

  describe('DC1: two disputes on one booking cannot both move the money', () => {
    it('refuses a second money action and names the sibling that already moved it', async () => {
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

      const first = await resolve(clientDispute, {
        outcome: 'REFUND_CLIENT',
        resolution: NOTE,
      });
      expect(first.status).toBe(200);
      expect(body<{ moneyAction: string }>(first).data.moneyAction).toBe(
        'REFUND',
      );

      // The artisan's dispute on the same booking now rules for the artisan —
      // the money is already gone and must not move twice.
      const second = await resolve(artisanDispute, {
        outcome: 'RELEASE_ARTISAN',
        resolution: NOTE,
      });
      expect(second.status).toBe(200);
      const { data } = body<{
        moneyAction: string;
        moneySkippedReason: string | null;
      }>(second);
      expect(data.moneyAction).toBe('NONE');
      expect(data.moneySkippedReason).toContain(
        `Dispute #${clientDispute} already moved money on this payment`,
      );

      // Exactly one gateway call across both rulings.
      expect(paystack.createRefund).toHaveBeenCalledTimes(1);
      expect(paystack.initiateTransfer).not.toHaveBeenCalled();

      const after = await paymentRepo.findOneByOrFail({ id: payment!.id });
      expect(Number(after.refundedAmount)).toBe(200);
      expect(after.transferCode ?? null).toBeNull();

      // Both verdicts are still recorded — the second is a real ruling that
      // simply moved nothing.
      const second_ = await disputeRepo.findOneByOrFail({ id: artisanDispute });
      expect(second_.status).toBe(DisputeStatus.RESOLVED);
      expect(second_.outcome).toBe('RELEASE_ARTISAN');
    });
  });

  describe('DC1.6: two admins ruling at once', () => {
    it('lets exactly one win, tells the loser, and moves the money once', async () => {
      const { booking, payment } = await makeDisputableChain({
        withPayment: true,
      });
      const disputeId = await raiseDispute(customerToken, booking.id);

      const [a, b] = await Promise.all([
        resolve(disputeId, { outcome: 'REFUND_CLIENT', resolution: NOTE }),
        resolve(disputeId, { outcome: 'REFUND_CLIENT', resolution: NOTE }),
      ]);

      const statuses = [a.status, b.status].sort((x, y) => x - y);
      expect(statuses).toEqual([200, 400]);

      const loser = a.status === 400 ? a : b;
      expect(body<unknown>(loser).message).toMatch(
        /already\s+(RESOLVED|CLOSED)/i,
      );

      // The whole point: one money movement, not two.
      expect(paystack.createRefund).toHaveBeenCalledTimes(1);
      const after = await paymentRepo.findOneByOrFail({ id: payment!.id });
      expect(Number(after.refundedAmount)).toBe(200);
      expect(after.status).toBe(PaymentStatus.REFUNDED);
    });
  });

  describe('DC1.9 / DC3.2: role and access boundaries', () => {
    it('403s a customer and an artisan on the admin resolve endpoint', async () => {
      const { booking } = await makeDisputableChain({ withPayment: false });
      const disputeId = await raiseDispute(customerToken, booking.id);

      for (const token of [customerToken, artisanToken]) {
        const res = await resolve(
          disputeId,
          { outcome: 'MUTUAL', resolution: NOTE },
          token,
        );
        expect(res.status).toBe(403);
      }

      const dispute = await disputeRepo.findOneByOrFail({ id: disputeId });
      expect(dispute.status).toBe(DisputeStatus.OPEN);
    });

    it('404s a non-participant and a nonexistent id identically, leaking nothing', async () => {
      const { booking } = await makeDisputableChain({ withPayment: false });
      const realDisputeId = await raiseDispute(customerToken, booking.id);
      const { token: strangerToken } = await makeUser(
        `Stranger${uniq}`,
        Role.CUSTOMER,
      );

      const notMine = await request(server())
        .get(`/api/v1/disputes/my/${realDisputeId}`)
        .set('Authorization', `Bearer ${strangerToken}`);
      const notReal = await request(server())
        .get('/api/v1/disputes/my/99999999')
        .set('Authorization', `Bearer ${strangerToken}`);

      expect(notMine.status).toBe(404);
      expect(notReal.status).toBe(404);
      // Indistinguishable: an id is never confirmed to a stranger.
      expect(body<unknown>(notMine).message).toBe(
        body<unknown>(notReal).message,
      );
      expect(JSON.stringify(notMine.body)).not.toContain(String(booking.id));
    });

    it('never exposes adminNotes or the resolving admin on a party read', async () => {
      const { booking } = await makeDisputableChain({ withPayment: false });
      const disputeId = await raiseDispute(customerToken, booking.id);

      const res = await resolve(disputeId, {
        outcome: 'MUTUAL',
        resolution: NOTE,
        adminNotes: 'Internal only — QA probe, must never reach a party.',
      });
      expect(res.status).toBe(200);

      const partyRead = await request(server())
        .get(`/api/v1/disputes/my/${disputeId}`)
        .set('Authorization', `Bearer ${customerToken}`);
      expect(partyRead.status).toBe(200);

      const raw = JSON.stringify(partyRead.body);
      expect(raw).not.toContain('QA probe');
      expect(raw).not.toContain('adminNotes');
      expect(raw).not.toContain('resolvedBy');
      expect(raw).not.toContain('qa-dc-Admin');
    });
  });
});

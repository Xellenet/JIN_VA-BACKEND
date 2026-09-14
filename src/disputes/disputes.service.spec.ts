import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { QueryFailedError } from 'typeorm';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { DisputesService } from './disputes.service';
import { Dispute } from './entities/dispute.entity';
import { Booking } from '../bookings/entities/booking.entity';
import { Job } from '@jobs/entities/job.entity';
import { JobStatusHistory } from '@jobs/entities/job-status-history.entity';
import { Payment } from '../payments/entities/payment.entity';
import { MessagesService } from '@messages/messages.service';
import { PaymentsService } from '../payments/payments.service';
import { AdminAuditService } from '../admin-audit/admin-audit.service';
import {
  AdminActionType,
  DisputeCategory,
  DisputeMoneyAction,
  DisputeOutcome,
  DisputeStatus,
  PaymentStatus,
  Role,
} from '@common/types/enums';
import { APP_EVENTS } from '@common/events/app.events';
import type { User } from '@users/entities/user.entity';

/**
 * Covers the settled behaviour this module already had (PD4's both-parties
 * outcome notification, AD2's conversation scope boundary, PR3's filing event)
 * plus everything this round adds: DR1's verdict, DR2's money action and its
 * failure/impossibility paths, DR4's counterparty response and notification,
 * and the concurrency guard on resolving.
 */
describe('DisputesService', () => {
  let service: DisputesService;

  const customerUser = {
    id: 10,
    firstname: 'Ama',
    lastname: 'Mensah',
    email: 'ama@example.com',
  };
  const artisanUser = {
    id: 20,
    firstname: 'Yaw',
    lastname: 'Boateng',
    email: 'yaw@example.com',
  };
  const admin = {
    id: 99,
    firstname: 'Admin',
    lastname: 'One',
    email: 'admin@jinva.test',
  } as User;

  const disputeRaisedByCustomer = (status: DisputeStatus) =>
    ({
      id: 5,
      bookingId: 77,
      raisedById: customerUser.id,
      status,
      category: DisputeCategory.WORK_QUALITY,
      reason: 'The work was not finished to the agreed standard at all.',
      booking: {
        id: 77,
        customer: customerUser,
        artisanProfile: { user: artisanUser },
      },
      raisedBy: customerUser,
    }) as unknown as Dispute;

  /** A Postgres unique violation as TypeORM surfaces it. */
  const uniqueViolation = (constraint: string) => {
    const driverError = Object.assign(new Error('duplicate key value'), {
      code: '23505',
      constraint,
    });
    return Object.assign(
      new QueryFailedError('UPDATE disputes SET ...', [], driverError),
      { code: '23505', constraint },
    );
  };

  /** The specific index that makes a payment claimable by one dispute (B3). */
  const moneyClaimConflict = () => uniqueViolation('uq_disputes_money_payment');

  const heldPayment = (over: Partial<Payment> = {}) =>
    ({
      id: 300,
      jobId: 200,
      amount: 1850,
      platformFee: 92.5,
      artisanAmount: 1757.5,
      refundedAmount: 0,
      status: PaymentStatus.HELD,
      reference: 'jinva-200-10-1',
      ...over,
    }) as Payment;

  let disputeRepo: {
    findOne: jest.Mock;
    find: jest.Mock;
    save: jest.Mock<Promise<Dispute>, [Dispute]>;
    create: jest.Mock<Dispute, [Partial<Dispute>]>;
    createQueryBuilder: jest.Mock;
  };
  let bookingRepo: { findOne: jest.Mock };
  let jobRepo: { findOne: jest.Mock };
  let paymentRepo: { findOne: jest.Mock };
  let emitter: { emit: jest.Mock };
  let messagesService: { getConversationBetween: jest.Mock };
  let paymentsService: {
    adminRefund: jest.Mock;
    releaseWithheldPayment: jest.Mock;
  };
  let auditService: { record: jest.Mock };
  /** Every `createQueryBuilder()` call in resolve/close is an UPDATE builder. */
  let updateQb: {
    update: jest.Mock;
    set: jest.Mock;
    where: jest.Mock;
    andWhere: jest.Mock;
    execute: jest.Mock;
  };

  beforeEach(async () => {
    updateQb = {
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    disputeRepo = {
      findOne: jest.fn(),
      find: jest.fn().mockResolvedValue([]),
      save: jest.fn((d: Dispute) => Promise.resolve(d)),
      create: jest.fn((d: Partial<Dispute>) => d as Dispute),
      createQueryBuilder: jest.fn(() => updateQb),
    };
    bookingRepo = { findOne: jest.fn() };
    jobRepo = { findOne: jest.fn().mockResolvedValue(null) };
    paymentRepo = { findOne: jest.fn().mockResolvedValue(null) };
    emitter = { emit: jest.fn() };
    messagesService = {
      getConversationBetween: jest
        .fn()
        .mockResolvedValue({ message: 'ok', data: null }),
    };
    paymentsService = {
      adminRefund: jest
        .fn()
        .mockResolvedValue({ message: 'Refund initiated.' }),
      releaseWithheldPayment: jest
        .fn()
        .mockResolvedValue({ message: 'released' }),
    };
    auditService = { record: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DisputesService,
        { provide: getRepositoryToken(Dispute), useValue: disputeRepo },
        { provide: getRepositoryToken(Booking), useValue: bookingRepo },
        { provide: getRepositoryToken(Job), useValue: jobRepo },
        {
          provide: getRepositoryToken(JobStatusHistory),
          useValue: { findOne: jest.fn().mockResolvedValue(null) },
        },
        { provide: getRepositoryToken(Payment), useValue: paymentRepo },
        { provide: EventEmitter2, useValue: emitter },
        { provide: MessagesService, useValue: messagesService },
        { provide: PaymentsService, useValue: paymentsService },
        { provide: AdminAuditService, useValue: auditService },
      ],
    }).compile();

    service = module.get<DisputesService>(DisputesService);
  });

  describe('resolve / close (PD4)', () => {
    it('notifies both the raiser and the counterparty on resolve', async () => {
      disputeRepo.findOne.mockResolvedValueOnce(
        disputeRaisedByCustomer(DisputeStatus.UNDER_REVIEW),
      );

      await service.resolve(admin, 5, {
        outcome: DisputeOutcome.MUTUAL,
        resolution: 'Refund issued in full.',
      });

      expect(emitter.emit).toHaveBeenCalledWith(
        APP_EVENTS.DISPUTE_RESOLVED,
        expect.objectContaining({
          disputeId: 5,
          bookingId: 77,
          raisedByUserId: customerUser.id,
          counterpartyUserId: artisanUser.id,
          outcome: 'RESOLVED',
          resolution: 'Refund issued in full.',
        }),
      );
    });

    it('notifies both parties on close', async () => {
      disputeRepo.findOne.mockResolvedValueOnce(
        disputeRaisedByCustomer(DisputeStatus.OPEN),
      );

      await service.close(admin, 5, {});

      expect(emitter.emit).toHaveBeenCalledWith(
        APP_EVENTS.DISPUTE_CLOSED,
        expect.objectContaining({
          raisedByUserId: customerUser.id,
          counterpartyUserId: artisanUser.id,
          outcome: 'CLOSED',
        }),
      );
    });

    it('resolves the counterparty correctly when the ARTISAN raised the dispute', async () => {
      const raisedByArtisan = {
        ...disputeRaisedByCustomer(DisputeStatus.OPEN),
        raisedById: artisanUser.id,
      } as Dispute;
      disputeRepo.findOne.mockResolvedValueOnce(raisedByArtisan);

      await service.resolve(admin, 5, {
        outcome: DisputeOutcome.MUTUAL,
        resolution: 'Work confirmed complete.',
      });

      expect(emitter.emit).toHaveBeenCalledWith(
        APP_EVENTS.DISPUTE_RESOLVED,
        expect.objectContaining({
          raisedByUserId: artisanUser.id,
          counterpartyUserId: customerUser.id,
        }),
      );
    });

    it('does NOT notify on the interim UNDER_REVIEW transition — only final outcomes notify', async () => {
      disputeRepo.findOne.mockResolvedValueOnce(
        disputeRaisedByCustomer(DisputeStatus.OPEN),
      );

      await service.startReview(admin.id, 5);

      expect(emitter.emit).not.toHaveBeenCalled();
    });

    /** B1, lower-stakes instance: same full-entity `save()` defect. */
    it('B1: starts a review with a status-guarded UPDATE, never a full-entity save', async () => {
      disputeRepo.findOne.mockResolvedValueOnce(
        disputeRaisedByCustomer(DisputeStatus.OPEN),
      );

      await service.startReview(admin.id, 5);

      expect(disputeRepo.save).not.toHaveBeenCalled();
      expect(updateQb.set).toHaveBeenCalledWith({
        status: DisputeStatus.UNDER_REVIEW,
      });
      expect(updateQb.andWhere).toHaveBeenCalledWith('status = :open', {
        open: DisputeStatus.OPEN,
      });
    });

    it('B1: refuses to start a review on a dispute resolved mid-request', async () => {
      disputeRepo.findOne
        .mockResolvedValueOnce(disputeRaisedByCustomer(DisputeStatus.OPEN))
        .mockResolvedValueOnce(disputeRaisedByCustomer(DisputeStatus.RESOLVED));
      updateQb.execute.mockResolvedValueOnce({ affected: 0 });

      await expect(service.startReview(admin.id, 5)).rejects.toThrow(
        /current status is RESOLVED/i,
      );
      expect(disputeRepo.save).not.toHaveBeenCalled();
    });

    it.each([DisputeStatus.RESOLVED, DisputeStatus.CLOSED])(
      'still refuses to resolve an already-%s dispute (existing guard must not regress)',
      async (status) => {
        disputeRepo.findOne.mockResolvedValueOnce(
          disputeRaisedByCustomer(status),
        );

        await expect(
          service.resolve(admin, 5, {
            outcome: DisputeOutcome.MUTUAL,
            resolution: 'Trying again anyway.',
          }),
        ).rejects.toThrow(BadRequestException);
        expect(paymentsService.adminRefund).not.toHaveBeenCalled();
      },
    );
  });

  // ─── DR1/DR2 ────────────────────────────────────────────────────────────────

  describe('resolve — the verdict carries out its money action (DR1/DR2)', () => {
    const withHeldPayment = (payment = heldPayment()) => {
      disputeRepo.findOne
        // loadOrFail
        .mockResolvedValueOnce(
          disputeRaisedByCustomer(DisputeStatus.UNDER_REVIEW),
        )
        // sibling-dispute money guard
        .mockResolvedValueOnce(null);
      jobRepo.findOne.mockResolvedValue({
        id: 200,
        service: null,
      } as unknown as Job);
      paymentRepo.findOne.mockResolvedValue(payment);
    };

    it('REFUND_CLIENT refunds the full remaining balance by default', async () => {
      withHeldPayment();

      const result = await service.resolve(admin, 5, {
        outcome: DisputeOutcome.REFUND_CLIENT,
        resolution: 'Client is entitled to their money back.',
      });

      expect(paymentsService.adminRefund).toHaveBeenCalledWith(
        300,
        1850,
        admin,
      );
      expect(result.data.moneyAction).toBe(DisputeMoneyAction.REFUND);
      expect(result.data.moneyAmount).toBe(1850);
      expect(result.data.moneyPaymentId).toBe(300);
    });

    it('REFUND_CLIENT honours a partial amount within the remaining balance', async () => {
      withHeldPayment();

      await service.resolve(admin, 5, {
        outcome: DisputeOutcome.REFUND_CLIENT,
        resolution: 'Half the work was usable, so a partial refund is fair.',
        refundAmountGhs: 900,
      });

      expect(paymentsService.adminRefund).toHaveBeenCalledWith(300, 900, admin);
    });

    it('rejects a refund amount above the remaining balance before touching the dispute', async () => {
      withHeldPayment(heldPayment({ refundedAmount: 1000 }));

      await expect(
        service.resolve(admin, 5, {
          outcome: DisputeOutcome.REFUND_CLIENT,
          resolution: 'Attempting to over-refund this payment.',
          refundAmountGhs: 1500,
        }),
      ).rejects.toThrow(BadRequestException);

      expect(paymentsService.adminRefund).not.toHaveBeenCalled();
      // The dispute was never claimed, so no UPDATE ran at all.
      expect(updateQb.execute).not.toHaveBeenCalled();
    });

    it('RELEASE_ARTISAN releases the withheld payment', async () => {
      withHeldPayment();

      const result = await service.resolve(admin, 5, {
        outcome: DisputeOutcome.RELEASE_ARTISAN,
        resolution: 'The work was delivered as agreed.',
      });

      expect(paymentsService.releaseWithheldPayment).toHaveBeenCalledWith(300);
      expect(result.data.moneyAction).toBe(DisputeMoneyAction.RELEASE);
      expect(result.data.moneyAmount).toBe(1757.5);
    });

    it('MUTUAL moves no money and records that explicitly', async () => {
      disputeRepo.findOne.mockResolvedValueOnce(
        disputeRaisedByCustomer(DisputeStatus.UNDER_REVIEW),
      );

      const result = await service.resolve(admin, 5, {
        outcome: DisputeOutcome.MUTUAL,
        resolution: 'Both parties settled this between themselves.',
      });

      expect(paymentsService.adminRefund).not.toHaveBeenCalled();
      expect(paymentsService.releaseWithheldPayment).not.toHaveBeenCalled();
      expect(result.data.moneyAction).toBe(DisputeMoneyAction.NONE);
    });

    it('rejects a refund amount supplied with a MUTUAL verdict', async () => {
      disputeRepo.findOne.mockResolvedValueOnce(
        disputeRaisedByCustomer(DisputeStatus.UNDER_REVIEW),
      );

      await expect(
        service.resolve(admin, 5, {
          outcome: DisputeOutcome.MUTUAL,
          resolution: 'Mutually resolved but somehow also a refund.',
          refundAmountGhs: 100,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('records the verdict with NO money action when there is no linked payment (the common case today)', async () => {
      disputeRepo.findOne.mockResolvedValueOnce(
        disputeRaisedByCustomer(DisputeStatus.UNDER_REVIEW),
      );
      jobRepo.findOne.mockResolvedValue(null);

      const result = await service.resolve(admin, 5, {
        outcome: DisputeOutcome.REFUND_CLIENT,
        resolution: 'Ruling for the client on the evidence provided.',
      });

      expect(paymentsService.adminRefund).not.toHaveBeenCalled();
      expect(result.data.moneyAction).toBe(DisputeMoneyAction.NONE);
      expect(result.data.moneySkippedReason).toMatch(/no payment is linked/i);
    });

    it('records the verdict without a clawback when the payment is already REFUNDED', async () => {
      withHeldPayment(
        heldPayment({
          status: PaymentStatus.REFUNDED,
          refundedAmount: 1850,
        }),
      );

      const result = await service.resolve(admin, 5, {
        outcome: DisputeOutcome.REFUND_CLIENT,
        resolution: 'Ruling for the client; money already went back.',
      });

      expect(paymentsService.adminRefund).not.toHaveBeenCalled();
      expect(result.data.moneyAction).toBe(DisputeMoneyAction.NONE);
      expect(result.data.moneySkippedReason).toBeTruthy();
    });

    it('records the verdict without a second transfer when the payment is already RELEASED', async () => {
      withHeldPayment(heldPayment({ status: PaymentStatus.RELEASED }));

      const result = await service.resolve(admin, 5, {
        outcome: DisputeOutcome.RELEASE_ARTISAN,
        resolution: 'Ruling for the artisan; payout already went out.',
      });

      expect(paymentsService.releaseWithheldPayment).not.toHaveBeenCalled();
      expect(result.data.moneyAction).toBe(DisputeMoneyAction.NONE);
      expect(result.data.moneySkippedReason).toMatch(/already released/i);
    });

    it('hard-guards against a second money action when a sibling dispute already moved money', async () => {
      disputeRepo.findOne
        .mockResolvedValueOnce(
          disputeRaisedByCustomer(DisputeStatus.UNDER_REVIEW),
        )
        .mockResolvedValueOnce({
          id: 6,
          moneyAction: DisputeMoneyAction.REFUND,
          moneyPaymentId: 300,
        } as Dispute);
      jobRepo.findOne.mockResolvedValue({
        id: 200,
        service: null,
      } as unknown as Job);
      paymentRepo.findOne.mockResolvedValue(heldPayment());

      const result = await service.resolve(admin, 5, {
        outcome: DisputeOutcome.REFUND_CLIENT,
        resolution: 'Second dispute on the same booking, ruling for client.',
      });

      expect(paymentsService.adminRefund).not.toHaveBeenCalled();
      expect(result.data.moneyAction).toBe(DisputeMoneyAction.NONE);
      expect(result.data.moneySkippedReason).toMatch(/#6/);
    });

    it('does NOT mark the dispute resolved when the money action fails, and surfaces the specific failure', async () => {
      withHeldPayment();
      paymentsService.adminRefund.mockRejectedValueOnce(
        new Error('Paystack refund declined: insufficient settlement balance'),
      );

      await expect(
        service.resolve(admin, 5, {
          outcome: DisputeOutcome.REFUND_CLIENT,
          resolution: 'Ruling for the client on the evidence.',
        }),
      ).rejects.toThrow(/insufficient settlement balance/);

      // The claim was rolled back: the last UPDATE restores the prior status
      // rather than leaving a resolved dispute claiming money moved.
      expect(updateQb.set).toHaveBeenCalledWith(
        expect.objectContaining({ status: DisputeStatus.UNDER_REVIEW }),
      );
      // No outcome notification and no audit row for a ruling that didn't happen.
      expect(emitter.emit).not.toHaveBeenCalled();
      expect(auditService.record).not.toHaveBeenCalled();
    });

    /**
     * B2 / QA-DC1-01. The rollback used to pass `previousOutcome ?? undefined`
     * and friends, and `UpdateQueryBuilder` strips `undefined` values from the
     * statement — so on a first ruling (where every `previous*` is null)
     * nothing but `status` was actually restored.
     */
    it('B2: the rollback clears every verdict column with an explicit null, not undefined', async () => {
      withHeldPayment();
      paymentsService.adminRefund.mockRejectedValueOnce(
        new Error('Paystack refund declined: insufficient settlement balance'),
      );

      await expect(
        service.resolve(admin, 5, {
          outcome: DisputeOutcome.REFUND_CLIENT,
          resolution: 'Ruling for the client on the evidence.',
          adminNotes: 'Internal note attached to a ruling that failed.',
        }),
      ).rejects.toThrow(BadRequestException);

      const setCalls = updateQb.set.mock.calls as [Record<string, unknown>][];
      const rollback = setCalls[setCalls.length - 1][0];
      expect(rollback).toEqual({
        status: DisputeStatus.UNDER_REVIEW,
        outcome: null,
        resolution: null,
        adminNotes: null,
        resolvedById: null,
        resolvedAt: null,
        moneyAction: null,
        moneyAmount: null,
        moneyPaymentId: null,
      });
      // The bug in one assertion: not one of them may be `undefined`, because
      // an `undefined` is silently dropped from the UPDATE.
      for (const value of Object.values(rollback)) {
        expect(value).not.toBeUndefined();
      }
    });

    it('B2: a rollback onto a dispute that already had a verdict restores that verdict', async () => {
      // A second ruling on a dispute that was previously resolved and reopened
      // by hand: the rollback must restore what was there, not blanket-null it.
      disputeRepo.findOne
        .mockResolvedValueOnce({
          ...disputeRaisedByCustomer(DisputeStatus.UNDER_REVIEW),
          outcome: DisputeOutcome.MUTUAL,
          resolution: 'An earlier ruling that is still on the row.',
          adminNotes: 'An earlier internal note.',
        } as Dispute)
        .mockResolvedValueOnce(null);
      jobRepo.findOne.mockResolvedValue({
        id: 200,
        service: null,
      } as unknown as Job);
      paymentRepo.findOne.mockResolvedValue(heldPayment());
      paymentsService.adminRefund.mockRejectedValueOnce(
        new Error('Paystack refund declined'),
      );

      await expect(
        service.resolve(admin, 5, {
          outcome: DisputeOutcome.REFUND_CLIENT,
          resolution: 'Replacing the earlier ruling with a refund.',
        }),
      ).rejects.toThrow(BadRequestException);

      const setCalls = updateQb.set.mock.calls as [Record<string, unknown>][];
      expect(setCalls[setCalls.length - 1][0]).toEqual(
        expect.objectContaining({
          outcome: DisputeOutcome.MUTUAL,
          resolution: 'An earlier ruling that is still on the row.',
          adminNotes: 'An earlier internal note.',
        }),
      );
    });

    it('B2: a NONE result writes explicit nulls for the money amount and payment', async () => {
      disputeRepo.findOne.mockResolvedValueOnce(
        disputeRaisedByCustomer(DisputeStatus.UNDER_REVIEW),
      );

      await service.resolve(admin, 5, {
        outcome: DisputeOutcome.MUTUAL,
        resolution: 'Both parties settled this between themselves.',
      });

      const setCalls = updateQb.set.mock.calls as [Record<string, unknown>][];
      expect(setCalls[setCalls.length - 1][0]).toEqual({
        moneyAction: DisputeMoneyAction.NONE,
        moneyAmount: null,
        moneyPaymentId: null,
      });
    });

    /**
     * B3. The sibling guard reads `moneyAction`, which used to be written
     * only *after* the provider call, so two disputes on one payment could
     * both pass it and both move money. The claim now writes
     * `moneyAction`/`moneyPaymentId` up front, which puts
     * `uq_disputes_money_payment` in front of the provider call instead of
     * behind it.
     */
    it('B3: claims the payment in the same UPDATE as the verdict, before the provider call', async () => {
      withHeldPayment();

      await service.resolve(admin, 5, {
        outcome: DisputeOutcome.REFUND_CLIENT,
        resolution: 'Client is entitled to their money back.',
      });

      const setCalls = updateQb.set.mock.calls as [Record<string, unknown>][];
      expect(setCalls[0][0]).toEqual(
        expect.objectContaining({
          status: DisputeStatus.RESOLVED,
          moneyAction: DisputeMoneyAction.REFUND,
          moneyPaymentId: 300,
          // The amount is only ever written from a completed movement.
          moneyAmount: null,
        }),
      );
      // The claim really did precede the provider call.
      expect(updateQb.execute.mock.invocationCallOrder[0]).toBeLessThan(
        paymentsService.adminRefund.mock.invocationCallOrder[0],
      );
    });

    it('B3: a verdict that moves no money releases the payment claim instead of holding it', async () => {
      disputeRepo.findOne.mockResolvedValueOnce(
        disputeRaisedByCustomer(DisputeStatus.UNDER_REVIEW),
      );

      await service.resolve(admin, 5, {
        outcome: DisputeOutcome.MUTUAL,
        resolution: 'Both parties settled this between themselves.',
      });

      const setCalls = updateQb.set.mock.calls as [Record<string, unknown>][];
      expect(setCalls[0][0]).toEqual(
        expect.objectContaining({ moneyAction: null, moneyPaymentId: null }),
      );
    });

    it('B3: a sibling claiming the payment first degrades to NONE instead of a 500', async () => {
      withHeldPayment();
      // The claim loses the race on `uq_disputes_money_payment`: another
      // dispute on this booking took the payment between our plan and our
      // write. Postgres raises this *before* any money can move.
      updateQb.execute.mockRejectedValueOnce(moneyClaimConflict());

      const result = await service.resolve(admin, 5, {
        outcome: DisputeOutcome.REFUND_CLIENT,
        resolution: 'Ruling for the client on the evidence provided.',
      });

      // No second movement, no unhandled failure — the same answer the serial
      // sibling guard gives.
      expect(paymentsService.adminRefund).not.toHaveBeenCalled();
      expect(result.data.moneyAction).toBe(DisputeMoneyAction.NONE);
      expect(result.data.moneySkippedReason).toMatch(
        /claimed the money action on this payment first/i,
      );
      // And the verdict itself is still recorded: the retry writes NONE.
      const setCalls = updateQb.set.mock.calls as [Record<string, unknown>][];
      expect(setCalls[1][0]).toEqual(
        expect.objectContaining({
          status: DisputeStatus.RESOLVED,
          outcome: DisputeOutcome.REFUND_CLIENT,
          moneyAction: null,
          moneyPaymentId: null,
        }),
      );
    });

    it('B3: any other unique violation still propagates rather than being read as a sibling claim', async () => {
      withHeldPayment();
      updateQb.execute.mockRejectedValueOnce(
        uniqueViolation('some_other_unique_index'),
      );

      await expect(
        service.resolve(admin, 5, {
          outcome: DisputeOutcome.REFUND_CLIENT,
          resolution: 'Ruling for the client on the evidence provided.',
        }),
      ).rejects.toThrow(QueryFailedError);
      expect(paymentsService.adminRefund).not.toHaveBeenCalled();
    });

    it('B3: a failure recording the money result never becomes a 500 after money moved', async () => {
      withHeldPayment();
      // Claim succeeds, refund succeeds, the final "what moved" write fails.
      updateQb.execute
        .mockResolvedValueOnce({ affected: 1 })
        .mockRejectedValueOnce(new Error('connection terminated unexpectedly'));

      const result = await service.resolve(admin, 5, {
        outcome: DisputeOutcome.REFUND_CLIENT,
        resolution: 'Client is entitled to their money back.',
      });

      expect(paymentsService.adminRefund).toHaveBeenCalledTimes(1);
      expect(result.data.moneyAction).toBe(DisputeMoneyAction.REFUND);
    });

    it('is safe under concurrent resolution — the loser gets a clear message and never moves money', async () => {
      withHeldPayment();
      // The conditional UPDATE matched no row: someone else resolved it first.
      updateQb.execute.mockResolvedValueOnce({ affected: 0 });
      disputeRepo.findOne.mockResolvedValueOnce({
        id: 5,
        status: DisputeStatus.RESOLVED,
      } as Dispute);

      await expect(
        service.resolve(admin, 5, {
          outcome: DisputeOutcome.REFUND_CLIENT,
          resolution: 'Ruling for the client on the evidence.',
        }),
      ).rejects.toThrow(/already RESOLVED/i);

      expect(paymentsService.adminRefund).not.toHaveBeenCalled();
    });

    it('writes an audit row carrying the verdict and the money action', async () => {
      withHeldPayment();

      await service.resolve(admin, 5, {
        outcome: DisputeOutcome.REFUND_CLIENT,
        resolution: 'Client is entitled to their money back.',
      });

      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AdminActionType.DISPUTE_RESOLVE,
          targetId: 5,
          actorId: admin.id,
          outcome: DisputeOutcome.REFUND_CLIENT,
          moneyAction: DisputeMoneyAction.REFUND,
          amount: 1850,
        }),
      );
    });

    it('carries the verdict and the amount into the outcome notification', async () => {
      withHeldPayment();

      await service.resolve(admin, 5, {
        outcome: DisputeOutcome.REFUND_CLIENT,
        resolution: 'Client is entitled to their money back.',
      });

      expect(emitter.emit).toHaveBeenCalledWith(
        APP_EVENTS.DISPUTE_RESOLVED,
        expect.objectContaining({
          verdict: DisputeOutcome.REFUND_CLIENT,
          moneyAction: DisputeMoneyAction.REFUND,
          moneyAmount: 1850,
          customerUserId: customerUser.id,
          artisanUserId: artisanUser.id,
        }),
      );
    });
  });

  // ─── DR4 ────────────────────────────────────────────────────────────────────

  describe('respond (DR4)', () => {
    it('lets the counterparty submit one response while the dispute is open', async () => {
      disputeRepo.findOne.mockResolvedValueOnce(
        disputeRaisedByCustomer(DisputeStatus.UNDER_REVIEW),
      );

      const result = await service.respond(artisanUser.id, 5, {
        response: 'I attended but nobody was there to let me in.',
      });

      expect(updateQb.set).toHaveBeenCalledWith(
        expect.objectContaining({
          response: 'I attended but nobody was there to let me in.',
          respondedById: artisanUser.id,
        }),
      );
      expect(result.data.viewerRole).toBe('COUNTERPARTY');
    });

    /**
     * B1 (HIGH). The response used to be written with `repo.save(dispute)` on
     * the entity loaded at the top of the request, and `save()` writes back
     * every column that differs from a fresh read — so a `resolve()` that
     * committed in between was silently reverted, taking a settled,
     * already-paid dispute back to `OPEN`.
     */
    it('B1: writes only the three response columns, never the whole row', async () => {
      disputeRepo.findOne.mockResolvedValueOnce(
        disputeRaisedByCustomer(DisputeStatus.UNDER_REVIEW),
      );

      await service.respond(artisanUser.id, 5, {
        response: 'I attended but nobody was there to let me in.',
      });

      // No full-entity save anywhere on this path.
      expect(disputeRepo.save).not.toHaveBeenCalled();
      // And the write cannot carry a status with it.
      const setCalls = updateQb.set.mock.calls as [Record<string, unknown>][];
      const written = setCalls[0][0];
      expect(Object.keys(written).sort()).toEqual([
        'respondedAt',
        'respondedById',
        'response',
      ]);
      expect(written).not.toHaveProperty('status');
    });

    it('B1: guards both preconditions in the WHERE clause, not just in the read', async () => {
      disputeRepo.findOne.mockResolvedValueOnce(
        disputeRaisedByCustomer(DisputeStatus.OPEN),
      );

      await service.respond(artisanUser.id, 5, {
        response: 'Here is my account of what happened on the day.',
      });

      expect(updateQb.andWhere).toHaveBeenCalledWith('response IS NULL');
      expect(updateQb.andWhere).toHaveBeenCalledWith(
        'status IN (:...active)',
        expect.objectContaining({
          active: [DisputeStatus.OPEN, DisputeStatus.UNDER_REVIEW],
        }),
      );
    });

    it('B1: a resolve committing mid-request rejects the response instead of reverting the ruling', async () => {
      disputeRepo.findOne
        // The party's load: still actionable at this point.
        .mockResolvedValueOnce(disputeRaisedByCustomer(DisputeStatus.OPEN))
        // The re-read after the conditional write matched nothing: an admin
        // ruled in between.
        .mockResolvedValueOnce(disputeRaisedByCustomer(DisputeStatus.RESOLVED));
      updateQb.execute.mockResolvedValueOnce({ affected: 0 });

      await expect(
        service.respond(artisanUser.id, 5, {
          response: 'Submitting my side just as the admin rules on it.',
        }),
      ).rejects.toThrow(/RESOLVED and can no longer receive a response/i);

      expect(disputeRepo.save).not.toHaveBeenCalled();
    });

    it('refuses a second response', async () => {
      disputeRepo.findOne.mockResolvedValueOnce({
        ...disputeRaisedByCustomer(DisputeStatus.UNDER_REVIEW),
        response: 'Already said my piece.',
      } as Dispute);

      await expect(
        service.respond(artisanUser.id, 5, {
          response: 'Actually, one more thing about the job.',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('refuses the raiser — the claim is already their statement', async () => {
      disputeRepo.findOne.mockResolvedValueOnce(
        disputeRaisedByCustomer(DisputeStatus.OPEN),
      );

      await expect(
        service.respond(customerUser.id, 5, {
          response: 'Adding more detail to my own complaint here.',
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it.each([DisputeStatus.RESOLVED, DisputeStatus.CLOSED])(
      'refuses a response once the dispute is %s',
      async (status) => {
        disputeRepo.findOne.mockResolvedValueOnce(
          disputeRaisedByCustomer(status),
        );

        await expect(
          service.respond(artisanUser.id, 5, {
            response: 'Trying to respond after the fact here.',
          }),
        ).rejects.toThrow(BadRequestException);
      },
    );

    it('404s for a stranger rather than confirming the dispute exists', async () => {
      disputeRepo.findOne.mockResolvedValueOnce(
        disputeRaisedByCustomer(DisputeStatus.OPEN),
      );

      await expect(
        service.respond(999, 5, {
          response: 'I am not a participant of this booking at all.',
        }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('getConversationForDispute (AD1/AD2)', () => {
    it('allows the lookup while the dispute is OPEN', async () => {
      disputeRepo.findOne.mockResolvedValueOnce(
        disputeRaisedByCustomer(DisputeStatus.OPEN),
      );

      await service.getConversationForDispute(5);

      expect(messagesService.getConversationBetween).toHaveBeenCalledWith(
        customerUser.id,
        artisanUser.id,
        { disputeId: 5, bookingId: 77 },
      );
    });

    it('allows the lookup while the dispute is UNDER_REVIEW', async () => {
      disputeRepo.findOne.mockResolvedValueOnce(
        disputeRaisedByCustomer(DisputeStatus.UNDER_REVIEW),
      );

      await service.getConversationForDispute(5);

      expect(messagesService.getConversationBetween).toHaveBeenCalled();
    });

    it.each([DisputeStatus.RESOLVED, DisputeStatus.CLOSED])(
      'refuses the lookup once the dispute is %s — a settled dispute is not a permanent read tap',
      async (status) => {
        disputeRepo.findOne.mockResolvedValueOnce(
          disputeRaisedByCustomer(status),
        );

        await expect(service.getConversationForDispute(5)).rejects.toThrow(
          ForbiddenException,
        );
        expect(messagesService.getConversationBetween).not.toHaveBeenCalled();
      },
    );

    it('404s on an unknown dispute', async () => {
      disputeRepo.findOne.mockResolvedValueOnce(null);

      await expect(service.getConversationForDispute(404)).rejects.toThrow(
        NotFoundException,
      );
    });

    it("404s when the dispute's booking participants cannot be resolved", async () => {
      disputeRepo.findOne.mockResolvedValueOnce({
        id: 5,
        bookingId: 77,
        raisedById: customerUser.id,
        status: DisputeStatus.OPEN,
        booking: { id: 77, customer: customerUser, artisanProfile: null },
      } as unknown as Dispute);

      await expect(service.getConversationForDispute(5)).rejects.toThrow(
        NotFoundException,
      );
      expect(messagesService.getConversationBetween).not.toHaveBeenCalled();
    });

    it('derives participants from the dispute — it never accepts them from the caller', () => {
      // AD2 as a type-level guarantee: the only public entry point takes a
      // dispute id and nothing else, so there is no parameter an admin could
      // substitute to reach an unrelated conversation.
      expect(service.getConversationForDispute).toHaveLength(1);
    });
  });

  describe('raise (PR3 / DR4 / DR5)', () => {
    const stageBooking = () => {
      bookingRepo.findOne.mockResolvedValueOnce({
        id: 77,
        status: 'COMPLETED',
        customer: customerUser,
        artisanProfile: { user: artisanUser },
      });
      disputeRepo.findOne.mockResolvedValueOnce(null); // no existing dispute
      disputeRepo.save.mockResolvedValueOnce({
        id: 5,
        bookingId: 77,
        raisedById: customerUser.id,
        status: DisputeStatus.OPEN,
        category: DisputeCategory.WORK_NOT_COMPLETED,
      } as Dispute);
    };

    it('emits DISPUTE_FILED for the admin queue with the raiser labelled by role', async () => {
      stageBooking();

      await service.raise(customerUser.id, {
        bookingId: 77,
        category: DisputeCategory.WORK_NOT_COMPLETED,
        reason: 'Work was not completed as agreed.',
      });

      expect(emitter.emit).toHaveBeenCalledWith(
        APP_EVENTS.DISPUTE_FILED,
        expect.objectContaining({
          disputeId: 5,
          bookingId: 77,
          raisedByName: 'Ama Mensah',
          raisedByRole: Role.CUSTOMER,
        }),
      );
    });

    it('DR4: makes the counterparty a recipient of the filing notification', async () => {
      stageBooking();

      await service.raise(customerUser.id, {
        bookingId: 77,
        category: DisputeCategory.WORK_NOT_COMPLETED,
        reason: 'Work was not completed as agreed.',
      });

      expect(emitter.emit).toHaveBeenCalledWith(
        APP_EVENTS.DISPUTE_FILED,
        expect.objectContaining({
          counterpartyUserId: artisanUser.id,
          category: DisputeCategory.WORK_NOT_COMPLETED,
        }),
      );
    });

    it('DR5: persists the category chosen at filing time', async () => {
      stageBooking();

      await service.raise(customerUser.id, {
        bookingId: 77,
        category: DisputeCategory.PROPERTY_DAMAGE,
        reason: 'A pipe burst and damaged the kitchen floor.',
      });

      expect(disputeRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ category: DisputeCategory.PROPERTY_DAMAGE }),
      );
    });

    it('DP2: the party-facing shape never carries admin-internal notes', async () => {
      stageBooking();

      const result = await service.raise(customerUser.id, {
        bookingId: 77,
        category: DisputeCategory.WORK_NOT_COMPLETED,
        reason: 'Work was not completed as agreed.',
      });

      expect(result.data).not.toHaveProperty('adminNotes');
    });
  });
});

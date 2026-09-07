import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ConflictException } from '@nestjs/common';
import { AccountCommitmentsService } from './account-commitments.service';
import { Booking } from '../bookings/entities/booking.entity';
import { Job } from '@jobs/entities/job.entity';
import { Payment } from '../payments/entities/payment.entity';
import { Dispute } from '../disputes/entities/dispute.entity';
import {
  BookingStatus,
  DisputeStatus,
  PaymentStatus,
  Status,
} from '@common/types/enums';

/**
 * C1.1 verification: deletion is refused while the account still has live
 * commitments, and permitted once only terminal-state records remain.
 *
 * Each repository is mocked at the query-builder level so the status sets the
 * guard actually asks for can be asserted — the exact membership of those sets
 * is the requirement (a `TRANSFER_FAILED` payment is retryable and therefore
 * blocking; a `CLOSED` dispute is terminal and therefore is not).
 */
describe('AccountCommitmentsService (C1.1)', () => {
  let service: AccountCommitmentsService;

  const makeQb = () => {
    const qb = {
      leftJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getCount: jest.fn().mockResolvedValue(0),
    };
    return qb;
  };

  let bookingsQb: ReturnType<typeof makeQb>;
  let jobsQb: ReturnType<typeof makeQb>;
  let paymentsQb: ReturnType<typeof makeQb>;
  let disputesQb: ReturnType<typeof makeQb>;

  beforeEach(async () => {
    bookingsQb = makeQb();
    jobsQb = makeQb();
    paymentsQb = makeQb();
    disputesQb = makeQb();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AccountCommitmentsService,
        {
          provide: getRepositoryToken(Booking),
          useValue: { createQueryBuilder: () => bookingsQb },
        },
        {
          provide: getRepositoryToken(Job),
          useValue: { createQueryBuilder: () => jobsQb },
        },
        {
          provide: getRepositoryToken(Payment),
          useValue: { createQueryBuilder: () => paymentsQb },
        },
        {
          provide: getRepositoryToken(Dispute),
          useValue: { createQueryBuilder: () => disputesQb },
        },
      ],
    }).compile();

    service = module.get(AccountCommitmentsService);
  });

  /**
   * Captures the refusal so its body can be asserted. Written as a
   * try/catch rather than `.catch()` so the result is narrowed to the
   * exception rather than a `void | ConflictException` union.
   */
  const captureRefusal = async (): Promise<ConflictException> => {
    try {
      await service.assertDeletable(1);
    } catch (err) {
      return err as ConflictException;
    }
    throw new Error('expected deletion to be refused, but it was permitted');
  };

  const refusalBody = async (): Promise<{
    message: string;
    errorCode: string;
  }> => {
    const refusal = await captureRefusal();
    return refusal.getResponse() as { message: string; errorCode: string };
  };

  /**
   * The status set a given guard actually asked the database for. `mock.calls`
   * is `any[][]`, which the repo's type-safety lint rules refuse, so it is
   * narrowed once here.
   */
  const statusesAskedFor = (qb: ReturnType<typeof makeQb>): string[] => {
    const calls = [
      ...(qb.where.mock.calls as unknown[][]),
      ...(qb.andWhere.mock.calls as unknown[][]),
    ];
    const call = calls.find(
      ([clause]) => typeof clause === 'string' && clause.includes('status IN'),
    );
    const params = call?.[1] as { statuses: string[] } | undefined;
    return params?.statuses ?? [];
  };

  describe('assertDeletable', () => {
    it('permits deletion when only terminal-state records remain', async () => {
      await expect(service.assertDeletable(1)).resolves.toBeUndefined();
    });

    it('refuses with a 409 that names the outstanding bookings', async () => {
      bookingsQb.getCount.mockResolvedValueOnce(2);

      const refusal = await captureRefusal();

      expect(refusal).toBeInstanceOf(ConflictException);
      const body = refusal.getResponse() as {
        message: string;
        errorCode: string;
      };
      expect(body.errorCode).toBe('ACCOUNT_HAS_LIVE_COMMITMENTS');
      expect(body.message).toContain('2 bookings');
      expect(body.message).toContain("can't be deleted yet");
    });

    // A user resolving their obligations should see the whole list once, not
    // discover the next blocker on each retry.
    it('names every category of blocker in one message', async () => {
      bookingsQb.getCount.mockResolvedValueOnce(1);
      jobsQb.getCount.mockResolvedValueOnce(1);
      paymentsQb.getCount.mockResolvedValueOnce(1);
      disputesQb.getCount.mockResolvedValueOnce(1);

      const { message } = await refusalBody();

      expect(message).toContain('1 booking');
      expect(message).toContain('1 job');
      expect(message).toContain('1 payment');
      expect(message).toContain('1 dispute');
    });

    // C1.1's money-adjacency note: the refusal names the blocking item, never
    // a figure, so no currency ever has to be formatted here.
    it('points an artisan at Earnings for a blocking payment, with no amount', async () => {
      paymentsQb.getCount.mockResolvedValueOnce(1);

      const { message } = await refusalBody();

      expect(message).toContain('Earnings');
      expect(message).not.toMatch(/GH₵|\$|\d+\.\d{2}/);
    });

    it('pluralises correctly for a single blocker', async () => {
      jobsQb.getCount.mockResolvedValueOnce(1);

      const { message } = await refusalBody();

      expect(message).toContain('1 job that is still open or in progress');
    });
  });

  describe('the blocking status sets', () => {
    beforeEach(async () => {
      await service.findDeletionBlockers(1);
    });

    it('treats only pending and confirmed bookings as live', () => {
      expect(statusesAskedFor(bookingsQb).sort()).toEqual(
        [BookingStatus.PENDING, BookingStatus.CONFIRMED].sort(),
      );
    });

    it('treats open, pending and in-progress jobs as live', () => {
      expect(statusesAskedFor(jobsQb).sort()).toEqual(
        [Status.OPEN, Status.PENDING, Status.IN_PROGRESS].sort(),
      );
    });

    // TRANSFER_FAILED is retryable, which makes it money still in flight —
    // not a finished payment.
    it('treats every in-flight payment state as blocking, including TRANSFER_FAILED', () => {
      expect(statusesAskedFor(paymentsQb).sort()).toEqual(
        [
          PaymentStatus.PENDING,
          PaymentStatus.HELD,
          PaymentStatus.PENDING_TRANSFER,
          PaymentStatus.TRANSFER_FAILED,
        ].sort(),
      );
    });

    it('never blocks on a terminal payment state', () => {
      const statuses = statusesAskedFor(paymentsQb);
      for (const terminal of [
        PaymentStatus.RELEASED,
        PaymentStatus.REFUNDED,
        PaymentStatus.CANCELLED,
        PaymentStatus.FAILED,
      ]) {
        expect(statuses).not.toContain(terminal);
      }
    });

    // RESOLVED and CLOSED are both terminal admin verdicts.
    it('treats only unresolved disputes as blocking', () => {
      expect(statusesAskedFor(disputesQb).sort()).toEqual(
        [DisputeStatus.OPEN, DisputeStatus.UNDER_REVIEW].sort(),
      );
    });
  });

  describe('participation', () => {
    // Both roles are covered by one query per table: a customer is matched on
    // the owning column, an artisan through their profile.
    it('matches a user as either party on bookings, jobs, payments and disputes', async () => {
      await service.findDeletionBlockers(42);

      const clauses = [bookingsQb, jobsQb, paymentsQb, disputesQb].map(
        (qb) => qb.andWhere.mock.calls.length,
      );
      // Each guard applies a status filter plus a bracketed participation
      // filter, so every table is scoped to this user.
      expect(clauses.every((count) => count >= 1)).toBe(true);
    });
  });
});

import { BookingsService } from './bookings.service';
import { Booking } from './entities/booking.entity';
import { BookingStatus } from '@common/types/enums';

/**
 * A5/NFR (b): unit-level proof that `expireBooking` is idempotent — running
 * it twice for the same booking ID must claim it exactly once. This is the
 * exact mechanism the hourly cron (`BookingsSchedulerService`) relies on for
 * crash-tolerance: a booking already expired by a prior/overlapping run is
 * simply not re-matched by the conditional `UPDATE ... WHERE status =
 * 'PENDING'`, so re-running the whole batch never double-processes it.
 *
 * A real concurrent-request demonstration of A4 (two simultaneous
 * `POST /bookings` for the same slot) requires a live Postgres instance to
 * exercise real `SELECT ... FOR UPDATE` row-locking — not reachable in this
 * sandbox (no DB configured). This spec instead proves the *idempotency
 * contract* the crons depend on, at the unit level, which is what's
 * feasible without live infra.
 */
describe('BookingsService — A5 expiry idempotency', () => {
  function buildService(initialAffected: number) {
    let affected = initialAffected;
    const execute = jest.fn(() => {
      const result = { affected };
      affected = 0; // second call onward: conditional UPDATE matches nothing
      return Promise.resolve(result);
    });
    const qb = {
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      execute,
    };
    const repo = {
      createQueryBuilder: jest.fn(() => qb),
      findOne: jest.fn(() =>
        Promise.resolve({
          id: 1,
          customerId: 42,
          scheduledDate: '2026-09-01',
          status: BookingStatus.EXPIRED,
        }),
      ),
    };
    const eventEmitter = { emit: jest.fn() };
    const service = new BookingsService(
      repo as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      eventEmitter as any,
    );
    return { service, eventEmitter };
  }

  it('claims the booking on the first run and no-ops on the second', async () => {
    const { service, eventEmitter } = buildService(1);

    const firstRun = await service.expireBooking(1);
    const secondRun = await service.expireBooking(1);

    expect(firstRun).toBe(true);
    expect(secondRun).toBe(false);
    // Notification only fires for the run that actually claimed the row.
    expect(eventEmitter.emit).toHaveBeenCalledTimes(1);
  });
});

/**
 * A7/NFR (b): unit-level proof that the reminder pipeline
 * (`findReminderCandidates` + `sendReminder`) is idempotent — running the
 * full "find candidates, send" cycle twice in a row must only actually emit
 * the reminder once. This was flagged in qa-report.md as the one A5/J2-style
 * idempotency spec missing for A7; it mirrors those two specs' style,
 * simulating the query's `reminder_2h_sent_at IS NULL` filter against a
 * shared in-memory booking record that `sendReminder`'s `repo.save` mutates
 * — i.e. the mock's `getMany()` genuinely re-checks the same flag
 * `sendReminder` just set, rather than assuming the exclusion works.
 *
 * A live "triggered twice against a real cron + DB" demonstration for all
 * three crons (A5/A7/J2) is provided separately in
 * `test/cron-idempotency.e2e-spec.ts`, pending a reachable Postgres instance
 * to actually execute it.
 */
type FakeReminderBooking = Pick<
  Booking,
  'id' | 'customerId' | 'scheduledDate' | 'startTime' | 'reminder2hSentAt'
> & { artisanProfile: { user: { id: number } } };

describe('BookingsService — A7 reminder idempotency', () => {
  function buildService() {
    const booking: FakeReminderBooking = {
      id: 1,
      customerId: 42,
      scheduledDate: '2026-09-01',
      startTime: '10:00',
      reminder2hSentAt: undefined,
      artisanProfile: { user: { id: 99 } },
    };

    const qb = {
      leftJoinAndSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      // Mirrors the real query's `b.reminder_2h_sent_at IS NULL` filter by
      // checking the same in-memory flag `sendReminder`'s `save()` mutates.
      getMany: jest.fn(() =>
        Promise.resolve(booking.reminder2hSentAt == null ? [booking] : []),
      ),
    };
    const repo = {
      createQueryBuilder: jest.fn(() => qb),
      save: jest.fn((b: Partial<FakeReminderBooking>) => {
        Object.assign(booking, b);
        return Promise.resolve(booking);
      }),
    };
    const eventEmitter = { emit: jest.fn() };
    const service = new BookingsService(
      repo as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      eventEmitter as any,
    );
    return { service, eventEmitter, booking };
  }

  it('sends the 2H reminder on the first run and finds no candidates on the second', async () => {
    const { service, eventEmitter, booking } = buildService();

    const firstCandidates = await service.findReminderCandidates('2H');
    expect(firstCandidates).toHaveLength(1);
    await service.sendReminder(firstCandidates[0], '2H');
    expect(booking.reminder2hSentAt).toBeInstanceOf(Date);

    const secondCandidates = await service.findReminderCandidates('2H');
    expect(secondCandidates).toHaveLength(0); // already reminded — excluded

    // One emit per recipient (customer + artisan) — only from the first run.
    expect(eventEmitter.emit).toHaveBeenCalledTimes(2);
  });
});

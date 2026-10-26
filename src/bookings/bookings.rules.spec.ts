import { BadRequestException } from '@nestjs/common';
import { BookingsService, toClockTime } from './bookings.service';
import { Booking } from './entities/booking.entity';
import { Job } from '@jobs/entities/job.entity';
import { JobStatusHistory } from '@jobs/entities/job-status-history.entity';
import { BookingStatus, Status } from '@common/types/enums';

/**
 * QA BK-08 / BK-10 / ADM-06 / BK-23 / BK-24 and the 06:00 start-time bug.
 * create() is checked only up to its early refusals; the full booking path
 * runs against the real database in test/booking-rules.e2e-spec.ts.
 */
describe('BookingsService booking rules', () => {
  const plumbing = { id: 3, name: 'Plumbing' };

  function bookableProfile(overrides: Record<string, unknown> = {}) {
    return {
      id: 9,
      isProfileComplete: true,
      availabilityStatus: 'AVAILABLE',
      services: [plumbing],
      user: { id: 20, isBanned: false, isSuspended: false },
      ...overrides,
    };
  }

  function build({
    profile = bookableProfile() as unknown,
    booking = undefined as unknown,
    linkedJob = null as unknown,
  } = {}) {
    const profileRepo = { findOne: jest.fn(() => Promise.resolve(profile)) };
    const serviceRepo = { findOne: jest.fn(() => Promise.resolve(plumbing)) };
    const bookingRepo = {
      findOne: jest.fn(() => Promise.resolve(booking)),
      save: jest.fn((b: unknown) => Promise.resolve(b)),
    };
    const jobRepo = {
      findOne: jest.fn(() => Promise.resolve(linkedJob)),
      save: jest.fn((j: unknown) => Promise.resolve(j)),
    };
    const historyRepo = {
      create: jest.fn((h: unknown) => h),
      save: jest.fn((h: unknown) => Promise.resolve(h)),
    };
    const manager = {
      getRepository: jest.fn((entity: unknown) => {
        if (entity === Booking) return bookingRepo;
        if (entity === Job) return jobRepo;
        if (entity === JobStatusHistory) return historyRepo;
        throw new Error('unexpected repository');
      }),
    };
    const dataSource = {
      transaction: jest.fn((cb: (m: typeof manager) => Promise<unknown>) =>
        cb(manager),
      ),
    };
    const jobsService = { confirmCompletion: jest.fn(() => Promise.resolve()) };
    const service = new BookingsService(
      bookingRepo as never,
      profileRepo as never,
      {} as never,
      serviceRepo as never,
      jobRepo as never,
      dataSource as never,
      {} as never,
      { emit: jest.fn() } as never,
      {} as never,
      jobsService as never,
    );
    return { service, jobRepo, bookingRepo, historyRepo, jobsService };
  }

  const request = {
    artisanProfileId: 9,
    serviceId: 3,
    scheduledDate: '2027-03-01',
    startTime: '10:00',
  };

  describe('who can be booked (BK-10, ADM-06)', () => {
    it.each([
      ['suspended', { user: { id: 20, isBanned: false, isSuspended: true } }],
      ['banned', { user: { id: 20, isBanned: true, isSuspended: false } }],
      ['incomplete', { isProfileComplete: false }],
      ['busy', { availabilityStatus: 'BUSY' }],
      ['unavailable', { availabilityStatus: 'UNAVAILABLE' }],
    ])('refuses a %s artisan', async (_label, overrides) => {
      const { service } = build({ profile: bookableProfile(overrides) });
      await expect(service.create(42, request)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  it("refuses a service the artisan doesn't offer (BK-08)", async () => {
    const { service } = build({
      profile: bookableProfile({ services: [{ id: 7, name: 'Tiling' }] }),
    });
    await expect(service.create(42, request)).rejects.toThrow(
      /doesn't offer that service/,
    );
  });

  it('normalises clock times so 06:00 matches a window opening at 06:00:00', () => {
    expect(toClockTime('06:00')).toBe('06:00:00');
    expect(toClockTime('06:00:00')).toBe('06:00:00');
    expect(toClockTime('06:00') >= toClockTime('06:00:00')).toBe(true);
  });

  describe('completing a booking (BK-23)', () => {
    const confirmed = () =>
      ({
        id: 77,
        customerId: 42,
        status: BookingStatus.CONFIRMED,
        scheduledDate: '2026-10-01',
        artisanProfile: { user: { id: 20 } },
      }) as unknown as Booking;

    it('completes an unpaid linked job together with the booking', async () => {
      const job = { id: 200, status: Status.PENDING } as Job;
      const { service, jobRepo, historyRepo } = build({
        booking: confirmed(),
        linkedJob: job,
      });

      await service.complete(42, 77);

      expect(jobRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ id: 200, status: Status.COMPLETED }),
      );
      expect(historyRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          fromStatus: Status.PENDING,
          toStatus: Status.COMPLETED,
        }),
      );
    });

    it("hands a paid job to the job's completion flow, which releases the money", async () => {
      const job = {
        id: 200,
        status: Status.IN_PROGRESS,
        completionRequestedAt: new Date(),
        paymentIntentId: 'jinva-200-42-1',
      } as Job;
      const { service, jobsService, bookingRepo } = build({
        booking: confirmed(),
        linkedJob: job,
      });

      await service.complete(42, 77);

      expect(jobsService.confirmCompletion).toHaveBeenCalledWith(200, 42);
      expect(bookingRepo.save).not.toHaveBeenCalled();
    });

    it("explains that a paid job the artisan hasn't finished can't be completed yet", async () => {
      const job = {
        id: 200,
        status: Status.PENDING,
        paymentIntentId: 'jinva-200-42-1',
      } as Job;
      const { service, jobsService, bookingRepo } = build({
        booking: confirmed(),
        linkedJob: job,
      });

      await expect(service.complete(42, 77)).rejects.toThrow(
        /needs to start the job/,
      );
      expect(jobsService.confirmCompletion).not.toHaveBeenCalled();
      expect(bookingRepo.save).not.toHaveBeenCalled();
    });
  });
});

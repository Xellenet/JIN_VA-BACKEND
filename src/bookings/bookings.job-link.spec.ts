import { BookingsService } from './bookings.service';
import { Booking } from './entities/booking.entity';
import { Job } from '@jobs/entities/job.entity';
import { JobStatusHistory } from '@jobs/entities/job-status-history.entity';
import { JobAttachment } from '@jobs/entities/job-attachment.entity';
import { BookingStatus, Status } from '@common/types/enums';

/**
 * DR3 regression guard: `BookingsService.confirm()` must write `Job.booking`
 * when it turns a confirmed booking into a job.
 *
 * That single relation is the first hop of the chain the admin dispute
 * screen's Linked Payment panel walks — `Dispute → Booking → Job → Payment`
 * (`DisputesService.findLinkedWork`). If it stops being written, the panel
 * silently degrades to "No payment on file for this booking." for *every*
 * dispute, with no error and no failing test anywhere else in the suite: the
 * job is still created, the booking is still confirmed, and nothing breaks
 * except the money link an admin needs to rule on a dispute. That failure mode
 * is exactly why this guard exists as its own spec rather than as an assertion
 * buried in a broader confirm() test.
 *
 * QA JOB-22: `confirm()` now also creates the job's payment, inside the same
 * transaction, at the booking's agreed price or the price the artisan sets
 * while confirming.
 */
describe('BookingsService — DR3: confirm() links the Job to its Booking', () => {
  function buildService({ agreedPrice = 150 as number | null } = {}) {
    const bookingRow = {
      id: 77,
      status: BookingStatus.PENDING,
      currency: 'GHS',
      agreedPrice,
      notes: 'Leak under the kitchen sink.',
      attachmentUrls: [],
      customerId: 42,
      customer: { id: 42, firstname: 'Ama', lastname: 'Mensah' },
      service: { id: 3, name: 'Plumbing' },
      artisanProfile: {
        id: 9,
        businessName: 'Yaw Plumbing',
        location: '12 Ring Road, Accra',
        user: { id: 20, firstname: 'Yaw', lastname: 'Boateng' },
      },
    } as unknown as Booking;

    /** Captures whatever `confirm()` hands to `jobRepo.create`. */
    const createdJobs: Partial<Job>[] = [];

    const bookingRepo = {
      findOne: jest.fn(() => Promise.resolve(bookingRow)),
      save: jest.fn((b: Booking) => Promise.resolve(b)),
    };
    const jobRepo = {
      // No existing job for this booking, so confirm() takes the create path.
      findOne: jest.fn(() => Promise.resolve(null)),
      create: jest.fn((payload: Partial<Job>) => {
        createdJobs.push(payload);
        return payload as Job;
      }),
      save: jest.fn((j: Job) => Promise.resolve({ ...j, id: 200 })),
    };
    const historyRepo = {
      create: jest.fn((p: Partial<JobStatusHistory>) => p),
      save: jest.fn((p: JobStatusHistory) => Promise.resolve(p)),
    };
    const attachmentRepo = {
      create: jest.fn((p: Partial<JobAttachment>) => p),
      save: jest.fn((p: JobAttachment) => Promise.resolve(p)),
    };

    const manager = {
      getRepository: jest.fn((entity: unknown) => {
        if (entity === Booking) return bookingRepo;
        if (entity === Job) return jobRepo;
        if (entity === JobStatusHistory) return historyRepo;
        return attachmentRepo;
      }),
    };
    const dataSource = {
      transaction: jest.fn((cb: (m: typeof manager) => Promise<unknown>) =>
        cb(manager),
      ),
    };
    const eventEmitter = { emit: jest.fn() };
    const paymentsService = {
      holdPayment: jest.fn(() => Promise.resolve('jinva-200-42-1')),
    };

    const service = new BookingsService(
      bookingRepo as never,
      {} as never,
      {} as never,
      {} as never,
      jobRepo as never,
      dataSource as never,
      {} as never,
      eventEmitter as never,
      paymentsService as never,
      {} as never,
    );

    return {
      service,
      createdJobs,
      bookingRow,
      jobRepo,
      bookingRepo,
      paymentsService,
      manager,
    };
  }

  it('writes the booking relation onto the job it creates', async () => {
    const { service, createdJobs, bookingRow } = buildService();

    await service.confirm(20, 77, {});

    expect(createdJobs).toHaveLength(1);
    // The relation object, not just an id — TypeORM resolves `booking_id` from
    // the loaded entity, and this is what `findLinkedWork` filters on.
    expect(createdJobs[0].booking).toBe(bookingRow);
  });

  it('creates the job in PENDING with the booking-derived price and artisan', async () => {
    const { service, createdJobs } = buildService();

    await service.confirm(20, 77, {});

    expect(createdJobs[0]).toEqual(
      expect.objectContaining({
        status: Status.PENDING,
        budgetMin: 150,
        budgetMax: 150,
        currency: 'GHS',
      }),
    );
  });

  it('returns the linked job id, so the caller can reach the created job', async () => {
    const { service } = buildService();

    const result = await service.confirm(20, 77, {});

    expect(result.data).toEqual({ jobId: 200 });
  });

  describe('payment (QA JOB-22)', () => {
    it('creates the payment at the agreed price, in the same transaction', async () => {
      const { service, paymentsService, manager, jobRepo } = buildService();

      await service.confirm(20, 77, {});

      expect(paymentsService.holdPayment).toHaveBeenCalledWith(
        200,
        42,
        20,
        150,
        manager,
      );
      expect(jobRepo.save).toHaveBeenLastCalledWith(
        expect.objectContaining({ paymentIntentId: 'jinva-200-42-1' }),
      );
    });

    it("uses the artisan's price when the booking has none, and records it", async () => {
      const { service, paymentsService, createdJobs, bookingRow } =
        buildService({ agreedPrice: null });

      await service.confirm(20, 77, { price: 220 });

      expect(paymentsService.holdPayment).toHaveBeenCalledWith(
        200,
        42,
        20,
        220,
        expect.anything(),
      );
      expect(createdJobs[0]).toEqual(
        expect.objectContaining({ budgetMin: 220, budgetMax: 220 }),
      );
      expect(bookingRow.agreedPrice).toBe(220);
    });

    it('refuses to confirm a booking with no price, changing nothing', async () => {
      const { service, paymentsService, bookingRepo } = buildService({
        agreedPrice: null,
      });

      await expect(service.confirm(20, 77, {})).rejects.toThrow(
        /Set your price/,
      );
      expect(bookingRepo.save).not.toHaveBeenCalled();
      expect(paymentsService.holdPayment).not.toHaveBeenCalled();
    });

    it("won't let the artisan change a price the customer already agreed", async () => {
      const { service, bookingRepo } = buildService();

      await expect(service.confirm(20, 77, { price: 300 })).rejects.toThrow(
        /already has an agreed price of GHS 150.00/,
      );
      expect(bookingRepo.save).not.toHaveBeenCalled();
    });
  });
});

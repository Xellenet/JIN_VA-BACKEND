import { BookingsService } from './bookings.service';
import { Booking } from './entities/booking.entity';
import { Job } from '@jobs/entities/job.entity';
import { BookingStatus } from '@common/types/enums';

/**
 * Exact location (Act 843): a booking's pin and landmark go to its customer
 * always, and to its artisan only once the booking is confirmed. Confirming
 * copies the pin and the area label onto the job it creates. Fictional pin:
 * Adum, Kumasi.
 */
describe('BookingsService — exact location', () => {
  const PIN = {
    location: 'Adum, Kumasi',
    latitude: 6.6885,
    longitude: -1.6244,
    locationAccuracyM: 8,
    landmark: 'Opposite Adum Post Office, blue gate',
  };
  const PRIVATE = ['latitude', 'longitude', 'locationAccuracyM', 'landmark'];

  const booking = (status: BookingStatus, extra: Partial<Booking> = {}) =>
    ({
      id: 77,
      status,
      currency: 'GHS',
      agreedPrice: 150,
      notes: null,
      attachmentUrls: [],
      customerId: 42,
      customer: { id: 42, firstname: 'Ama', lastname: 'Mensah' },
      service: { id: 3, name: 'Plumbing' },
      artisanProfile: {
        id: 9,
        businessName: 'Yaw Plumbing',
        location: 'Asafo, Kumasi',
        user: { id: 20, firstname: 'Yaw', lastname: 'Osei' },
      },
      ...PIN,
      ...extra,
    }) as unknown as Booking;

  it.each([
    [BookingStatus.PENDING, 42, true],
    [BookingStatus.PENDING, 20, false],
    [BookingStatus.DECLINED, 20, false],
    [BookingStatus.CANCELLED, 20, false],
    [BookingStatus.EXPIRED, 20, false],
    [BookingStatus.CONFIRMED, 20, true],
    [BookingStatus.COMPLETED, 20, true],
    [BookingStatus.NO_SHOW, 20, true],
    [BookingStatus.CONFIRMED, 99, false],
  ])('%s booking, viewer %i -> %s', (status, viewer, expected) => {
    expect(BookingsService.canSeeExactLocation(booking(status), viewer)).toBe(
      expected,
    );
  });

  function buildService(row: Booking) {
    const createdJobs: Partial<Job>[] = [];
    const bookingRepo = {
      findOne: jest.fn(() => Promise.resolve(row)),
      save: jest.fn((b: Booking) => Promise.resolve(b)),
    };
    const jobRepo = {
      findOne: jest.fn(() => Promise.resolve(null)),
      create: jest.fn((payload: Partial<Job>) => {
        createdJobs.push(payload);
        return payload as Job;
      }),
      save: jest.fn((j: Job) => Promise.resolve({ ...j, id: 200 })),
    };
    const other = {
      create: jest.fn((p: unknown) => p),
      save: jest.fn((p: unknown) => Promise.resolve(p)),
    };
    const manager = {
      getRepository: jest.fn((entity: unknown) => {
        if (entity === Booking) return bookingRepo;
        if (entity === Job) return jobRepo;
        return other;
      }),
    };
    const service = new BookingsService(
      bookingRepo as never,
      {} as never,
      {} as never,
      {} as never,
      jobRepo as never,
      {
        transaction: jest.fn((cb: (m: typeof manager) => Promise<unknown>) =>
          cb(manager),
        ),
      } as never,
      {} as never,
      { emit: jest.fn() } as never,
      { holdPayment: jest.fn(() => Promise.resolve('ref')) } as never,
      {} as never,
    );
    return { service, createdJobs };
  }

  it('shows the area but not the pin to the artisan of a pending request', async () => {
    const { service } = buildService(booking(BookingStatus.PENDING));
    const { data } = await service.findOne(77, 20);
    expect(data.location).toBe('Adum, Kumasi');
    for (const key of PRIVATE) expect(data).not.toHaveProperty(key);
  });

  it('shows the pin to the customer and to the artisan once confirmed', async () => {
    const pending = buildService(booking(BookingStatus.PENDING));
    expect((await pending.service.findOne(77, 42)).data).toMatchObject(PIN);
    const confirmed = buildService(booking(BookingStatus.CONFIRMED));
    expect((await confirmed.service.findOne(77, 20)).data).toMatchObject(PIN);
  });

  it("copies the customer's place onto the job made on confirmation", async () => {
    const { service, createdJobs } = buildService(
      booking(BookingStatus.PENDING),
    );
    await service.confirm(20, 77, {});
    expect(createdJobs[0]).toMatchObject(PIN);
  });

  it("falls back to the artisan's place for a booking without one", async () => {
    const { service, createdJobs } = buildService(
      booking(BookingStatus.PENDING, {
        location: null,
        latitude: null,
        longitude: null,
        locationAccuracyM: null,
        landmark: null,
      }),
    );
    await service.confirm(20, 77, {});
    expect(createdJobs[0]).toMatchObject({
      location: 'Asafo, Kumasi',
      latitude: null,
      longitude: null,
      landmark: null,
    });
  });
});

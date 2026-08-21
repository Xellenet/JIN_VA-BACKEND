import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, Logger } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { User } from '@users/entities/user.entity';
import { ArtisanProfile } from '@users/entities/artisan-profile.entity';
import { ServiceEntity } from '@services/entities/service.entity';
import { Booking } from '../src/bookings/entities/booking.entity';
import { Job } from '@jobs/entities/job.entity';
import { BookingsSchedulerService } from '../src/scheduler/bookings-scheduler.service';
import { JobsSchedulerService } from '../src/scheduler/jobs-scheduler.service';
import { Role, BookingStatus, Status } from '@common/types/enums';
import { APP_EVENTS } from '@common/events/app.events';
import { VARIABLES } from '@common/constants/variables.constants';

/**
 * A5/A7/J2 + NFR (b): a REAL "triggered twice against a live DB" proof for
 * all three crons this remediation added, calling the exact same public
 * methods `@Cron` invokes (`BookingsSchedulerService.expirePendingBookings`,
 * `.sendAppointmentReminders`, `JobsSchedulerService.autoCompleteOverdueJobs`)
 * against a real Postgres-backed Nest application — not mocked repositories.
 *
 * There is intentionally no admin/debug endpoint to fire a cron on demand
 * (documented decision, see api-contract.md §13/security-report), so calling
 * these services' own methods directly — the same code path `@Cron` invokes
 * on schedule — is the closest live-execution equivalent to "trigger it
 * twice" available without waiting for the real hourly/30-min/daily
 * schedule. Each cron is invoked twice in immediate succession and the test
 * asserts (a) the DB converges to the same terminal state both times, (b)
 * side effects (event emissions) fire exactly once despite two runs, and
 * (c) each run logs its summary line — closing the exact three gaps
 * (A5/A7/J2) named in qa-report.md, including the previously-missing A7
 * idempotency proof.
 *
 * Requires a reachable Postgres instance — see the environment note at the
 * bottom of this file. Run via: `npm run test:e2e -- cron-idempotency`
 */
describe('Scheduler crons — A5/A7/J2 real triggered-twice idempotency (e2e)', () => {
  let app: INestApplication<App>;
  let userRepo: Repository<User>;
  let profileRepo: Repository<ArtisanProfile>;
  let serviceRepo: Repository<ServiceEntity>;
  let bookingRepo: Repository<Booking>;
  let jobRepo: Repository<Job>;
  let bookingsScheduler: BookingsSchedulerService;
  let jobsScheduler: JobsSchedulerService;
  let eventEmitter: EventEmitter2;
  let logSpy: jest.SpyInstance;

  let artisanUser: User;
  let customer: User;
  let artisanProfileId: number;
  let serviceId: number;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();

    userRepo = moduleFixture.get(getRepositoryToken(User));
    profileRepo = moduleFixture.get(getRepositoryToken(ArtisanProfile));
    serviceRepo = moduleFixture.get(getRepositoryToken(ServiceEntity));
    bookingRepo = moduleFixture.get(getRepositoryToken(Booking));
    jobRepo = moduleFixture.get(getRepositoryToken(Job));
    bookingsScheduler = moduleFixture.get(BookingsSchedulerService);
    jobsScheduler = moduleFixture.get(JobsSchedulerService);
    eventEmitter = moduleFixture.get(EventEmitter2);

    artisanUser = await userRepo.save(
      userRepo.create({
        email: `cron-artisan-${Date.now()}@test.jinva.local`,
        password: null,
        firstname: 'Cron',
        lastname: 'Artisan',
        role: Role.ARTISAN,
        accountVerified: true,
        isBanned: false,
      }),
    );
    const profile = await profileRepo.save(
      profileRepo.create({
        user: artisanUser,
        currency: 'GHS',
        isVerified: true,
        isProfileComplete: true,
      }),
    );
    artisanProfileId = profile.id;

    customer = await userRepo.save(
      userRepo.create({
        email: `cron-customer-${Date.now()}@test.jinva.local`,
        password: null,
        firstname: 'Cron',
        lastname: 'Customer',
        role: Role.CUSTOMER,
        accountVerified: true,
        isBanned: false,
      }),
    );

    const service = await serviceRepo.save(
      serviceRepo.create({
        name: `Cron Idempotency Test Service ${Date.now()}`,
        estimatedDurationMins: 60,
      }),
    );
    serviceId = service.id;
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    logSpy = jest.spyOn(Logger.prototype, 'log');
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it('A5: expirePendingBookings() converges the same PENDING booking to EXPIRED exactly once across two runs, logging a summary both times', async () => {
    const staleCreatedAt = new Date(
      Date.now() - (VARIABLES.BOOKING_EXPIRY_HOURS + 1) * 60 * 60 * 1000,
    );
    const booking = await bookingRepo.save(
      bookingRepo.create({
        customer,
        customerId: customer.id,
        artisanProfile: { id: artisanProfileId } as ArtisanProfile,
        artisanProfileId,
        service: { id: serviceId } as ServiceEntity,
        serviceId,
        scheduledDate: '2099-01-01',
        startTime: '09:00',
        endTime: '10:00',
        status: BookingStatus.PENDING,
        currency: 'GHS',
      }),
    );
    // createdAt has a CreateDateColumn default; backdate it directly so this
    // row is a genuine expiry candidate without waiting 24h in real time.
    await bookingRepo
      .createQueryBuilder()
      .update(Booking)
      .set({ createdAt: staleCreatedAt })
      .where('id = :id', { id: booking.id })
      .execute();

    const emitSpy = jest.spyOn(eventEmitter, 'emit');

    await bookingsScheduler.expirePendingBookings();
    const afterFirst = await bookingRepo.findOne({
      where: { id: booking.id },
    });
    expect(afterFirst?.status).toBe(BookingStatus.EXPIRED);

    await bookingsScheduler.expirePendingBookings();
    const afterSecond = await bookingRepo.findOne({
      where: { id: booking.id },
    });
    expect(afterSecond?.status).toBe(BookingStatus.EXPIRED); // same end state

    // Filter to this test's own booking: a shared dev DB may already hold
    // other genuinely-stale PENDING bookings (leftover seed/previous-run
    // data) that this same cron run legitimately expires too — that's
    // correct real-world behavior, not a false positive to suppress.
    const expiredEmits = emitSpy.mock.calls.filter(
      ([event, payload]) =>
        event === APP_EVENTS.BOOKING_EXPIRED &&
        (payload as { bookingId?: number })?.bookingId === booking.id,
    );
    expect(expiredEmits).toHaveLength(1); // not re-notified on the second run

    const summaryLogs = logSpy.mock.calls.filter(([msg]) =>
      String(msg).startsWith('expirePendingBookings run summary:'),
    );
    expect(summaryLogs.length).toBeGreaterThanOrEqual(2); // one per run
  });

  it('A7: sendAppointmentReminders() sends the 2H reminder for the same booking exactly once across two runs, logging a summary both times', async () => {
    const now = Date.now();
    const appointmentInstant = new Date(
      now + VARIABLES.REMINDER_2H_HOURS * 60 * 60 * 1000 - 60 * 1000, // just inside the 2h band
    );
    const scheduledDate = appointmentInstant.toISOString().slice(0, 10);
    const startTime = appointmentInstant.toISOString().slice(11, 16);
    // chk_bookings_times requires start_time < end_time — give the
    // appointment a real (30-minute) duration rather than a zero-length slot.
    const endInstant = new Date(appointmentInstant.getTime() + 30 * 60 * 1000);
    const endTime = endInstant.toISOString().slice(11, 16);

    const booking = await bookingRepo.save(
      bookingRepo.create({
        customer,
        customerId: customer.id,
        artisanProfile: { id: artisanProfileId } as ArtisanProfile,
        artisanProfileId,
        service: { id: serviceId } as ServiceEntity,
        serviceId,
        scheduledDate,
        startTime,
        endTime,
        status: BookingStatus.CONFIRMED,
        currency: 'GHS',
      }),
    );

    const emitSpy = jest.spyOn(eventEmitter, 'emit');

    await bookingsScheduler.sendAppointmentReminders();
    const afterFirst = await bookingRepo.findOne({
      where: { id: booking.id },
    });
    expect(afterFirst?.reminder2hSentAt).not.toBeNull();

    await bookingsScheduler.sendAppointmentReminders();
    const afterSecond = await bookingRepo.findOne({
      where: { id: booking.id },
    });
    // Same end state: the flag doesn't get re-stamped/re-sent.
    expect(afterSecond?.reminder2hSentAt?.getTime()).toBe(
      afterFirst?.reminder2hSentAt?.getTime(),
    );

    const reminderEmits = emitSpy.mock.calls.filter(
      ([event]) => event === APP_EVENTS.BOOKING_REMINDER_2H,
    );
    // One emit per recipient (customer + artisan) on the first run only.
    expect(reminderEmits).toHaveLength(2);

    const summaryLogs = logSpy.mock.calls.filter(([msg]) =>
      String(msg).startsWith('sendAppointmentReminders(2H) run summary:'),
    );
    expect(summaryLogs.length).toBeGreaterThanOrEqual(2);
  });

  it('J2: autoCompleteOverdueJobs() completes the same IN_PROGRESS job exactly once across two runs, logging a summary both times', async () => {
    const staleRequestedAt = new Date(
      Date.now() - (VARIABLES.JOB_AUTO_COMPLETE_HOURS + 1) * 60 * 60 * 1000,
    );
    // CHK_jobs_completion_requested_at requires completion_requested_at IS
    // NULL OR >= created_at, enforced on INSERT too — so we can't insert
    // with a backdated completionRequestedAt while createdAt defaults to
    // now(). Insert without it, backdate createdAt first, then set
    // completionRequestedAt in a separate update — each write leaves the
    // constraint satisfied.
    const job = await jobRepo.save(
      jobRepo.create({
        customer,
        service: { id: serviceId } as ServiceEntity,
        title: 'Cron idempotency test job',
        location: 'Accra, Ghana',
        currency: 'GHS',
        status: Status.IN_PROGRESS,
        acceptedArtisan: artisanUser,
      } as Partial<Job>),
    );
    await jobRepo
      .createQueryBuilder()
      .update(Job)
      .set({
        createdAt: new Date(staleRequestedAt.getTime() - 60 * 60 * 1000),
      })
      .where('id = :id', { id: job.id })
      .execute();
    await jobRepo
      .createQueryBuilder()
      .update(Job)
      .set({ completionRequestedAt: staleRequestedAt })
      .where('id = :id', { id: job.id })
      .execute();

    const emitSpy = jest.spyOn(eventEmitter, 'emit');

    await jobsScheduler.autoCompleteOverdueJobs();
    const afterFirst = await jobRepo.findOne({ where: { id: job.id } });
    expect(afterFirst?.status).toBe(Status.COMPLETED);

    await jobsScheduler.autoCompleteOverdueJobs();
    const afterSecond = await jobRepo.findOne({ where: { id: job.id } });
    expect(afterSecond?.status).toBe(Status.COMPLETED); // same end state

    const completedEmits = emitSpy.mock.calls.filter(
      ([event]) => event === APP_EVENTS.JOB_COMPLETED,
    );
    expect(completedEmits).toHaveLength(1);

    const summaryLogs = logSpy.mock.calls.filter(([msg]) =>
      String(msg).startsWith('autoCompleteOverdueJobs run summary:'),
    );
    expect(summaryLogs.length).toBeGreaterThanOrEqual(2);
  });
});

/**
 * Environment note (do not remove until re-verified with a live DB):
 * authored/last attempted 2026-08-20 in a sandbox with no reachable Postgres
 * (`localhost:5432` closed, Docker daemon not running — confirmed via
 * `Test-NetConnection` before writing this file). These tests could not be
 * executed in that pass; they are ready to run as-is the moment a live DB is
 * reachable (`npm run test:e2e`). Do not treat "these files exist" as
 * equivalent to "A5/A7/J2 have been proven idempotent by execution" until
 * they have actually run green.
 */

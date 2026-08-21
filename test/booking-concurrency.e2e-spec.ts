import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { User } from '@users/entities/user.entity';
import { ArtisanProfile } from '@users/entities/artisan-profile.entity';
import { ServiceEntity } from '@services/entities/service.entity';
import { ArtisanAvailability } from '../src/availability/entities/artisan-availability.entity';
import { Booking } from '../src/bookings/entities/booking.entity';
import { UserTokenService } from '@users/token.service';
import { Role, BookingStatus } from '@common/types/enums';

/**
 * A4 / NFR (a): a REAL concurrent-request demonstration — two genuine
 * `POST /bookings` HTTP requests, fired via `Promise.all` against a running
 * Nest application backed by a real Postgres connection (not a unit test
 * mocking the DB layer), for the exact same artisan/date/time slot.
 *
 * This is the live-execution proof the Definition of Done names verbatim.
 * It requires a reachable Postgres instance to run — see the note at the
 * bottom of this file for the environment this was authored/last attempted
 * in, and the exact command to run it once a DB is available:
 *
 *   npm run test:e2e -- booking-concurrency
 */
describe('Bookings — A4 real concurrent-request race (e2e)', () => {
  let app: INestApplication<App>;
  let userRepo: Repository<User>;
  let profileRepo: Repository<ArtisanProfile>;
  let serviceRepo: Repository<ServiceEntity>;
  let slotRepo: Repository<ArtisanAvailability>;
  let bookingRepo: Repository<Booking>;
  let tokenService: UserTokenService;

  let artisanProfileId: number;
  let serviceId: number;
  let customerAToken: string;
  let customerBToken: string;
  let testDate: string;

  // A fixed future Monday so the weekly availability slot below reliably
  // applies regardless of what day this suite actually runs on.
  function nextMonday(): string {
    const d = new Date();
    const day = d.getUTCDay();
    const daysUntilMonday = ((1 - day + 7) % 7) + 7; // always >= 7 days out
    d.setUTCDate(d.getUTCDate() + daysUntilMonday);
    return d.toISOString().slice(0, 10);
  }

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.setGlobalPrefix('api/v1', { exclude: ['/'] });
    await app.init();

    userRepo = moduleFixture.get(getRepositoryToken(User));
    profileRepo = moduleFixture.get(getRepositoryToken(ArtisanProfile));
    serviceRepo = moduleFixture.get(getRepositoryToken(ServiceEntity));
    slotRepo = moduleFixture.get(getRepositoryToken(ArtisanAvailability));
    bookingRepo = moduleFixture.get(getRepositoryToken(Booking));
    tokenService = moduleFixture.get(UserTokenService);

    // ─── Seed: one artisan with weekly hours covering the test slot ─────────
    const artisanUser = await userRepo.save(
      userRepo.create({
        email: `a4-artisan-${Date.now()}@test.jinva.local`,
        password: null,
        firstname: 'A4',
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

    const service = await serviceRepo.save(
      serviceRepo.create({
        name: `A4 Concurrency Test Service ${Date.now()}`,
        estimatedDurationMins: 60,
      }),
    );
    serviceId = service.id;

    testDate = nextMonday();
    await slotRepo.save(
      slotRepo.create({
        artisanProfileId,
        dayOfWeek: 1, // Monday
        startTime: '08:00',
        endTime: '18:00',
        isActive: true,
      }),
    );

    // Two distinct customers so this test isolates the A4 overlap race from
    // the A9 per-customer-pending-cap check (which uses the same lock scope
    // but is a different, already-covered guard).
    const customerA = await userRepo.save(
      userRepo.create({
        email: `a4-customer-a-${Date.now()}@test.jinva.local`,
        password: null,
        firstname: 'Customer',
        lastname: 'A',
        role: Role.CUSTOMER,
        accountVerified: true,
        isBanned: false,
      }),
    );
    const customerB = await userRepo.save(
      userRepo.create({
        email: `a4-customer-b-${Date.now()}@test.jinva.local`,
        password: null,
        firstname: 'Customer',
        lastname: 'B',
        role: Role.CUSTOMER,
        accountVerified: true,
        isBanned: false,
      }),
    );

    customerAToken = (await tokenService.createJWTTokens(customerA))
      .access_token;
    customerBToken = (await tokenService.createJWTTokens(customerB))
      .access_token;
  });

  afterAll(async () => {
    await app.close();
  });

  it('never lets two concurrent requests for the same artisan/date/time both succeed', async () => {
    const payload = {
      artisanProfileId,
      serviceId,
      scheduledDate: testDate,
      startTime: '10:00',
      endTime: '11:00',
    };

    const server = app.getHttpServer();
    const [resA, resB] = await Promise.all([
      request(server)
        .post('/api/v1/bookings')
        .set('Authorization', `Bearer ${customerAToken}`)
        .send(payload),
      request(server)
        .post('/api/v1/bookings')
        .set('Authorization', `Bearer ${customerBToken}`)
        .send(payload),
    ]);

    const statuses = [resA.status, resB.status].sort();
    // Exactly one 201 (created — POST /bookings has no @HttpCode override,
    // so it correctly uses NestJS's default 201 for a resource create) and
    // one 409 (conflict) — never two successes.
    expect(statuses).toEqual([201, 409]);

    const rows = await bookingRepo.find({
      where: {
        // artisanProfileId is a @RelationId (virtual, not a real column) —
        // filter via the relation object instead.
        artisanProfile: { id: artisanProfileId },
        scheduledDate: testDate,
        startTime: '10:00',
        status: BookingStatus.PENDING,
      },
    });
    expect(rows).toHaveLength(1);
  });
});

/**
 * Environment note (do not remove until re-verified with a live DB):
 * authored/last attempted 2026-08-20 in a sandbox with no reachable Postgres
 * (`localhost:5432` closed, Docker daemon not running — confirmed via
 * `Test-NetConnection` before writing this file). This test could not be
 * executed in that pass; it is ready to run as-is the moment a live DB is
 * reachable (`npm run test:e2e`). Do not treat "this file exists" as
 * equivalent to "A4 has been proven by execution" until it has actually run
 * green.
 */

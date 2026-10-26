/**
 * QA fix group 8, over real HTTP and the real database:
 *   - BK-08: only a service the artisan offers can be booked;
 *   - BK-10 / ADM-06 / SRCH-15: hidden, busy or unavailable artisans can't be
 *     booked or opened by direct link;
 *   - a start exactly on a window's opening (06:00) is accepted;
 *   - BK-24: a future appointment can't be flagged as a no-show;
 *   - BK-23: completing a booking completes its job, and only once the
 *     artisan has finished a paid one.
 * Everything this suite creates is removed afterwards.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { WINSTON_MODULE_NEST_PROVIDER } from 'nest-winston';
import { DataSource, Repository } from 'typeorm';
import request from 'supertest';
import { App } from 'supertest/types';
import cookieParser from 'cookie-parser';
import type { Logger as WinstonLogger } from 'winston';
import { AppModule } from '../src/app.module';
import { ResponseInterceptor } from '../src/common/interceptors/response.interceptor';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';
import { TypeOrmFilter } from '../src/common/filters/typeorm-exception.filter';
import { User } from '@users/entities/user.entity';
import { ArtisanProfile } from '@users/entities/artisan-profile.entity';
import { UserTokenService } from '@users/token.service';
import { ServiceEntity } from '@services/entities/service.entity';
import { ArtisanAvailability } from '../src/availability/entities/artisan-availability.entity';
import { Payment } from '../src/payments/entities/payment.entity';
import { PaymentStatus, Role } from '@common/types/enums';
import { removeTestData, testUserIds } from './helpers/test-data';

jest.setTimeout(120000);

/** A Monday `weeks` weeks out (at least one), so the weekly slots apply. */
function monday(weeks = 1): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + ((1 - d.getUTCDay() + 7) % 7) + 7 * weeks);
  return d.toISOString().slice(0, 10);
}

describe('Booking rules (fix group 8)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let users: Repository<User>;
  let profiles: Repository<ArtisanProfile>;
  let payments: Repository<Payment>;
  const serviceIds: number[] = [];
  const profileOf: Record<string, number> = {};
  const userOf: Record<string, User> = {};
  const uniq = Date.now();
  const token: Record<string, string> = {};
  const server = () => app.getHttpServer();
  const as = (who: string) => ({ Authorization: `Bearer ${token[who]}` });

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    app.use(cookieParser());
    const logger = app.get<WinstonLogger>(WINSTON_MODULE_NEST_PROVIDER);
    app.useGlobalFilters(new AllExceptionsFilter(logger), new TypeOrmFilter());
    app.useGlobalInterceptors(new ResponseInterceptor());
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.setGlobalPrefix('api/v1', { exclude: ['/'] });
    await app.init();
    dataSource = moduleFixture.get(DataSource);
    users = moduleFixture.get(getRepositoryToken(User));
    profiles = moduleFixture.get(getRepositoryToken(ArtisanProfile));
    payments = moduleFixture.get(getRepositoryToken(Payment));
    const slots: Repository<ArtisanAvailability> = moduleFixture.get(
      getRepositoryToken(ArtisanAvailability),
    );
    const services: Repository<ServiceEntity> = moduleFixture.get(
      getRepositoryToken(ServiceEntity),
    );
    const [electrical, tiling] = await Promise.all(
      ['Electrical', 'Tiling'].map((name) =>
        services.save(
          services.create({
            name: `Rules ${name} ${uniq}`,
            estimatedDurationMins: 60,
          }),
        ),
      ),
    );
    serviceIds.push(electrical.id, tiling.id);
    const tokens = moduleFixture.get(UserTokenService);

    const make = async (label: string, role: Role) => {
      const u = await users.save(
        users.create({
          email: `br-${label}-${uniq}@test.jinva.local`,
          username: `br${label}${uniq}`,
          firstname: 'Kojo',
          lastname: 'Mensah',
          role,
          accountVerified: true,
        }),
      );
      userOf[label] = u;
      if (role === Role.ARTISAN) {
        const p = await profiles.save(
          profiles.create({
            user: u,
            hourlyRate: 70,
            location: 'Kasoa, Central Region',
            currency: 'GHS',
            isProfileComplete: true,
            services: [electrical],
          }),
        );
        profileOf[label] = p.id;
        await slots.save(
          slots.create({
            artisanProfileId: p.id,
            dayOfWeek: 1,
            startTime: '06:00',
            endTime: '18:00',
            isActive: true,
          }),
        );
      }
      token[label] = (await tokens.createJWTTokens(u)).access_token;
    };
    await make('customer', Role.CUSTOMER);
    await make('artisan', Role.ARTISAN);
    await make('hidden', Role.ARTISAN);
  });

  afterAll(async () => {
    await removeTestData(dataSource, {
      userIds: await testUserIds(dataSource, 'br-'),
      serviceIds,
    });
    await app.close();
  });

  const book = (body: Record<string, unknown>, who = 'artisan') =>
    request(server())
      .post('/api/v1/bookings')
      .set(as('customer'))
      .send({
        artisanProfileId: profileOf[who],
        serviceId: serviceIds[0],
        scheduledDate: monday(),
        startTime: '10:00',
        ...body,
      });

  it("refuses a service the artisan doesn't offer (BK-08)", async () => {
    const res = await book({ serviceId: serviceIds[1] });
    expect(res.status).toBe(400);
    expect((res.body as { message: string }).message).toMatch(
      /doesn't offer that service/,
    );
  });

  describe('hidden and unavailable artisans (BK-10, ADM-06, SRCH-15)', () => {
    const setHidden = (patch: Partial<User>, profilePatch = {}) =>
      Promise.all([
        users.update({ id: userOf.hidden.id }, patch),
        profiles.update({ id: profileOf.hidden }, profilePatch),
      ]);
    const reset = () =>
      setHidden(
        { isSuspended: false },
        { isProfileComplete: true, availabilityStatus: 'AVAILABLE' },
      );
    afterEach(reset);

    it.each([
      ['suspended', { isSuspended: true }, {}],
      ['incomplete', {}, { isProfileComplete: false }],
    ])(
      'hides a %s artisan by direct link and refuses to book them',
      async (_label, userPatch, profilePatch) => {
        await setHidden(userPatch, profilePatch);
        const profile = await request(server())
          .get(`/api/v1/artisans/${profileOf.hidden}`)
          .set(as('customer'));
        expect(profile.status).toBe(404);
        const own = await request(server())
          .get(`/api/v1/artisans/${profileOf.hidden}`)
          .set(as('hidden'));
        expect(own.status).toBe(200);
        expect((await book({}, 'hidden')).status).toBe(400);
      },
    );

    it.each([['BUSY'], ['UNAVAILABLE']])(
      'refuses to book a %s artisan',
      async (status) => {
        await setHidden({}, { availabilityStatus: status });
        expect((await book({}, 'hidden')).status).toBe(400);
      },
    );
  });

  it('accepts a start exactly when the working day opens (06:00)', async () => {
    const res = await book({ startTime: '06:00', scheduledDate: monday(2) });
    expect(res.status).toBe(201);
    const id = (res.body as { data: { id: number } }).data.id;
    await request(server())
      .delete(`/api/v1/bookings/${id}`)
      .set(as('customer'));
  });

  describe('a confirmed, paid booking', () => {
    let bookingId = 0;
    let jobId = 0;

    beforeAll(async () => {
      const booked = await book({ scheduledDate: monday(3) });
      bookingId = (booked.body as { data: { id: number } }).data.id;
      const confirmed = await request(server())
        .patch(`/api/v1/bookings/${bookingId}/confirm`)
        .set(as('artisan'))
        .send({ price: 220 });
      jobId = (confirmed.body as { data: { jobId: number } }).data.jobId;
    });

    it("can't be flagged as a no-show before it has happened (BK-24)", async () => {
      const res = await request(server())
        .patch(`/api/v1/bookings/${bookingId}/no-show`)
        .set(as('customer'));
      expect(res.status).toBe(400);
      expect((res.body as { message: string }).message).toMatch(
        /has not ended yet/,
      );
    });

    it('completes together with its job once the artisan has finished (BK-23)', async () => {
      const complete = () =>
        request(server())
          .patch(`/api/v1/bookings/${bookingId}/complete`)
          .set(as('customer'));
      const early = await complete();
      expect(early.status).toBe(400);
      expect((early.body as { message: string }).message).toMatch(
        /needs to start the job/,
      );

      await payments.update({ jobId }, { status: PaymentStatus.HELD });
      for (const step of ['start', 'request-completion']) {
        const res = await request(server())
          .patch(`/api/v1/jobs/${jobId}/${step}`)
          .set(as('artisan'));
        expect(res.status).toBe(200);
      }

      expect((await complete()).status).toBe(200);
      const [row]: Array<{ booking: string; job: string }> =
        await dataSource.query(
          `SELECT b.status AS booking, j.status AS job
             FROM bookings b JOIN jobs j ON j.booking_id = b.id
            WHERE b.id = $1`,
          [bookingId],
        );
      expect(row).toEqual({ booking: 'COMPLETED', job: 'COMPLETED' });
    });
  });

  it('cancelling the job of a confirmed booking cancels the booking too', async () => {
    const booked = await book({ scheduledDate: monday(4) });
    const bookingId = (booked.body as { data: { id: number } }).data.id;
    const confirmed = await request(server())
      .patch(`/api/v1/bookings/${bookingId}/confirm`)
      .set(as('artisan'))
      .send({ price: 150 });
    const jobId = (confirmed.body as { data: { jobId: number } }).data.jobId;

    const cancel = await request(server())
      .patch(`/api/v1/jobs/${jobId}/cancel`)
      .set(as('customer'));
    expect(cancel.status).toBe(200);
    const [row]: Array<{ status: string }> = await dataSource.query(
      'SELECT status FROM bookings WHERE id = $1',
      [bookingId],
    );
    expect(row.status).toBe('CANCELLED');
  });
});

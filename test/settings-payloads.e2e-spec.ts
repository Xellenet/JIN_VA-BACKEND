/**
 * QA fix group 7 and JOB-22, over real HTTP and the real database:
 *   - CUS-02/03/07: account details, address and a set-once national ID save;
 *   - AV-01/02/04: weekly hours, real clock times, blocked dates;
 *   - ADM-11: a service price can be set and cleared;
 *   - JOB-22: confirming a booking creates the payment, so work waits for it.
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
import { Payment } from '../src/payments/entities/payment.entity';
import { PaymentStatus, Role } from '@common/types/enums';
import { removeTestData, testUserIds } from './helpers/test-data';

jest.setTimeout(120000);

/** A Monday at least a week out, so the weekly slot below always applies. */
function nextMonday(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + ((1 - d.getUTCDay() + 7) % 7) + 7);
  return d.toISOString().slice(0, 10);
}

describe('Settings payloads and booking payment (fix 7, JOB-22)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let payments: Repository<Payment>;
  const serviceIds: number[] = [];
  let artisanProfileId = 0;
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
    payments = moduleFixture.get(getRepositoryToken(Payment));

    const services: Repository<ServiceEntity> = moduleFixture.get(
      getRepositoryToken(ServiceEntity),
    );
    const service = await services.save(
      services.create({
        name: `Settings Plumbing ${uniq}`,
        estimatedDurationMins: 60,
      }),
    );
    serviceIds.push(service.id);

    const users: Repository<User> = moduleFixture.get(getRepositoryToken(User));
    const profiles: Repository<ArtisanProfile> = moduleFixture.get(
      getRepositoryToken(ArtisanProfile),
    );
    const tokens = moduleFixture.get(UserTokenService);
    const make = async (label: string, role: Role) => {
      const u = await users.save(
        users.create({
          email: `sp-${label}-${uniq}@test.jinva.local`,
          username: `sp${label}${uniq}`,
          firstname: 'Efia',
          lastname: 'Owusu',
          role,
          accountVerified: true,
        }),
      );
      if (role === Role.ARTISAN) {
        artisanProfileId = (
          await profiles.save(
            profiles.create({
              user: u,
              hourlyRate: 90,
              location: 'Tema, Greater Accra',
              currency: 'GHS',
              isProfileComplete: true,
              services: [service],
            }),
          )
        ).id;
      }
      token[label] = (await tokens.createJWTTokens(u)).access_token;
    };
    await make('customer', Role.CUSTOMER);
    await make('other', Role.CUSTOMER);
    await make('artisan', Role.ARTISAN);
    await make('admin', Role.ADMIN);
  });

  afterAll(async () => {
    await removeTestData(dataSource, {
      userIds: await testUserIds(dataSource, 'sp-'),
      serviceIds,
    });
    await app.close();
  });

  describe('customer settings (CUS-02, CUS-03, CUS-07)', () => {
    const me = (who = 'customer') =>
      request(server()).get('/api/v1/users/me').set(as(who));
    const patchMe = (body: object, who = 'customer') =>
      request(server()).patch('/api/v1/users/me').set(as(who)).send(body);

    it('saves account details without an address in the body', async () => {
      const res = await patchMe({ firstname: 'Mary Ann', lastname: 'Smith' });
      expect(res.status).toBe(200);
      const data = ((await me()).body as { data: unknown }).data as {
        firstname: string;
      };
      expect(data.firstname).toBe('Mary Ann');
    });

    it('saves an address with only the fields the form shows', async () => {
      const res = await request(server())
        .post('/api/v1/users/me/addresses')
        .set(as('customer'))
        .send({
          street: '4 Oxford Street',
          city: 'Accra',
          country: 'Ghana',
          zipCode: 'GA-183',
        });
      expect(res.status).toBe(201);
    });

    it('sets a national ID once, shows it masked, and refuses changes', async () => {
      expect((await patchMe({ nationalId: 'gha-712345678-3' })).status).toBe(
        200,
      );
      const data = ((await me()).body as { data: unknown }).data as {
        nationalId?: string;
      };
      expect(data.nationalId).toBe('•••••••••••78-3');

      expect((await patchMe({ nationalId: 'GHA-712345678-3' })).status).toBe(
        200,
      );
      expect((await patchMe({ nationalId: 'GHA-700000000-1' })).status).toBe(
        400,
      );
      const [row]: Array<{ national_id: string }> = await dataSource.query(
        `SELECT national_id FROM users WHERE email = $1`,
        [`sp-customer-${uniq}@test.jinva.local`],
      );
      expect(row.national_id).toBe('GHA-712345678-3');
    });

    it("won't link one national ID to two accounts", async () => {
      const res = await patchMe({ nationalId: 'GHA-712345678-3' }, 'other');
      expect(res.status).toBe(409);
    });

    it('rejects a malformed national ID', async () => {
      expect(
        (await patchMe({ nationalId: 'no spaces!' }, 'other')).status,
      ).toBe(400);
    });
  });

  describe('artisan calendar (AV-01, AV-02, AV-04)', () => {
    const slot = (body: object) =>
      request(server())
        .post('/api/v1/availability/my/slots')
        .set(as('artisan'))
        .send(body);

    it('adds weekly hours, and refuses times that are not on a clock', async () => {
      expect(
        (await slot({ dayOfWeek: 1, startTime: '08:00', endTime: '18:00' }))
          .status,
      ).toBe(201);
      expect(
        (await slot({ dayOfWeek: 2, startTime: '25:99', endTime: '26:00' }))
          .status,
      ).toBe(400);
      expect(
        (await slot({ dayOfWeek: 2, startTime: '09:00', endTime: '23:60' }))
          .status,
      ).toBe(400);
    });

    it('blocks dates with a 201, not a 500', async () => {
      const res = await request(server())
        .post('/api/v1/availability/my/blocks')
        .set(as('artisan'))
        .send({
          startDate: '2027-01-04',
          endDate: '2027-01-06',
          reason: 'Family visit in Kumasi',
        });
      expect(res.status).toBe(201);
    });
  });

  describe('service price (ADM-11)', () => {
    it('creates, edits and clears a price', async () => {
      const created = await request(server())
        .post('/api/v1/services')
        .set(as('admin'))
        .send({ name: `Settings Roofing ${uniq}`, price: 150 });
      expect(created.status).toBe(201);
      const id = (created.body as { data: { id: number } }).data.id;
      serviceIds.push(id);

      const patch = (price: number | null) =>
        request(server())
          .patch(`/api/v1/services/${id}`)
          .set(as('admin'))
          .send({ price });
      expect((await patch(175.5)).status).toBe(200);
      expect((await patch(0)).status).toBe(400);
      expect((await patch(null)).status).toBe(200);
      const [row]: Array<{ price: string | null }> = await dataSource.query(
        'SELECT price FROM services WHERE id = $1',
        [id],
      );
      expect(row.price).toBeNull();
    });
  });

  describe('booking payment (JOB-22)', () => {
    let bookingId = 0;

    it('needs a price to confirm, then creates the payment and holds the start', async () => {
      const booked = await request(server())
        .post('/api/v1/bookings')
        .set(as('customer'))
        .send({
          artisanProfileId,
          serviceId: serviceIds[0],
          scheduledDate: nextMonday(),
          startTime: '10:00',
          notes: 'Kitchen tap drips constantly',
        });
      expect(booked.status).toBe(201);
      bookingId = (booked.body as { data: { id: number } }).data.id;

      const confirm = (body: object) =>
        request(server())
          .patch(`/api/v1/bookings/${bookingId}/confirm`)
          .set(as('artisan'))
          .send(body);
      const noPrice = await confirm({});
      expect(noPrice.status).toBe(400);
      expect((noPrice.body as { message: string }).message).toMatch(
        /Set your price/,
      );
      expect((await confirm({ price: 0 })).status).toBe(400);

      const ok = await confirm({ price: 180 });
      expect(ok.status).toBe(200);
      const jobId = (ok.body as { data: { jobId: number } }).data.jobId;
      const payment = await payments.findOneByOrFail({ jobId });
      expect(Number(payment.amount)).toBe(180);
      expect(payment.status).toBe(PaymentStatus.PENDING);

      const start = await request(server())
        .patch(`/api/v1/jobs/${jobId}/start`)
        .set(as('artisan'));
      expect(start.status).toBe(400);
    });

    it('voids the payment when the customer cancels the booking', async () => {
      const res = await request(server())
        .delete(`/api/v1/bookings/${bookingId}`)
        .set(as('customer'));
      expect(res.status).toBe(200);
      const [row]: Array<{ status: string }> = await dataSource.query(
        `SELECT p.status FROM payments p JOIN jobs j ON j.id = p.job_id WHERE j.booking_id = $1`,
        [bookingId],
      );
      expect(row.status).toBe(PaymentStatus.CANCELLED);
    });
  });
});

/**
 * Exact location (Uber-style pin) and its privacy (Act 843), over real HTTP
 * and the real database:
 *   - POST /jobs and POST /bookings take latitude, longitude,
 *     locationAccuracyM and landmark; a pin outside Ghana, or half a pin, is a
 *     400; clients that send no pin keep working;
 *   - the pin and landmark reach only the job's customer, its hired artisan
 *     and admins. Another artisan browsing the job board or searching, an
 *     applicant who was not hired, and an anonymous caller get the area label
 *     (`location`) at most, never the coordinates or landmark;
 *   - a booking's artisan gets them only once the booking is confirmed, and
 *     the job made on confirmation carries them.
 * Fictional pin only (Adum, Kumasi). Everything this suite creates is removed
 * afterwards.
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
import { Role } from '@common/types/enums';
import { removeTestData, testUserIds } from './helpers/test-data';

jest.setTimeout(120000);

const ADUM = { latitude: 6.6885, longitude: -1.6244 };
const LANDMARK = 'Opposite Adum Post Office, blue gate';
const PRIVATE = ['latitude', 'longitude', 'locationAccuracyM', 'landmark'];

/** A Monday `weeks` weeks out (at least one), so the weekly slot applies. */
function monday(weeks = 1): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + ((1 - d.getUTCDay() + 7) % 7) + 7 * weeks);
  return d.toISOString().slice(0, 10);
}

type Json = Record<string, unknown>;

/** No exact-location key anywhere in a response body, at any depth. */
function expectNoPin(body: unknown) {
  const text = JSON.stringify(body);
  for (const key of PRIVATE) expect(text).not.toContain(`"${key}"`);
  expect(text).not.toContain(LANDMARK);
  expect(text).not.toContain('6.6885');
}

describe('Exact location and its privacy', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let serviceId = 0;
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

    const services: Repository<ServiceEntity> = moduleFixture.get(
      getRepositoryToken(ServiceEntity),
    );
    const service = await services.save(
      services.create({
        name: `Exact Location ${uniq}`,
        estimatedDurationMins: 60,
      }),
    );
    serviceId = service.id;

    const users: Repository<User> = moduleFixture.get(getRepositoryToken(User));
    const profiles: Repository<ArtisanProfile> = moduleFixture.get(
      getRepositoryToken(ArtisanProfile),
    );
    const slots: Repository<ArtisanAvailability> = moduleFixture.get(
      getRepositoryToken(ArtisanAvailability),
    );
    const tokens = moduleFixture.get(UserTokenService);
    const make = async (label: string, role: Role) => {
      const u = await users.save(
        users.create({
          email: `exloc-${label}-${uniq}@test.jinva.local`,
          username: `exloc${label}${uniq}`,
          firstname: 'Kofi',
          lastname: 'Asante',
          role,
          accountVerified: true,
        }),
      );
      if (role === Role.ARTISAN) {
        const p = await profiles.save(
          profiles.create({
            user: u,
            hourlyRate: 80,
            location: 'Asafo, Kumasi',
            currency: 'GHS',
            isProfileComplete: true,
            services: [service],
          }),
        );
        if (label === 'hired') {
          artisanProfileId = p.id;
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
      }
      token[label] = (await tokens.createJWTTokens(u)).access_token;
    };
    await make('owner', Role.CUSTOMER);
    await make('otherCustomer', Role.CUSTOMER);
    await make('hired', Role.ARTISAN);
    await make('applicant', Role.ARTISAN);
    await make('browser', Role.ARTISAN);
    await make('admin', Role.ADMIN);
  });

  afterAll(async () => {
    await removeTestData(dataSource, {
      userIds: await testUserIds(dataSource, 'exloc-'),
      serviceIds: serviceId ? [serviceId] : [],
    });
    await app.close();
  });

  const jobBody = (extra: Json = {}) => ({
    title: `Kitchen tap ${uniq}`,
    description: 'The kitchen tap drips all night and needs a new washer.',
    serviceId,
    location: 'Adum, Kumasi',
    budgetMin: 100,
    budgetMax: 200,
    currency: 'GHS',
    ...extra,
  });
  const postJob = (extra: Json = {}) =>
    request(server())
      .post('/api/v1/jobs')
      .set(as('owner'))
      .send(jobBody(extra));
  const getJob = (who: string | null, id: number) => {
    const req = request(server()).get(`/api/v1/jobs/${id}`);
    return who ? req.set(as(who)) : req;
  };
  const listJobs = (who: string | null, query = 'limit=50') => {
    const req = request(server()).get(`/api/v1/jobs?${query}`);
    return who ? req.set(as(who)) : req;
  };
  const dataOf = (res: request.Response) => (res.body as { data: Json }).data;
  const listOf = (res: request.Response) => (res.body as { data: Json[] }).data;

  describe('writing a pin', () => {
    it.each([
      ['outside Ghana (Lomé)', { latitude: 6.13, longitude: 1.25 }],
      ['outside Ghana (London)', { latitude: 51.5, longitude: -0.12 }],
      ['only a latitude', { latitude: 6.6885 }],
      [
        'a landmark over 140 characters',
        { ...ADUM, landmark: 'x'.repeat(141) },
      ],
    ])('refuses a job with %s (400)', async (_label, extra) => {
      const res = await postJob(extra);
      expect(res.status).toBe(400);
    });

    it('says a pin outside Ghana must be in Ghana', async () => {
      const res = await postJob({ latitude: 6.13, longitude: 1.25 });
      expect(JSON.stringify(res.body)).toContain(
        'The pinned location must be in Ghana.',
      );
    });

    it('still takes a job without a pin (old clients)', async () => {
      const res = await postJob();
      expect(res.status).toBe(201);
      expect(dataOf(res)).toMatchObject({
        location: 'Adum, Kumasi',
        latitude: null,
        longitude: null,
        landmark: null,
      });
    });
  });

  describe('a pinned job', () => {
    let openId = 0;

    beforeAll(async () => {
      const res = await postJob({
        ...ADUM,
        locationAccuracyM: 8.4,
        landmark: `  ${LANDMARK} `,
      });
      expect(res.status).toBe(201);
      openId = dataOf(res).id as number;
      // The owner gets the pin back exactly as stored.
      expect(dataOf(res)).toMatchObject({
        ...ADUM,
        locationAccuracyM: 8,
        landmark: LANDMARK,
      });
    });

    it('is shown in full to the owner and to an admin', async () => {
      for (const who of ['owner', 'admin']) {
        const res = await getJob(who, openId);
        expect(res.status).toBe(200);
        expect(dataOf(res)).toMatchObject({ ...ADUM, landmark: LANDMARK });
      }
      const mine = await request(server())
        .get('/api/v1/jobs/mine?limit=50')
        .set(as('owner'));
      const row = listOf(mine).find((j) => j.id === openId);
      expect(row).toMatchObject({ ...ADUM, landmark: LANDMARK });
    });

    it('shows another artisan only the area, on the detail, the board and a search', async () => {
      const detail = await getJob('browser', openId);
      expect(detail.status).toBe(200);
      expect(dataOf(detail).location).toBe('Adum, Kumasi');
      expectNoPin(detail.body);

      const board = await listJobs('browser');
      expect(listOf(board).map((j) => j.id)).toContain(openId);
      expectNoPin(board.body);

      const search = await listJobs(
        'browser',
        `location=Adum&serviceId=${serviceId}&limit=50`,
      );
      expect(listOf(search).map((j) => j.id)).toContain(openId);
      expectNoPin(search.body);
    });

    it('gives an anonymous caller nothing', async () => {
      for (const res of [await getJob(null, openId), await listJobs(null)]) {
        expect(res.status).toBe(401);
        expectNoPin(res.body);
      }
    });

    it('reaches the hired artisan, and never the applicant who was not hired', async () => {
      for (const who of ['applicant', 'hired']) {
        const applied = await request(server())
          .post(`/api/v1/jobs/${openId}/apply`)
          .set(as(who))
          .send({ quotePrice: 150 });
        expect(applied.status).toBe(201);
        // Applying shows nothing more.
        expectNoPin((await getJob(who, openId)).body);
      }
      const apps = listOf(
        await request(server())
          .get(`/api/v1/jobs/${openId}/applications`)
          .set(as('owner')),
      ) as Array<{ id: number; artisan: { email?: string } }>;
      const hiredApp = apps.find((a) =>
        String(a.artisan.email).startsWith('exloc-hired-'),
      );
      expect(hiredApp).toBeDefined();
      const accepted = await request(server())
        .post(`/api/v1/jobs/${openId}/applications/${hiredApp!.id}/accept`)
        .set(as('owner'));
      expect(accepted.status).toBe(201);

      const hired = await getJob('hired', openId);
      expect(dataOf(hired)).toMatchObject({
        ...ADUM,
        locationAccuracyM: 8,
        landmark: LANDMARK,
      });
      const hiredList = listOf(await listJobs('hired'));
      expect(hiredList.find((j) => j.id === openId)).toMatchObject(ADUM);

      const rejected = await getJob('applicant', openId);
      expect(rejected.status).toBe(200);
      expect(dataOf(rejected).location).toBe('Adum, Kumasi');
      expectNoPin(rejected.body);
      expectNoPin((await listJobs('applicant')).body);
      // Once hired elsewhere the job leaves the board; a stranger can't open it.
      expect((await getJob('browser', openId)).status).toBe(404);
      expect((await getJob('otherCustomer', openId)).status).toBe(404);
    });
  });

  describe('a pinned booking', () => {
    let bookingId = 0;
    const book = (extra: Json, who = 'owner') =>
      request(server())
        .post('/api/v1/bookings')
        .set(as(who))
        .send({
          artisanProfileId,
          serviceId,
          scheduledDate: monday(),
          startTime: '10:00',
          ...extra,
        });

    it('refuses a pin outside Ghana (400)', async () => {
      const res = await book({
        location: 'Lomé',
        latitude: 6.13,
        longitude: 1.25,
      });
      expect(res.status).toBe(400);
    });

    it('still takes a booking without a place (old clients)', async () => {
      const res = await book({ startTime: '14:00' });
      expect(res.status).toBe(201);
      expect(dataOf(res)).toMatchObject({ location: null, latitude: null });
    });

    it('shows the pending request to the artisan with the area only', async () => {
      const res = await book({
        location: 'Adum, Kumasi',
        ...ADUM,
        locationAccuracyM: 12,
        landmark: LANDMARK,
      });
      expect(res.status).toBe(201);
      bookingId = dataOf(res).id as number;
      expect(dataOf(res)).toMatchObject({ ...ADUM, landmark: LANDMARK });

      const artisanView = await request(server())
        .get(`/api/v1/bookings/${bookingId}`)
        .set(as('hired'));
      expect(artisanView.status).toBe(200);
      expect(dataOf(artisanView).location).toBe('Adum, Kumasi');
      expectNoPin(artisanView.body);
      const artisanList = await request(server())
        .get('/api/v1/bookings/artisan?limit=100')
        .set(as('hired'));
      expectNoPin(artisanList.body);

      const customerList = await request(server())
        .get('/api/v1/bookings/my?limit=100')
        .set(as('owner'));
      const mine = listOf(customerList).find((b) => b.id === bookingId);
      expect(mine).toMatchObject({ ...ADUM, landmark: LANDMARK });
    });

    it('shares the pin with the artisan once confirmed, and on the job it makes', async () => {
      const confirmed = await request(server())
        .patch(`/api/v1/bookings/${bookingId}/confirm`)
        .set(as('hired'))
        .send({ price: 150 });
      expect(confirmed.status).toBe(200);
      const jobId = (confirmed.body as { data: { jobId: number } }).data.jobId;

      const booking = await request(server())
        .get(`/api/v1/bookings/${bookingId}`)
        .set(as('hired'));
      expect(dataOf(booking)).toMatchObject({
        ...ADUM,
        locationAccuracyM: 12,
        landmark: LANDMARK,
      });

      const job = await getJob('hired', jobId);
      expect(dataOf(job)).toMatchObject({
        location: 'Adum, Kumasi',
        ...ADUM,
        landmark: LANDMARK,
      });
      // Another artisan can't open the booking's job at all.
      expect((await getJob('browser', jobId)).status).toBe(404);
    });
  });
});

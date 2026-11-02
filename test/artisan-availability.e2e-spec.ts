/**
 * An artisan's Calendar settings (weekly hours, time off, status) drive what
 * clients see: the "now" / "this week" search filters, and the
 * `availability`, `weeklyHours` and `upcomingTimeOff` fields on search and
 * the public profile. The clock is fixed through AvailabilityService.now, so
 * the suite doesn't depend on the real date. Fictional people and data only.
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
import { AvailabilityService } from '../src/availability/availability.service';
import { User } from '@users/entities/user.entity';
import { ArtisanProfile } from '@users/entities/artisan-profile.entity';
import { UserTokenService } from '@users/token.service';
import { Role } from '@common/types/enums';
import { expectNoForbiddenFields } from './support/forbidden-fields';

jest.setTimeout(120000);

type Summary = {
  state: string;
  today: string;
  hasWorkingHours: boolean;
  onTimeOffUntil: string | null;
  todayHours: Array<{ startTime: string; endTime: string }>;
  nextAvailableDate: string | null;
  bookable: boolean;
};
type PublicArtisan = {
  id: number;
  businessName: string;
  availabilityStatus: string;
  availability?: Summary;
  weeklyHours?: Array<{
    dayOfWeek: number;
    startTime: string;
    endTime: string;
  }>;
  upcomingTimeOff?: Array<{ startDate: string; endDate: string }>;
};

// Monday 2 Nov 2026, 09:30 in Accra (UTC+0).
const dataOf = <T>(res: { body: unknown }): T => (res.body as { data: T }).data;

const MONDAY_0930 = new Date('2026-11-02T09:30:00.000Z');
const WEEKDAYS = [1, 2, 3, 4, 5];

describe('Artisan availability from Calendar settings', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let availability: AvailabilityService;
  let users: Repository<User>;
  let tokens: UserTokenService;
  const uniq = Date.now();
  const tag = `Avail${uniq}`;
  const profileId: Record<string, number> = {};
  const server = () => app.getHttpServer();

  const search = async (query: Record<string, string> = {}) => {
    const res = await request(server())
      .get('/api/v1/artisans')
      .query({ keyword: tag, limit: '50', ...query })
      .expect(200);
    return dataOf<PublicArtisan[]>(res);
  };
  const labelsOf = (rows: PublicArtisan[]) =>
    rows.map((r) => r.businessName.replace(`${tag} `, '')).sort();

  const hours = async (
    label: string,
    days: number[],
    start: string,
    end: string,
  ) => {
    for (const day of days) {
      await dataSource.query(
        `INSERT INTO artisan_availability (artisan_profile_id, day_of_week, start_time, end_time, is_active)
         VALUES ($1, $2, $3, $4, true)`,
        [profileId[label], day, start, end],
      );
    }
  };
  const timeOff = (label: string, startDate: string, endDate: string) =>
    dataSource.query(
      `INSERT INTO blocked_slots (artisan_profile_id, start_date, end_date, reason) VALUES ($1, $2, $3, $4)`,
      [profileId[label], startDate, endDate, 'Private family matter'],
    );

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
    availability = moduleFixture.get(AvailabilityService);
    jest.spyOn(availability, 'now').mockReturnValue(MONDAY_0930);

    users = moduleFixture.get(getRepositoryToken(User));
    tokens = moduleFixture.get(UserTokenService);
    const profiles: Repository<ArtisanProfile> = moduleFixture.get(
      getRepositoryToken(ArtisanProfile),
    );
    const make = async (label: string, status = 'AVAILABLE') => {
      const u = await users.save(
        users.create({
          email: `avail-${label.toLowerCase()}-${uniq}@test.jinva.local`,
          username: `avail${label}${uniq}`,
          firstname: 'Kojo',
          lastname: label,
          role: Role.ARTISAN,
          accountVerified: true,
        }),
      );
      profileId[label] = (
        await profiles.save(
          profiles.create({
            user: u,
            businessName: `${tag} ${label}`,
            hourlyRate: 60,
            location: 'Kumasi',
            currency: 'GHS',
            isProfileComplete: true,
            availabilityStatus: status,
          }),
        )
      ).id;
    };

    // Working now: Mon–Fri split shift.
    await make('Open');
    await hours('Open', WEEKDAYS, '08:00', '12:00');
    await hours('Open', WEEKDAYS, '13:00', '17:00');
    // Same hours, but on time off for the whole coming week and a bit.
    await make('Away');
    await hours('Away', WEEKDAYS, '08:00', '17:00');
    await timeOff('Away', '2026-11-01', '2026-11-06');
    await timeOff('Away', '2026-11-07', '2026-11-12');
    // Off today only.
    await make('Tomorrow');
    await hours('Tomorrow', WEEKDAYS, '08:00', '17:00');
    await timeOff('Tomorrow', '2026-11-02', '2026-11-02');
    // No hours at all.
    await make('NoHours');
    // Saturdays only.
    await make('Weekend');
    await hours('Weekend', [6], '09:00', '15:00');
    // Hours set, but marked busy / unavailable.
    await make('Busy', 'BUSY');
    await hours('Busy', WEEKDAYS, '08:00', '17:00');
    await make('Closed', 'UNAVAILABLE');
    await hours('Closed', WEEKDAYS, '08:00', '17:00');
    // Hours only in the evening, so not working at 09:30.
    await make('Evening');
    await hours('Evening', WEEKDAYS, '18:00', '22:00');
    // Paused (inactive) hours don't count.
    await make('Paused');
    await hours('Paused', WEEKDAYS, '08:00', '17:00');
    await dataSource.query(
      `UPDATE artisan_availability SET is_active = false WHERE artisan_profile_id = $1`,
      [profileId.Paused],
    );
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await app.close();
  });

  describe('search filters', () => {
    it('"now" keeps artisans working at this Accra time, not on time off, status AVAILABLE', async () => {
      expect(labelsOf(await search({ availabilityWindow: 'now' }))).toEqual([
        'Open',
      ]);
    });

    it('"now" follows the Accra clock to the minute', async () => {
      jest
        .spyOn(availability, 'now')
        .mockReturnValueOnce(new Date('2026-11-02T18:30:00.000Z'));
      expect(labelsOf(await search({ availabilityWindow: 'now' }))).toEqual([
        'Evening',
      ]);
    });

    it('"this_week" keeps artisans with a working day in the next 7 that is not time off', async () => {
      expect(
        labelsOf(await search({ availabilityWindow: 'this_week' })),
      ).toEqual(['Evening', 'Open', 'Tomorrow', 'Weekend']);
    });

    it('"this_week" drops an artisan whose only working day is inside time off', async () => {
      await timeOff('Weekend', '2026-11-07', '2026-11-07');
      try {
        expect(
          labelsOf(await search({ availabilityWindow: 'this_week' })),
        ).toEqual(['Evening', 'Open', 'Tomorrow']);
      } finally {
        await dataSource.query(
          `DELETE FROM blocked_slots WHERE artisan_profile_id = $1`,
          [profileId.Weekend],
        );
      }
    });

    it('without a window, everyone is listed with their computed availability', async () => {
      const rows = await search();
      const state = Object.fromEntries(
        rows.map((r) => [
          r.businessName.replace(`${tag} `, ''),
          r.availability?.state,
        ]),
      );
      expect(state).toEqual({
        Open: 'available_today',
        Away: 'on_time_off',
        Tomorrow: 'on_time_off',
        NoHours: 'no_hours',
        Weekend: 'next_available',
        Busy: 'busy',
        Closed: 'unavailable',
        Evening: 'available_today',
        Paused: 'no_hours',
      });
      // Schedule details are for the profile page only.
      expect(rows.every((r) => r.weeklyHours === undefined)).toBe(true);
      // The old field is still there for older clients.
      expect(rows.find((r) => r.businessName.endsWith('Busy'))).toMatchObject({
        availabilityStatus: 'BUSY',
      });
    });
  });

  describe('public profile', () => {
    const profile = async (label: string) =>
      dataOf<PublicArtisan>(
        await request(server())
          .get(`/api/v1/artisans/${profileId[label]}`)
          .expect(200),
      );

    it("shows today's hours and the weekly hours of a working artisan", async () => {
      const p = await profile('Open');
      expect(p.availability).toEqual({
        state: 'available_today',
        today: '2026-11-02',
        hasWorkingHours: true,
        onTimeOffUntil: null,
        todayHours: [
          { startTime: '08:00', endTime: '12:00' },
          { startTime: '13:00', endTime: '17:00' },
        ],
        nextAvailableDate: '2026-11-02',
        bookable: true,
      });
      expect(p.weeklyHours).toHaveLength(10);
      expect(p.weeklyHours?.slice(0, 2)).toEqual([
        { dayOfWeek: 1, startTime: '08:00', endTime: '12:00' },
        { dayOfWeek: 1, startTime: '13:00', endTime: '17:00' },
      ]);
      expect(p.upcomingTimeOff).toEqual([]);
    });

    it('shows time off as dates only, never the reason', async () => {
      const res = await request(server())
        .get(`/api/v1/artisans/${profileId.Away}`)
        .expect(200);
      const p = dataOf<PublicArtisan>(res);
      expect(p.availability).toMatchObject({
        state: 'on_time_off',
        onTimeOffUntil: '2026-11-12',
        nextAvailableDate: '2026-11-13',
        bookable: true,
      });
      expect(p.upcomingTimeOff).toEqual([
        { startDate: '2026-11-01', endDate: '2026-11-06' },
        { startDate: '2026-11-07', endDate: '2026-11-12' },
      ]);
      expect(JSON.stringify(res.body)).not.toContain('Private family matter');
      expectNoForbiddenFields(res.body);
    });

    it('says no hours, and is not bookable, without active weekly hours', async () => {
      for (const label of ['NoHours', 'Paused']) {
        const p = await profile(label);
        expect(p.availability).toMatchObject({
          state: 'no_hours',
          hasWorkingHours: false,
          bookable: false,
        });
        expect(p.weeklyHours).toEqual([]);
      }
    });

    it('points at the next working day on a weekend-only schedule', async () => {
      const p = await profile('Weekend');
      expect(p.availability).toMatchObject({
        state: 'next_available',
        nextAvailableDate: '2026-11-07',
        todayHours: [],
      });
    });

    it('lets the BUSY / UNAVAILABLE status win', async () => {
      expect((await profile('Busy')).availability).toMatchObject({
        state: 'busy',
        bookable: false,
      });
      expect((await profile('Closed')).availability).toMatchObject({
        state: 'unavailable',
        bookable: false,
      });
    });

    it('skips a day that is fully booked', async () => {
      const customer = await users.save(
        users.create({
          email: `avail-c-${uniq}@test.jinva.local`,
          username: `availc${uniq}`,
          firstname: 'Abena',
          lastname: 'Owusu',
          role: Role.CUSTOMER,
          accountVerified: true,
        }),
      );
      await dataSource.query(
        `INSERT INTO bookings (customer_id, artisan_profile_id, scheduled_date, start_time, end_time, status)
         VALUES ($1, $2, '2026-11-02', '08:00', '17:00', 'CONFIRMED')`,
        [customer.id, profileId.Tomorrow],
      );
      // Tomorrow's time off covers today; a full booking tomorrow pushes it on.
      await dataSource.query(
        `INSERT INTO bookings (customer_id, artisan_profile_id, scheduled_date, start_time, end_time, status)
         VALUES ($1, $2, '2026-11-03', '08:00', '17:00', 'PENDING')`,
        [customer.id, profileId.Tomorrow],
      );
      expect((await profile('Tomorrow')).availability).toMatchObject({
        state: 'on_time_off',
        onTimeOffUntil: '2026-11-02',
        nextAvailableDate: '2026-11-04',
      });
    });
  });

  it('gives the artisan the same summary on their own availability', async () => {
    const viewer = await users.findOneByOrFail({
      username: `availOpen${uniq}`,
    });
    const { access_token } = await tokens.createJWTTokens(viewer);
    const res = await request(server())
      .get(`/api/v1/availability/${profileId.Away}`)
      .set('Authorization', `Bearer ${access_token}`)
      .expect(200);
    expect(dataOf<{ summary: Summary }>(res).summary).toMatchObject({
      state: 'on_time_off',
      onTimeOffUntil: '2026-11-12',
    });
  });
});

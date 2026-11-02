import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Role } from '@common/types/enums';
import type { Repository } from 'typeorm';
import type { ArtisanProfile } from '@users/entities/artisan-profile.entity';
import type { User } from '@users/entities/user.entity';
import type { ServiceEntity } from '@services/entities/service.entity';
import type { Job } from '@jobs/entities/job.entity';
import type { AvailabilityService } from '../availability/availability.service';
import {
  ArtisansService,
  computeProfileCompleteness,
} from './artisans.service';

/** A stand-in AvailabilityService with a fixed clock (Sat 31 Oct 2026, 23:30 UTC by default). */
const fakeAvailability = (
  now = new Date('2026-10-31T23:30:00.000Z'),
  described = new Map<number, unknown>(),
) => {
  const fake = {
    now: jest.fn(() => now),
    describeForClients: jest.fn().mockResolvedValue(described),
  };
  return fake as typeof fake & AvailabilityService;
};

describe('computeProfileCompleteness (F3)', () => {
  const complete = {
    bio: 'Experienced plumber.',
    hourlyRate: 45.5,
    location: 'Accra, Ghana',
    services: [{ id: 1 } as any],
  };

  it('is complete when hourlyRate, location, and at least one service are all present', () => {
    const result = computeProfileCompleteness(complete);
    expect(result).toEqual({ isComplete: true, missingFields: [] });
  });

  it('reports every missing field on an empty profile', () => {
    const result = computeProfileCompleteness({
      hourlyRate: undefined,
      location: undefined,
      services: [],
    });
    expect(result.isComplete).toBe(false);
    expect(result.missingFields.sort()).toEqual([
      'hourlyRate',
      'location',
      'services',
    ]);
  });

  it('treats a whitespace-only location as missing', () => {
    const result = computeProfileCompleteness({
      ...complete,
      location: '  ',
    });
    expect(result.isComplete).toBe(false);
    expect(result.missingFields).toEqual(['location']);
  });

  it.each([undefined, null, '', '   '])(
    'does not require a bio — %p still leaves the profile complete (B2)',
    (bio) => {
      const result = computeProfileCompleteness({
        ...complete,
        bio: bio as string | undefined,
      } as typeof complete);
      expect(result).toEqual({ isComplete: true, missingFields: [] });
    },
  );

  it('flags hourlyRate as missing only when null/undefined, not when zero', () => {
    const result = computeProfileCompleteness({ ...complete, hourlyRate: 0 });
    expect(result.missingFields).not.toContain('hourlyRate');
  });

  it('flags services as missing when the array is empty', () => {
    const result = computeProfileCompleteness({ ...complete, services: [] });
    expect(result.isComplete).toBe(false);
    expect(result.missingFields).toEqual(['services']);
  });
});

/**
 * C1.6: `GET /artisans/:id` must answer with the *same* 404 for a nonexistent
 * artisan, a soft-deleted one and a purged one.
 *
 * The failure this guards against was a real 500 on an unauthenticated public
 * route: `artisan_profiles` is not soft-deletable, so a soft-deleted owner
 * leaves the profile row in place with `user` nulled by TypeORM's soft-delete
 * filter on the relation's LEFT join, and the completed-jobs lookup then
 * dereferenced null. A 500-vs-404 difference is also an oracle for "this
 * artisan deleted their account", which is exactly what C1 promises it isn't.
 */
describe('ArtisansService.findById (C1.6)', () => {
  const jobsCount = jest.fn().mockResolvedValue(0);
  let availability = fakeAvailability();

  const buildService = (profile: unknown) => {
    const artisanProfileRepository = {
      findOne: jest.fn().mockResolvedValue(profile),
    } as unknown as Repository<ArtisanProfile>;

    return new ArtisansService(
      artisanProfileRepository,
      {} as unknown as Repository<User>,
      {} as unknown as Repository<ServiceEntity>,
      { count: jobsCount } as unknown as Repository<Job>,
      availability,
    );
  };

  beforeEach(() => {
    jobsCount.mockClear();
    availability = fakeAvailability();
  });

  it('404s when no profile row exists at all', async () => {
    await expect(buildService(null).findById(472)).rejects.toThrow(
      NotFoundException,
    );
  });

  it('404s — never 500s — when the profile exists but its owner is soft-deleted', async () => {
    // What the repository actually returns for a soft-deleted owner: the
    // profile row, with a null `user`.
    const service = buildService({ id: 472, user: null, services: [] });

    await expect(service.findById(472)).rejects.toThrow(NotFoundException);
    // The null dereference happened inside the completed-jobs lookup, so this
    // asserts the guard runs *before* it rather than the TypeError being
    // caught somewhere.
    expect(jobsCount).not.toHaveBeenCalled();
  });

  it('is byte-identical to the nonexistent-ID 404, so deletion is not disclosed', async () => {
    const missing = await buildService(null)
      .findById(472)
      .catch((err: NotFoundException) => err.message);
    const deleted = await buildService({ id: 472, user: null, services: [] })
      .findById(472)
      .catch((err: NotFoundException) => err.message);

    expect(deleted).toBe(missing);
  });

  const live = (overrides: Record<string, unknown> = {}) => ({
    id: 472,
    isProfileComplete: true,
    user: { id: 90, isBanned: false, isSuspended: false },
    services: [],
    ...overrides,
  });

  it('still returns the profile when the owner is live', async () => {
    const service = buildService(live());

    const result = await service.findById(472);

    expect(result.data).toBeDefined();
    expect(jobsCount).toHaveBeenCalledTimes(1);
  });

  it('adds the client-facing availability, weekly hours and time-off dates', async () => {
    const summary = { state: 'on_time_off', onTimeOffUntil: '2026-11-12' };
    availability = fakeAvailability(
      undefined,
      new Map([
        [
          472,
          {
            summary,
            weeklyHours: [
              { dayOfWeek: 1, startTime: '08:00', endTime: '12:00' },
            ],
            upcomingTimeOff: [
              { startDate: '2026-11-01', endDate: '2026-11-12' },
            ],
          },
        ],
      ]),
    );
    const result = await buildService(live()).findById(472);

    expect(availability.describeForClients).toHaveBeenCalledWith([
      expect.objectContaining({ id: 472 }),
    ]);
    expect(result.data.availability).toBe(summary);
    expect(result.data.weeklyHours).toEqual([
      { dayOfWeek: 1, startTime: '08:00', endTime: '12:00' },
    ]);
    expect(result.data.upcomingTimeOff).toEqual([
      { startDate: '2026-11-01', endDate: '2026-11-12' },
    ]);
  });

  it('answers empty hours and time off when nothing was computed', async () => {
    const result = await buildService(live()).findById(472);
    expect(result.data.weeklyHours).toEqual([]);
    expect(result.data.upcomingTimeOff).toEqual([]);
    expect(result.data.availability).toBeUndefined();
  });

  describe('artisans hidden from search (QA SRCH-15)', () => {
    it.each([
      ['suspended', { user: { id: 90, isBanned: false, isSuspended: true } }],
      ['banned', { user: { id: 90, isBanned: true, isSuspended: false } }],
      ['incomplete', { isProfileComplete: false }],
    ])('answers not-found for a %s artisan', async (_label, overrides) => {
      const service = buildService(live(overrides));
      await expect(service.findById(472)).rejects.toThrow(NotFoundException);
      await expect(
        service.findById(472, { id: 55, role: Role.CUSTOMER }),
      ).rejects.toThrow(NotFoundException);
    });

    it('still shows the artisan their own hidden profile, and admins', async () => {
      const hidden = live({ isProfileComplete: false });
      await expect(
        buildService(hidden).findById(472, { id: 90, role: Role.ARTISAN }),
      ).resolves.toBeDefined();
      await expect(
        buildService(hidden).findById(472, { id: 1, role: Role.ADMIN }),
      ).resolves.toBeDefined();
    });
  });
});

const makeSearchQb = (profiles: unknown[], total: number) => {
  const qb: Record<string, jest.Mock> = {};
  for (const m of [
    'innerJoinAndSelect',
    'leftJoinAndSelect',
    'where',
    'andWhere',
    'orderBy',
    'addOrderBy',
    'skip',
    'take',
  ]) {
    qb[m] = jest.fn().mockReturnValue(qb);
  }
  qb.getMany = jest.fn().mockResolvedValue(profiles);
  qb.clone = jest.fn().mockReturnValue({
    getCount: jest.fn().mockResolvedValue(total),
  });
  return qb;
};

const lastWhere = (qb: Record<string, jest.Mock>) =>
  qb.andWhere.mock.calls.at(-1) as [string, Record<string, unknown>?];

const makeJobsQb = (rows: unknown[]) => {
  const qb: Record<string, jest.Mock> = {};
  for (const m of [
    'innerJoin',
    'select',
    'addSelect',
    'where',
    'andWhere',
    'groupBy',
  ]) {
    qb[m] = jest.fn().mockReturnValue(qb);
  }
  qb.getRawMany = jest.fn().mockResolvedValue(rows);
  return qb;
};

describe('ArtisansService.search', () => {
  const setup = (
    profiles: unknown[] = [],
    total = 0,
    jobRows: unknown[] = [],
    availability = fakeAvailability(),
  ) => {
    const qb = makeSearchQb(profiles, total);
    const jobsQb = makeJobsQb(jobRows);
    const service = new ArtisansService(
      {
        createQueryBuilder: jest.fn().mockReturnValue(qb),
      } as unknown as Repository<ArtisanProfile>,
      {} as unknown as Repository<User>,
      {} as unknown as Repository<ServiceEntity>,
      {
        createQueryBuilder: jest.fn().mockReturnValue(jobsQb),
      } as unknown as Repository<Job>,
      availability,
    );
    const whereClauses = () =>
      qb.andWhere.mock.calls.map(([sql]: [string]) => sql.replace(/\s+/g, ' '));
    return { service, qb, jobsQb, whereClauses, availability };
  };

  it('always excludes deleted, incomplete, suspended and banned artisans', async () => {
    const { service, qb, whereClauses } = setup();
    await service.search({});

    expect(qb.where).toHaveBeenCalledWith('user.deletedAt IS NULL');
    expect(whereClauses()).toEqual([
      'ap.isProfileComplete = true',
      'user.isSuspended = false',
      'user.isBanned = false',
    ]);
  });

  it('defaults to page 1 of 20 sorted by weighted rating with stable tie-breaks', async () => {
    const { service, qb } = setup([], 0);
    const result = await service.search({});

    expect(qb.skip).toHaveBeenCalledWith(0);
    expect(qb.take).toHaveBeenCalledWith(20);
    expect(qb.orderBy).toHaveBeenCalledWith('ap.weightedRating', 'DESC');
    expect(qb.addOrderBy.mock.calls).toEqual([
      ['ap.totalReviews', 'DESC'],
      ['ap.id', 'ASC'],
    ]);
    expect(result.pagination).toEqual({
      total: 0,
      page: 1,
      limit: 20,
      totalPages: 0,
    });
  });

  it('pages with skip/take and reports the real total from the cloned count query', async () => {
    const { service, qb } = setup([], 45);
    const result = await service.search({ page: 3, limit: 10 } as never);

    expect(qb.skip).toHaveBeenCalledWith(20);
    expect(qb.take).toHaveBeenCalledWith(10);
    expect(qb.clone).toHaveBeenCalled();
    expect(result.pagination).toEqual({
      total: 45,
      page: 3,
      limit: 10,
      totalPages: 5,
    });
  });

  it.each([
    ['newest', ['ap.createdAt', 'DESC']],
    ['experience', ['ap.experienceYears', 'DESC', 'NULLS LAST']],
    ['hourlyRate', ['ap.hourlyRate', 'ASC', 'NULLS LAST']],
  ])('sorts by %s', async (sortBy, expected) => {
    const { service, qb } = setup();
    await service.search({ sortBy } as never);
    expect(qb.orderBy).toHaveBeenCalledWith(...expected);
    expect(qb.addOrderBy).not.toHaveBeenCalled();
  });

  it('applies every attribute filter with lower-cased LIKE params', async () => {
    const { service, qb, whereClauses } = setup();
    await service.search({
      serviceId: 7,
      keyword: 'KwAme',
      location: 'East Legon',
      minRating: 4,
      availabilityStatus: 'AVAILABLE',
      isVerified: false,
    } as never);

    const params = qb.andWhere.mock.calls.map((c: unknown[]) => c[1]);
    expect(params).toEqual(
      expect.arrayContaining([
        { serviceId: 7 },
        { kw: '%kwame%' },
        { loc: '%east legon%' },
        { minRating: 4 },
        { availabilityStatus: 'AVAILABLE' },
        { isVerified: false },
      ]),
    );
    const sql = whereClauses();
    expect(sql).toContain('ap.averageRating >= :minRating');
    expect(sql).toContain('LOWER(ap.location) LIKE :loc');
    expect(sql.some((s) => s.includes('aps.service_id = :serviceId'))).toBe(
      true,
    );
  });

  it('builds the price filter with only the bounds supplied', async () => {
    const onlyMin = setup();
    await onlyMin.service.search({ minPrice: 50 } as never);
    const minCall = lastWhere(onlyMin.qb);
    expect(minCall[0]).toContain('svc.price >= :minPrice');
    expect(minCall[0]).not.toContain(':maxPrice');
    expect(minCall[1]).toEqual({ minPrice: 50 });

    const both = setup();
    await both.service.search({ minPrice: 50, maxPrice: 200 } as never);
    const bothCall = lastWhere(both.qb);
    expect(bothCall[0]).toContain('svc.price >= :minPrice');
    expect(bothCall[0]).toContain('svc.price <= :maxPrice');
    expect(bothCall[1]).toEqual({ minPrice: 50, maxPrice: 200 });

    const onlyMax = setup();
    await onlyMax.service.search({ maxPrice: 80 } as never);
    expect(lastWhere(onlyMax.qb)[1]).toEqual({
      maxPrice: 80,
    });
  });

  const flat = (sql: string) => sql.replace(/\s+/g, ' ');

  it('filters "now" on Accra time, status AVAILABLE and no time off today', async () => {
    // 23:30 UTC on Saturday 31 Oct is 23:30 Saturday in Accra, whatever the
    // server's own zone (and the real date) happens to be.
    const { service, qb } = setup();
    await service.search({ availabilityWindow: 'now' } as never);
    const calls = qb.andWhere.mock.calls as Array<[string, object?]>;
    const [statusSql, statusParams] = calls.at(-2)!;
    expect(statusSql).toBe('ap.availabilityStatus = :availWindowStatus');
    expect(statusParams).toEqual({ availWindowStatus: 'AVAILABLE' });
    const [sql, params] = lastWhere(qb);
    expect(flat(sql)).toContain('av.day_of_week = :availDayOfWeek');
    expect(flat(sql)).toContain(
      'NOT EXISTS ( SELECT 1 FROM blocked_slots bs WHERE bs.artisan_profile_id = ap.id AND bs.start_date <= :availToday AND bs.end_date >= :availToday )',
    );
    expect(params).toEqual({
      availDayOfWeek: 6,
      availCurrentTime: '23:30:00',
      availToday: '2026-10-31',
    });
  });

  it('rolls "now" over to the next Accra day just after midnight UTC', async () => {
    const { service, qb } = setup(
      [],
      0,
      [],
      fakeAvailability(new Date('2026-11-01T00:00:30.000Z')),
    );
    await service.search({ availabilityWindow: 'now' } as never);
    expect(lastWhere(qb)[1]).toEqual({
      availDayOfWeek: 0,
      availCurrentTime: '00:00:30',
      availToday: '2026-11-01',
    });
  });

  it('filters "this week" to an active slot on one of the next 7 days that is not time off', async () => {
    const { service, qb } = setup();
    await service.search({ availabilityWindow: 'this_week' } as never);
    const [sql, params] = lastWhere(qb);
    expect(flat(sql)).toContain('av.is_active = true');
    for (let i = 0; i < 7; i++) {
      expect(sql).toContain(`av.day_of_week = :availWeekDow${i}`);
      expect(sql).toContain(`bs.end_date >= :availWeekDate${i}`);
    }
    expect(params).toEqual({
      availWeekDow0: 6,
      availWeekDate0: '2026-10-31',
      availWeekDow1: 0,
      availWeekDate1: '2026-11-01',
      availWeekDow2: 1,
      availWeekDate2: '2026-11-02',
      availWeekDow3: 2,
      availWeekDate3: '2026-11-03',
      availWeekDow4: 3,
      availWeekDate4: '2026-11-04',
      availWeekDow5: 4,
      availWeekDate5: '2026-11-05',
      availWeekDow6: 5,
      availWeekDate6: '2026-11-06',
    });
    const calls = qb.andWhere.mock.calls as Array<[string, object?]>;
    expect(calls.at(-2)![1]).toEqual({ availWindowStatus: 'AVAILABLE' });
  });

  it("adds each card's availability from one batched lookup", async () => {
    const profiles = [
      { id: 1, user: { id: 11 } },
      { id: 2, user: { id: 12 } },
    ];
    const summary = { state: 'no_hours' };
    const availability = fakeAvailability(
      undefined,
      new Map([[2, { summary }]]),
    );
    const { service } = setup(profiles, 2, [], availability);
    const result = await service.search({});
    expect(availability.describeForClients).toHaveBeenCalledTimes(1);
    expect(availability.describeForClients).toHaveBeenCalledWith(profiles);
    expect(result.data.map((d) => d.availability)).toEqual([
      undefined,
      summary,
    ]);
    // Schedule details stay on the profile endpoint.
    expect(result.data[1].weeklyHours).toBeUndefined();
  });

  it('attaches completed-jobs counts from one grouped query', async () => {
    const profiles = [
      { id: 1, user: { id: 11 } },
      { id: 2, user: { id: 12 } },
    ];
    const { service, jobsQb } = setup(profiles, 2, [
      { artisanUserId: '11', count: '4' },
    ]);
    const result = await service.search({});

    expect(jobsQb.where).toHaveBeenCalledWith(
      'acceptedArtisan.id IN (:...userIds)',
      { userIds: [11, 12] },
    );
    expect(jobsQb.getRawMany).toHaveBeenCalledTimes(1);
    expect(result.data.map((d) => d.completedJobsCount)).toEqual([4, 0]);
  });

  it('skips the completed-jobs query on an empty page', async () => {
    const { service, jobsQb } = setup([], 0);
    await service.search({});
    expect(jobsQb.getRawMany).not.toHaveBeenCalled();
  });
});

describe('ArtisansService self-management', () => {
  const baseProfile = () => ({
    id: 30,
    hourlyRate: 40,
    location: 'Kumasi',
    isProfileComplete: true,
    user: { id: 90, addresses: [] },
    services: [{ id: 1, name: 'Plumbing' }] as Array<{
      id: number;
      name: string;
    }>,
  });

  const setup = (profile: unknown) => {
    const profileRepo = {
      findOne: jest
        .fn()
        .mockResolvedValueOnce(profile)
        .mockImplementation(() => Promise.resolve(profile)),
      save: jest.fn((p: unknown) => Promise.resolve(p)),
    };
    const servicesRepo = { findBy: jest.fn(), findOne: jest.fn() };
    const jobsRepo = { count: jest.fn().mockResolvedValue(6) };
    const service = new ArtisansService(
      profileRepo as unknown as Repository<ArtisanProfile>,
      {} as unknown as Repository<User>,
      servicesRepo as unknown as Repository<ServiceEntity>,
      jobsRepo as unknown as Repository<Job>,
      fakeAvailability(),
    );
    return { service, profileRepo, servicesRepo, jobsRepo };
  };

  describe('updateMe', () => {
    it('404s when the caller has no artisan profile', async () => {
      const { service } = setup(null);
      await expect(service.updateMe(90, {})).rejects.toThrow(NotFoundException);
    });

    it('replaces services with the requested set and keeps the profile complete', async () => {
      const profile = baseProfile();
      const { service, profileRepo, servicesRepo, jobsRepo } = setup(profile);
      servicesRepo.findBy.mockResolvedValue([
        { id: 2, name: 'Tiling' },
        { id: 3, name: 'Painting' },
      ]);

      const result = await service.updateMe(90, {
        serviceIds: [2, 3],
        bio: 'Neat work.',
      } as never);

      expect(profileRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          bio: 'Neat work.',
          isProfileComplete: true,
          services: [
            { id: 2, name: 'Tiling' },
            { id: 3, name: 'Painting' },
          ],
        }),
      );
      expect(result.data.missingFields).toEqual([]);
      expect(result.data.completedJobsCount).toBe(6);
      expect(jobsRepo.count).toHaveBeenCalled();
    });

    it('404s when any requested service id does not exist', async () => {
      const { service, servicesRepo, profileRepo } = setup(baseProfile());
      servicesRepo.findBy.mockResolvedValue([{ id: 2 }]);
      await expect(
        service.updateMe(90, { serviceIds: [2, 999] } as never),
      ).rejects.toThrow('One or more services were not found.');
      expect(profileRepo.save).not.toHaveBeenCalled();
    });

    it('clearing services and the rate drops the artisan out of search', async () => {
      const { service, profileRepo, servicesRepo } = setup(baseProfile());
      const result = await service.updateMe(90, {
        serviceIds: [],
        hourlyRate: null,
      } as never);

      expect(servicesRepo.findBy).not.toHaveBeenCalled();
      expect(profileRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ services: [], isProfileComplete: false }),
      );
      expect(result.data.missingFields.sort()).toEqual([
        'hourlyRate',
        'services',
      ]);
    });

    it('leaves services alone when serviceIds is omitted', async () => {
      const { service, profileRepo, servicesRepo } = setup(baseProfile());
      await service.updateMe(90, { location: 'Tamale' } as never);
      expect(servicesRepo.findBy).not.toHaveBeenCalled();
      expect(profileRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          location: 'Tamale',
          services: [{ id: 1, name: 'Plumbing' }],
        }),
      );
    });
  });

  describe('addService', () => {
    it('404s without a profile', async () => {
      const { service } = setup(null);
      await expect(service.addService(90, 2)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('404s for an unknown service', async () => {
      const { service, servicesRepo } = setup(baseProfile());
      servicesRepo.findOne.mockResolvedValue(null);
      await expect(service.addService(90, 2)).rejects.toThrow(
        'Service with id 2 not found.',
      );
    });

    it('409s when the service is already offered', async () => {
      const { service, servicesRepo, profileRepo } = setup(baseProfile());
      servicesRepo.findOne.mockResolvedValue({ id: 1, name: 'Plumbing' });
      await expect(service.addService(90, 1)).rejects.toThrow(
        ConflictException,
      );
      expect(profileRepo.save).not.toHaveBeenCalled();
    });

    it('appends the service and recomputes completeness', async () => {
      const profile = { ...baseProfile(), services: [] as never[] };
      profile.isProfileComplete = false;
      const { service, servicesRepo, profileRepo } = setup(profile);
      servicesRepo.findOne.mockResolvedValue({ id: 2, name: 'Tiling' });

      const result = await service.addService(90, 2);

      expect(profileRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          services: [{ id: 2, name: 'Tiling' }],
          isProfileComplete: true,
        }),
      );
      expect(result.data.missingFields).toEqual([]);
    });
  });

  describe('removeService', () => {
    it('404s without a profile', async () => {
      const { service } = setup(null);
      await expect(service.removeService(90, 1)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('400s when the service is not on the profile', async () => {
      const { service } = setup(baseProfile());
      await expect(service.removeService(90, 5)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('removing the last service marks the profile incomplete', async () => {
      const { service, profileRepo } = setup(baseProfile());
      const result = await service.removeService(90, 1);

      expect(profileRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ services: [], isProfileComplete: false }),
      );
      expect(result.data.missingFields).toEqual(['services']);
    });
  });
});

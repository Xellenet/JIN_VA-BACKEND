import { NotFoundException } from '@nestjs/common';
import type { Repository } from 'typeorm';
import type { ArtisanProfile } from '@users/entities/artisan-profile.entity';
import type { User } from '@users/entities/user.entity';
import type { ServiceEntity } from '@services/entities/service.entity';
import type { Job } from '@jobs/entities/job.entity';
import { ArtisansService, computeProfileCompleteness } from './artisans.service';

describe('computeProfileCompleteness (F3)', () => {
  const complete = {
    bio: 'Experienced plumber.',
    hourlyRate: 45.5,
    location: 'Accra, Ghana',
    services: [{ id: 1 } as any],
  };

  it('is complete when bio, hourlyRate, location, and at least one service are all present', () => {
    const result = computeProfileCompleteness(complete);
    expect(result).toEqual({ isComplete: true, missingFields: [] });
  });

  it('reports every missing field on an empty profile', () => {
    const result = computeProfileCompleteness({
      bio: undefined,
      hourlyRate: undefined,
      location: undefined,
      services: [],
    });
    expect(result.isComplete).toBe(false);
    expect(result.missingFields.sort()).toEqual([
      'bio',
      'hourlyRate',
      'location',
      'services',
    ]);
  });

  it('treats a whitespace-only bio/location as missing', () => {
    const result = computeProfileCompleteness({
      ...complete,
      bio: '   ',
      location: '  ',
    });
    expect(result.isComplete).toBe(false);
    expect(result.missingFields).toEqual(
      expect.arrayContaining(['bio', 'location']),
    );
  });

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

  const buildService = (profile: unknown) => {
    const artisanProfileRepository = {
      findOne: jest.fn().mockResolvedValue(profile),
    } as unknown as Repository<ArtisanProfile>;

    return new ArtisansService(
      artisanProfileRepository,
      {} as unknown as Repository<User>,
      {} as unknown as Repository<ServiceEntity>,
      { count: jobsCount } as unknown as Repository<Job>,
    );
  };

  beforeEach(() => jobsCount.mockClear());

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

  it('still returns the profile when the owner is live', async () => {
    const service = buildService({
      id: 472,
      user: { id: 90 },
      services: [],
    });

    const result = await service.findById(472);

    expect(result.data).toBeDefined();
    expect(jobsCount).toHaveBeenCalledTimes(1);
  });
});

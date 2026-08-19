import { computeProfileCompleteness } from './artisans.service';

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

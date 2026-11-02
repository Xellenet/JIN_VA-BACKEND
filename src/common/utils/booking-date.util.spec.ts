import { formatBookingDate } from './booking-date.util';

describe('formatBookingDate (X5)', () => {
  const TZ = process.env.TZ;
  afterEach(() => {
    process.env.TZ = TZ;
  });

  it.each([
    ['2026-07-07', 'Tuesday 7 July 2026'],
    ['2026-07-10', 'Friday 10 July 2026'],
    ['2026-07-15', 'Wednesday 15 July 2026'],
    ['2026-01-01', 'Thursday 1 January 2026'],
    ['2024-02-29', 'Thursday 29 February 2024'],
  ])('%s → %s', (input, expected) => {
    expect(formatBookingDate(input)).toBe(expected);
  });

  it('never drifts with a server time zone west of UTC', () => {
    process.env.TZ = 'America/Los_Angeles';
    expect(formatBookingDate('2026-07-07')).toBe('Tuesday 7 July 2026');
  });

  it('accepts a Date (its UTC day) and a timestamp string', () => {
    expect(formatBookingDate(new Date('2026-07-07T00:00:00.000Z'))).toBe(
      'Tuesday 7 July 2026',
    );
    expect(formatBookingDate('2026-07-07T23:00:00Z')).toBe(
      'Tuesday 7 July 2026',
    );
  });

  it('returns anything it cannot read unchanged, never "Invalid Date"', () => {
    expect(formatBookingDate('soon')).toBe('soon');
    expect(formatBookingDate('2026-02-31')).toBe('2026-02-31');
    expect(formatBookingDate(new Date('nope'))).toBe('');
    expect(formatBookingDate(null)).toBe('');
    expect(formatBookingDate(undefined)).toBe('');
  });
});

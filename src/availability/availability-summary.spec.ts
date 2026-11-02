import { AvailabilityStatus } from '@common/types/enums';
import {
  addDays,
  platformClock,
  subtractOccupied,
  summariseAvailability,
  timeOffUntil,
  type SummaryInput,
} from './availability-summary';

/** Mon–Fri 08:00–12:00 and 13:00–17:00, like the seed artisan. */
const weekdayHours = [1, 2, 3, 4, 5].flatMap((dayOfWeek) => [
  { dayOfWeek, startTime: '08:00:00', endTime: '12:00:00' },
  { dayOfWeek, startTime: '13:00:00', endTime: '17:00:00' },
]);

const summarise = (overrides: Partial<SummaryInput> & { now: Date }) =>
  summariseAvailability({
    status: AvailabilityStatus.AVAILABLE,
    slots: weekdayHours,
    blocks: [],
    ...overrides,
  });

// Accra is UTC+0 with no DST, so these instants are also Accra wall-clock times.
const MON_0930 = new Date('2026-11-02T09:30:00.000Z'); // Monday 2 Nov 2026
const SAT_1000 = new Date('2026-10-31T10:00:00.000Z'); // Saturday 31 Oct 2026

describe('summariseAvailability', () => {
  it("is available today inside working hours, with today's windows", () => {
    expect(summarise({ now: MON_0930 })).toEqual({
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
  });

  it('is on time off when today is inside a time-off range', () => {
    const result = summarise({
      now: MON_0930,
      blocks: [{ startDate: '2026-11-01', endDate: '2026-11-12' }],
    });
    expect(result).toMatchObject({
      state: 'on_time_off',
      onTimeOffUntil: '2026-11-12',
      nextAvailableDate: '2026-11-13', // Friday, the first working day after
      bookable: true,
    });
  });

  it('follows back-to-back time off to its real end', () => {
    const result = summarise({
      now: MON_0930,
      blocks: [
        { startDate: '2026-11-04', endDate: '2026-11-06' },
        { startDate: '2026-11-02', endDate: '2026-11-03' },
      ],
    });
    expect(result.onTimeOffUntil).toBe('2026-11-06');
    expect(result.nextAvailableDate).toBe('2026-11-09');
  });

  it('ends time off that finishes tomorrow, then is available the day after', () => {
    const result = summarise({
      now: MON_0930,
      blocks: [{ startDate: '2026-11-02', endDate: '2026-11-03' }],
    });
    expect(result).toMatchObject({
      state: 'on_time_off',
      onTimeOffUntil: '2026-11-03',
      nextAvailableDate: '2026-11-04',
    });
  });

  it('time off starting tomorrow leaves today available', () => {
    const result = summarise({
      now: MON_0930,
      blocks: [{ startDate: '2026-11-03', endDate: '2026-11-05' }],
    });
    expect(result.state).toBe('available_today');
    expect(result.onTimeOffUntil).toBeNull();
  });

  it('has no hours when no active weekly slot exists', () => {
    expect(summarise({ now: MON_0930, slots: [] })).toEqual({
      state: 'no_hours',
      today: '2026-11-02',
      hasWorkingHours: false,
      onTimeOffUntil: null,
      todayHours: [],
      nextAvailableDate: null,
      bookable: false,
    });
  });

  it('on a weekend with Mon–Fri hours, points at Monday', () => {
    expect(summarise({ now: SAT_1000 })).toMatchObject({
      state: 'next_available',
      today: '2026-10-31',
      todayHours: [],
      nextAvailableDate: '2026-11-02',
      bookable: true,
    });
  });

  it("after today's last window has ended, points at the next working day", () => {
    const result = summarise({ now: new Date('2026-11-02T17:00:00.000Z') });
    expect(result.state).toBe('next_available');
    expect(result.nextAvailableDate).toBe('2026-11-03');
    expect(result.todayHours).toHaveLength(2);
  });

  it('is still available today between a split shift', () => {
    const result = summarise({ now: new Date('2026-11-02T12:30:00.000Z') });
    expect(result.state).toBe('available_today');
  });

  it('skips a day whose hours are fully booked', () => {
    const result = summarise({
      now: MON_0930,
      bookings: [
        { scheduledDate: '2026-11-02', startTime: '08:00', endTime: '12:00' },
        { scheduledDate: '2026-11-02', startTime: '13:00', endTime: '17:00' },
      ],
    });
    expect(result.state).toBe('next_available');
    expect(result.nextAvailableDate).toBe('2026-11-03');
  });

  it('counts a partly booked day as available', () => {
    const result = summarise({
      now: MON_0930,
      bookings: [
        { scheduledDate: '2026-11-02', startTime: '13:00', endTime: '15:00' },
      ],
    });
    expect(result.state).toBe('available_today');
  });

  it('has no next date when every working day in the next 14 is time off', () => {
    const result = summarise({
      now: SAT_1000,
      blocks: [{ startDate: '2026-11-02', endDate: '2026-11-20' }],
    });
    expect(result).toMatchObject({
      state: 'next_available',
      nextAvailableDate: null,
      bookable: false,
    });
  });

  describe('Accra date boundary', () => {
    const tz = process.env.TZ;
    afterEach(() => {
      process.env.TZ = tz;
    });

    it('is still Sunday at 23:59 UTC, even on a server east of Accra', () => {
      // In Auckland this instant is already Monday morning.
      process.env.TZ = 'Pacific/Auckland';
      const result = summarise({ now: new Date('2026-11-01T23:59:00.000Z') });
      expect(result.today).toBe('2026-11-01');
      expect(result.state).toBe('next_available');
      expect(result.nextAvailableDate).toBe('2026-11-02');
    });

    it('becomes Monday just after midnight UTC, even on a server west of Accra', () => {
      // In Los Angeles this instant is still Sunday afternoon.
      process.env.TZ = 'America/Los_Angeles';
      const result = summarise({
        now: new Date('2026-11-02T00:00:30.000Z'),
        slots: [{ dayOfWeek: 1, startTime: '00:00', endTime: '06:00' }],
      });
      expect(result.today).toBe('2026-11-02');
      expect(result.state).toBe('available_today');
    });

    it('applies time off by the Accra date', () => {
      process.env.TZ = 'Pacific/Auckland';
      const result = summarise({
        now: new Date('2026-11-01T23:30:00.000Z'),
        blocks: [{ startDate: '2026-11-02', endDate: '2026-11-02' }],
      });
      // Not yet on time off: it is still Sunday 1 Nov in Accra.
      expect(result.onTimeOffUntil).toBeNull();
      expect(result.nextAvailableDate).toBe('2026-11-03');
    });
  });

  describe('status overrides', () => {
    it.each([
      [AvailabilityStatus.BUSY, 'busy'],
      [AvailabilityStatus.UNAVAILABLE, 'unavailable'],
    ])('%s wins over working hours and time off', (status, state) => {
      for (const blocks of [
        [],
        [{ startDate: '2026-11-01', endDate: '2026-11-05' }],
      ]) {
        const result = summarise({ now: MON_0930, status, blocks });
        expect(result.state).toBe(state);
        expect(result.bookable).toBe(false);
      }
      expect(summarise({ now: MON_0930, status, slots: [] }).state).toBe(state);
    });

    it('still reports the schedule facts under BUSY', () => {
      const result = summarise({
        now: MON_0930,
        status: AvailabilityStatus.BUSY,
      });
      expect(result.hasWorkingHours).toBe(true);
      expect(result.nextAvailableDate).toBe('2026-11-02');
    });
  });
});

describe('availability helpers', () => {
  it('platformClock reads Accra wall-clock parts', () => {
    expect(platformClock(new Date('2026-11-01T23:59:59.000Z'))).toEqual({
      date: '2026-11-01',
      time: '23:59:59',
      dayOfWeek: 0,
    });
  });

  it('addDays crosses month and year ends', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });

  it('timeOffUntil is null for a day outside time off', () => {
    expect(
      timeOffUntil(
        [{ startDate: '2026-11-03', endDate: '2026-11-04' }],
        '2026-11-02',
      ),
    ).toBeNull();
  });

  it('subtractOccupied splits a window around bookings', () => {
    expect(
      subtractOccupied('09:00', '12:00', [
        { startTime: '10:00', endTime: '11:00' },
      ]),
    ).toEqual([
      { startTime: '09:00', endTime: '10:00' },
      { startTime: '11:00', endTime: '12:00' },
    ]);
  });
});

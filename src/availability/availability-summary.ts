import { AvailabilityStatus } from '@common/types/enums';

/**
 * What a client should be told about an artisan's availability, computed from
 * the artisan's Calendar settings (weekly hours, time off, status) and, where
 * loaded, their PENDING/CONFIRMED bookings. Pure functions only, so the same
 * rules drive search cards, the public profile, favourites and the artisan's
 * own "What clients see" line, and can be unit-tested with a fixed clock.
 *
 * All dates are calendar days in Africa/Accra (the platform's operating
 * time zone, UTC+0 with no DST), never the server's local zone.
 */
export const PLATFORM_TIME_ZONE = 'Africa/Accra';

/** How far ahead `nextAvailableDate` looks, in days (today included). */
export const AVAILABILITY_HORIZON_DAYS = 14;

export type EffectiveAvailabilityState =
  | 'available_today'
  | 'next_available'
  | 'on_time_off'
  | 'no_hours'
  | 'busy'
  | 'unavailable';

export interface TimeWindow {
  /** HH:MM */
  startTime: string;
  /** HH:MM */
  endTime: string;
}

export interface AvailabilitySummary {
  state: EffectiveAvailabilityState;
  /** The Accra calendar date the summary was computed for (YYYY-MM-DD). */
  today: string;
  /** At least one active weekly working-hours slot exists. */
  hasWorkingHours: boolean;
  /** Last day of the time off covering today (contiguous ranges merged), else null. */
  onTimeOffUntil: string | null;
  /** Today's active weekly windows (not reduced by bookings), HH:MM. */
  todayHours: TimeWindow[];
  /**
   * First date in the next {@link AVAILABILITY_HORIZON_DAYS} days (today
   * included) with working hours, no time off and, where bookings were
   * loaded, time not already taken. Today only counts while some of its
   * hours are still ahead. Null when nothing qualifies.
   */
  nextAvailableDate: string | null;
  /** Clients can request a booking within the horizon. */
  bookable: boolean;
}

export interface SummaryInput {
  status: string | null | undefined;
  /** Active weekly slots only. */
  slots: ReadonlyArray<{
    dayOfWeek: number;
    startTime: string;
    endTime: string;
  }>;
  blocks: ReadonlyArray<{ startDate: string; endDate: string }>;
  /** Optional PENDING/CONFIRMED bookings in the horizon. */
  bookings?: ReadonlyArray<{
    scheduledDate: string;
    startTime: string;
    endTime: string;
  }>;
  now: Date;
  horizonDays?: number;
}

const ACCRA_PARTS = new Intl.DateTimeFormat('en-CA', {
  timeZone: PLATFORM_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

/** The Accra calendar date, wall-clock time and weekday (0 = Sunday) of an instant. */
export function platformClock(now: Date): {
  date: string;
  time: string;
  dayOfWeek: number;
} {
  const p = Object.fromEntries(
    ACCRA_PARTS.formatToParts(now).map((x) => [x.type, x.value]),
  );
  const date = `${p.year}-${p.month}-${p.day}`;
  return {
    date,
    time: `${p.hour}:${p.minute}:${p.second}`,
    dayOfWeek: dayOfWeekOf(date),
  };
}

/** Weekday of a YYYY-MM-DD calendar date, 0 = Sunday. */
export function dayOfWeekOf(date: string): number {
  return new Date(`${date}T00:00:00.000Z`).getUTCDay();
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** "8:00", "08:00" or "08:00:00" → "08:00:00", so times compare as strings. */
export function toClock(time: string): string {
  const [h = '0', m = '0', s = '0'] = time.split(':');
  return `${h.padStart(2, '0')}:${m.padStart(2, '0')}:${s.padStart(2, '0')}`;
}

const hhmm = (time: string) => toClock(time).slice(0, 5);

/**
 * Fragments one [start, end) window by subtracting every overlapping
 * occupied interval, returning the remaining open sub-windows in order
 * (e.g. 09:00–12:00 minus 10:00–11:00 → [09:00–10:00, 11:00–12:00]).
 */
export function subtractOccupied(
  windowStart: string,
  windowEnd: string,
  occupied: ReadonlyArray<{ startTime: string; endTime: string }>,
): TimeWindow[] {
  const overlapping = occupied
    .filter((o) => o.endTime > windowStart && o.startTime < windowEnd)
    .sort((a, b) => a.startTime.localeCompare(b.startTime));

  const result: TimeWindow[] = [];
  let cursor = windowStart;
  for (const o of overlapping) {
    const gapStart = o.startTime > cursor ? o.startTime : cursor;
    if (gapStart > cursor) {
      result.push({ startTime: cursor, endTime: gapStart });
    }
    if (o.endTime > cursor) cursor = o.endTime;
  }
  if (cursor < windowEnd) {
    result.push({ startTime: cursor, endTime: windowEnd });
  }
  return result;
}

const covers = (block: { startDate: string; endDate: string }, date: string) =>
  date >= block.startDate.slice(0, 10) && date <= block.endDate.slice(0, 10);

/**
 * The last day of the time off covering `date`, following back-to-back or
 * overlapping ranges, or null when `date` isn't time off.
 */
export function timeOffUntil(
  blocks: SummaryInput['blocks'],
  date: string,
): string | null {
  if (!blocks.some((b) => covers(b, date))) return null;
  let until = date;
  for (;;) {
    const next = addDays(until, 1);
    let furthest = until;
    for (const b of blocks) {
      const end = b.endDate.slice(0, 10);
      if ((covers(b, until) || covers(b, next)) && end > furthest) {
        furthest = end;
      }
    }
    if (furthest === until) return until;
    until = furthest;
  }
}

export function summariseAvailability(
  input: SummaryInput,
): AvailabilitySummary {
  const horizon = input.horizonDays ?? AVAILABILITY_HORIZON_DAYS;
  const clock = platformClock(input.now);
  const slots = [...input.slots]
    .map((s) => ({
      dayOfWeek: s.dayOfWeek,
      startTime: toClock(s.startTime),
      endTime: toClock(s.endTime),
    }))
    .sort((a, b) => a.startTime.localeCompare(b.startTime));
  const bookings = (input.bookings ?? []).map((b) => ({
    date: b.scheduledDate.slice(0, 10),
    startTime: toClock(b.startTime),
    endTime: toClock(b.endTime),
  }));

  const hasWorkingHours = slots.length > 0;
  const onTimeOffUntil = timeOffUntil(input.blocks, clock.date);
  const todayHours = slots
    .filter((s) => s.dayOfWeek === clock.dayOfWeek)
    .map((s) => ({ startTime: hhmm(s.startTime), endTime: hhmm(s.endTime) }));

  let nextAvailableDate: string | null = null;
  for (let i = 0; i < horizon && hasWorkingHours; i++) {
    const date = addDays(clock.date, i);
    if (input.blocks.some((b) => covers(b, date))) continue;
    const dow = dayOfWeekOf(date);
    const taken = bookings.filter((b) => b.date === date);
    let open = slots
      .filter((s) => s.dayOfWeek === dow)
      .flatMap((s) => subtractOccupied(s.startTime, s.endTime, taken));
    if (i === 0) open = open.filter((w) => w.endTime > clock.time);
    if (open.length > 0) {
      nextAvailableDate = date;
      break;
    }
  }

  let state: EffectiveAvailabilityState;
  if (input.status === String(AvailabilityStatus.UNAVAILABLE)) {
    state = 'unavailable';
  } else if (input.status === String(AvailabilityStatus.BUSY)) {
    state = 'busy';
  } else if (!hasWorkingHours) {
    state = 'no_hours';
  } else if (onTimeOffUntil) {
    state = 'on_time_off';
  } else if (nextAvailableDate === clock.date) {
    state = 'available_today';
  } else {
    state = 'next_available';
  }

  return {
    state,
    today: clock.date,
    hasWorkingHours,
    onTimeOffUntil,
    todayHours,
    nextAvailableDate,
    bookable:
      (state === 'available_today' ||
        state === 'next_available' ||
        state === 'on_time_off') &&
      nextAvailableDate !== null,
  };
}

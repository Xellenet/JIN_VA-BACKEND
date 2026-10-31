/**
 * X5: a booking's calendar date in words, e.g. `2026-07-07` →
 * `Tuesday 7 July 2026`.
 *
 * A booking date is a date-only string (Postgres `date`). It is parsed as a
 * **UTC calendar day** and formatted in UTC, so the weekday can never drift
 * with the server's time zone (Accra is UTC+0 with no DST). Anything that is
 * not a valid `YYYY-MM-DD` (or a Date) is returned unchanged, never "Invalid
 * Date".
 */
const WEEKDAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

export function formatBookingDate(
  value: string | Date | null | undefined,
): string {
  if (value === null || value === undefined) return '';
  let d: Date;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return '';
    d = new Date(
      Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()),
    );
  } else {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value).trim());
    if (!m) return String(value);
    const [y, mo, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
    d = new Date(Date.UTC(y, mo - 1, day));
    // Reject impossible dates such as 2026-02-31 rather than rolling over.
    if (d.getUTCMonth() !== mo - 1 || d.getUTCDate() !== day) {
      return String(value);
    }
  }
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

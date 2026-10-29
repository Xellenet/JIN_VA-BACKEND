/**
 * A real 24-hour clock time, 00:00–23:59. QA AV-02: the old `\d{2}:\d{2}`
 * check let values like 25:99 through to Postgres, which rejected them with
 * a 500 instead of a 400.
 */
export const HH_MM_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

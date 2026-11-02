/**
 * Customer experience v2 (B10): CSV cells for the spending export.
 *
 * Formula safety (SEC-27, T-7): a spreadsheet treats a cell starting with
 * `=`, `+`, `-` or `@` (and, in some apps, a leading tab or carriage return)
 * as a formula. Job titles, artisan names and references are typed by other
 * people, so every **text** cell that starts with one of those gets a leading
 * `'`. Then RFC 4180 quoting: a cell holding a comma, quote, CR or LF is
 * wrapped in `"` with inner quotes doubled.
 *
 * Numbers go through `csvNumber`, unprefixed: money in this file is never
 * negative, and a prefixed number would stop being a number.
 */
const FORMULA_START = /^[=+\-@\t\r]/;
const NEEDS_QUOTES = /[",\r\n]/;

export function csvCell(value: string | null | undefined): string {
  if (value === null || value === undefined) return '';
  let text = String(value);
  if (FORMULA_START.test(text)) text = `'${text}`;
  if (NEEDS_QUOTES.test(text)) text = `"${text.replace(/"/g, '""')}"`;
  return text;
}

/** A plain number/money cell (e.g. `2400.00`), never prefixed. */
export function csvNumber(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  return String(value);
}

/** One CSV line, CRLF-terminated as RFC 4180 asks. */
export function csvLine(cells: string[]): string {
  return `${cells.join(',')}\r\n`;
}

/** UTF-8 byte order mark, so Excel opens the file as UTF-8 (GH₵, names). */
export const CSV_BOM = '﻿';

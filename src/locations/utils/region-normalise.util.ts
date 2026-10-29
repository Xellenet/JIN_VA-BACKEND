import { REGIONS_BY_COUNTRY } from '../data/regions.data';

/** LOC4: " Region", " State" or " Province" at the end of a region name. */
const REGION_SUFFIX = /\s+(region|state|province)$/i;

/** Collapses runs of whitespace and trims. */
export function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/** Drops LOC4's trailing suffix: "Greater Accra Region" → "Greater Accra". */
export function stripRegionSuffix(value: string): string {
  return collapseWhitespace(value).replace(REGION_SUFFIX, '').trim();
}

/**
 * The comparison key LOC4 asks for: case- and diacritic-insensitive, suffix
 * dropped, whitespace collapsed.
 */
export function regionMatchKey(value: string): string {
  return stripRegionSuffix(value)
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase();
}

/**
 * Maps a raw upstream region onto the country's Region list.
 *
 * - Matched: the list's own spelling ("greater accra region" → "Greater Accra").
 * - Not matched, or no list for this country: the suffix-stripped text, so the
 *   frontend can still show it and run its own match; nothing is guessed.
 * - Empty input: `null`.
 */
export function normaliseRegion(
  raw: string | undefined | null,
  countryCode: string,
): string | null {
  if (typeof raw !== 'string') return null;
  const stripped = stripRegionSuffix(raw);
  if (!stripped) return null;

  const list = REGIONS_BY_COUNTRY[countryCode.toUpperCase()];
  if (!list) return stripped;

  const key = regionMatchKey(stripped);
  const match = list.find((entry) => regionMatchKey(entry) === key);
  return match ?? stripped;
}

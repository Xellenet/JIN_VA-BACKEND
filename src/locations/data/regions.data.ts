/**
 * LOC4/LOC7: first-level subdivisions (regions) per country, used by the
 * suggestions proxy to normalise the region Photon returns ("Greater Accra
 * Region") onto the exact spelling of the Region list the frontend shows
 * ("Greater Accra").
 *
 * Source: GeoNames, `admin1CodesASCII.txt`
 *   https://download.geonames.org/export/dump/admin1CodesASCII.txt
 * Licence: CC BY 4.0 — credit "GeoNames (geonames.org)" (design §3.4.6).
 * Retrieved: 2026-10-19 (requirements.md, verification row 24: exactly 16 GH
 * entries).
 *
 * Hand-authored from that verified list: no copy of the GeoNames file exists
 * in this repository, and this module never downloads it at runtime (LOC7: no
 * runtime calls to GeoNames).
 *
 * To regenerate or add a country (offline, no personal identifiers involved):
 *   1. Download `admin1CodesASCII.txt` from the URL above with a plain client
 *      (no account, no cookies, a generic User-Agent — PR2).
 *   2. Keep the rows whose first column starts with `<CC>.` (e.g. `GH.`); the
 *      third column is the ASCII name. Strip a trailing " Region", " State" or
 *      " Province" so the names match the frontend's `regions/<CC>.json`.
 *   3. Paste the sorted names below under the country code and update the
 *      retrieval date above.
 * It must list exactly what the frontend's `regions/<CC>.json` lists, since
 * both sides compare against it.
 *
 * Countries without an entry still get suggestions; their region text is
 * returned with only the suffix stripped (LOC4: never guessed).
 */
export const REGIONS_BY_COUNTRY: Readonly<Record<string, readonly string[]>> = {
  GH: [
    'Ahafo',
    'Ashanti',
    'Bono',
    'Bono East',
    'Central',
    'Eastern',
    'Greater Accra',
    'North East',
    'Northern',
    'Oti',
    'Savannah',
    'Upper East',
    'Upper West',
    'Volta',
    'Western',
    'Western North',
  ],
};

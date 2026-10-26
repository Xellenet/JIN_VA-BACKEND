import type { CountryCode } from 'libphonenumber-js/max';

/**
 * PH1/PH7 (google-signup-prefill): the countries whose phone numbers JinVa
 * accepts, as ISO 3166-1 alpha-2 codes.
 *
 * **The frontend keeps the identical list** (`SUPPORTED_PHONE_COUNTRIES` in
 * `jinva-frontend-web`), so the picker can never offer a country this API
 * rejects. Change both together. The same list also decides which countries
 * `/locations/suggestions` accepts and which Region files are generated.
 *
 * Launch list (requirements Q9, accepted 2026-10-19): Ghana plus the 15 other
 * West African countries the original `phone-input.tsx` offered. Adding a
 * country later is a one-line change here (and in the frontend copy).
 */
export const SUPPORTED_PHONE_COUNTRIES = [
  'GH',
  'BJ',
  'BF',
  'CV',
  'CI',
  'GM',
  'GN',
  'GW',
  'LR',
  'ML',
  'MR',
  'NE',
  'NG',
  'SN',
  'SL',
  'TG',
] as const satisfies readonly CountryCode[];

export type SupportedPhoneCountry = (typeof SUPPORTED_PHONE_COUNTRIES)[number];

/**
 * The country a phone number is read against when it is written in national
 * form (no `+`), e.g. `024 123 4567`. JinVa launches in Ghana (PH1, DI6).
 */
export const DEFAULT_PHONE_COUNTRY: SupportedPhoneCountry = 'GH';

export function isSupportedPhoneCountry(
  country: string | undefined,
): country is SupportedPhoneCountry {
  return (
    country !== undefined &&
    (SUPPORTED_PHONE_COUNTRIES as readonly string[]).includes(country)
  );
}

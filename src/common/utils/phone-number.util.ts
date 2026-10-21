import {
  parsePhoneNumberFromString,
  type CountryCode,
} from 'libphonenumber-js/max';
import {
  DEFAULT_PHONE_COUNTRY,
  isSupportedPhoneCountry,
} from '@common/constants/supported-phone-countries.constants';

/**
 * PH7 (google-signup-prefill): phone parsing shared by every DTO that accepts
 * a phone number and by the E.164 migration.
 *
 * Built on `libphonenumber-js/max`, pinned to the same exact version as the
 * frontend (PH8), so the form and the API can never disagree about a number.
 * `max` metadata is required: with `min`, `isValid()` checks length only and a
 * wrong prefix (e.g. Ghana's unassigned `025…`) would pass.
 *
 * National input (`024 123 4567`, `24 123 4567`) is read against
 * `defaultCountry`; international input (`+CC…`, or `00CC…` where the default
 * country dials out with `00`) carries its own country and ignores it.
 */

/**
 * The E.164 form of `value` (e.g. `+233241234567`) when it is a valid number,
 * otherwise `null`. Never throws.
 */
export function toE164PhoneNumber(
  value: string,
  defaultCountry: CountryCode = DEFAULT_PHONE_COUNTRY,
): string | null {
  const parsed = parsePhoneNumberFromString(value, defaultCountry);
  return parsed?.isValid() ? parsed.number : null;
}

/**
 * The `@Transform` half of PH7: normalises a submitted phone number to E.164.
 *
 * Anything it can't turn into a valid number — a non-string, an empty string,
 * garbage, an invalid number — is returned **unchanged**, so the validators
 * that run next reject it with the value the client actually sent.
 */
export function normalizePhoneNumberInput(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (trimmed === '') return value;
  return toE164PhoneNumber(trimmed) ?? value;
}

/**
 * The validator half of PH7: a valid number (length **and** number pattern,
 * per `max` metadata) whose country is in `SUPPORTED_PHONE_COUNTRIES`.
 *
 * The country check uses the country libphonenumber assigns from the number
 * range, not the calling code alone, so `+44 7911 123456` is GG, not GB.
 */
export function isSupportedPhoneNumber(
  value: unknown,
  defaultCountry: CountryCode = DEFAULT_PHONE_COUNTRY,
): boolean {
  if (typeof value !== 'string' || value.trim() === '') return false;
  const parsed = parsePhoneNumberFromString(value, defaultCountry);
  return (
    !!parsed && parsed.isValid() && isSupportedPhoneCountry(parsed.country)
  );
}

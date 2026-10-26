/**
 * PH8 (google-signup-prefill): the shared phone fixture table.
 *
 * **The frontend runs this exact table** against its own copy of
 * `libphonenumber-js` (same pinned version, `max` metadata), so the form and
 * the API cannot drift apart. Keep the two copies identical; when the library
 * is bumped (in both repos together, R11), both suites must still pass.
 *
 * `country` is the country selected in the picker (the frontend) / the
 * default country for national input (the backend, which always uses GH for
 * submitted values). `expected` is the E.164 number, or `null` when the input
 * must be rejected.
 *
 * Every number here is a fictional, illustrative value (PR3).
 */
export interface PhoneNumberFixture {
  input: string;
  country: string;
  expected: string | null;
  note: string;
}

export const PHONE_NUMBER_FIXTURES: readonly PhoneNumberFixture[] = [
  // PH2 — every accepted Ghana form gives the same E.164 number.
  {
    input: '0241234567',
    country: 'GH',
    expected: '+233241234567',
    note: 'national, trunk 0',
  },
  {
    input: '024 123 4567',
    country: 'GH',
    expected: '+233241234567',
    note: 'national, spaced',
  },
  {
    input: '24 123 4567',
    country: 'GH',
    expected: '+233241234567',
    note: 'national, no trunk 0',
  },
  {
    input: '+233 24 123 4567',
    country: 'GH',
    expected: '+233241234567',
    note: 'international',
  },
  {
    input: '+2330241234567',
    country: 'GH',
    expected: '+233241234567',
    note: 'international with trunk 0',
  },
  {
    input: '00233 24 123 4567',
    country: 'GH',
    expected: '+233241234567',
    note: '00 international prefix',
  },
  {
    input: '(024) 123-4567',
    country: 'GH',
    expected: '+233241234567',
    note: 'parentheses and dash',
  },
  {
    input: '024.123.4567',
    country: 'GH',
    expected: '+233241234567',
    note: 'dots',
  },
  {
    input: '+233241234567',
    country: 'GH',
    expected: '+233241234567',
    note: 'already E.164',
  },
  {
    input: '020-000-0001',
    country: 'GH',
    expected: '+233200000001',
    note: 'legacy seed format',
  },
  {
    input: '0302 123 456',
    country: 'GH',
    expected: '+233302123456',
    note: 'Accra landline',
  },
  // PH2 — another supported country.
  {
    input: '0803 123 4567',
    country: 'NG',
    expected: '+2348031234567',
    note: 'Nigeria, national',
  },
  {
    input: '+234 803 123 4567',
    country: 'GH',
    expected: '+2348031234567',
    note: '+CC overrides the selected country',
  },
  // Rejected.
  {
    input: '123-456-7890',
    country: 'GH',
    expected: null,
    note: 'US-style, invalid for GH',
  },
  {
    input: '024123456',
    country: 'GH',
    expected: null,
    note: 'too short (8-digit NSN)',
  },
  {
    input: '02412345678',
    country: 'GH',
    expected: null,
    note: 'too long (10-digit NSN)',
  },
  {
    input: '0251234567',
    country: 'GH',
    expected: null,
    note: 'unassigned 025 prefix',
  },
  {
    input: '+44 7911 123456',
    country: 'GH',
    expected: null,
    note: 'valid, but country not supported',
  },
  {
    input: '+1 202 555 0143',
    country: 'GH',
    expected: null,
    note: 'valid, but country not supported',
  },
  { input: 'not a number', country: 'GH', expected: null, note: 'garbage' },
  { input: '', country: 'GH', expected: null, note: 'empty' },
];

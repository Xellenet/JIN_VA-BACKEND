/**
 * Payout account lookup: the shared rules for a payout number and its
 * network or bank, used by the lookup endpoint and by the save.
 */

/** Paystack's Ghana mobile money "bank" codes: MTN, Telecel (VOD), AirtelTigo (ATL). */
export const MOBILE_MONEY_CODES = ['MTN', 'VOD', 'ATL'] as const;

export type PayoutAccountType = 'mobile_money' | 'bank';

/** 422: Paystack says the number and network/bank don't match an account. */
export const ACCOUNT_NAME_NOT_FOUND =
  "We couldn't find the name on this account. Check the number and the network or bank.";

/** 503: the lookup could not be made; the artisan can type the name. */
export const ACCOUNT_LOOKUP_UNAVAILABLE =
  "We can't look up the account name right now. You can type the name on the account instead.";

/** 400 on save: no name typed and none could be looked up. */
export const ACCOUNT_NAME_REQUIRED =
  'Enter the full name on the account (at least 2 characters).';

/** 400: a bank code that is not in the bank list. */
export const UNKNOWN_BANK = 'Choose a bank from the list.';

export const MOBILE_MONEY_NUMBER_MESSAGE =
  'Enter a 10-digit Ghana mobile money number, like 0241234567.';
export const BANK_ACCOUNT_NUMBER_MESSAGE =
  'Enter the bank account number using digits only (6 to 20 digits).';

/**
 * The canonical form of a payout number. Mobile money: separators removed and
 * a `+233`/`233`/`00233` prefix turned into the national `0` form
 * (`+233 24 123 4567` → `0241234567`). Bank: separators removed. Anything
 * else is returned unchanged, for the validator to reject.
 */
export function normalisePayoutAccountNumber(
  type: unknown,
  raw: unknown,
): unknown {
  if (typeof raw !== 'string') return raw;
  const compact = raw.trim().replace(/[\s-]+/g, '');
  if (type !== 'mobile_money') return compact;
  const intl = /^(?:\+|00)?233(\d{9,10})$/.exec(compact);
  if (!intl) return compact;
  const national = intl[1];
  if (national.length === 10)
    return national.startsWith('0') ? national : compact;
  return `0${national}`;
}

/** Mobile money: `0` + 9 digits. Bank: 6–20 digits. */
export function isValidPayoutAccountNumber(
  type: unknown,
  value: unknown,
): boolean {
  if (typeof value !== 'string') return false;
  if (type === 'mobile_money') return /^0\d{9}$/.test(value);
  if (type === 'bank') return /^\d{6,20}$/.test(value);
  return false;
}

/** Mobile money codes are upper-cased; bank codes are trimmed. */
export function normalisePayoutBankCode(type: unknown, raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  const trimmed = raw.trim();
  return type === 'mobile_money' ? trimmed.toUpperCase() : trimmed;
}

/**
 * Mobile money: one of MTN/VOD/ATL. Bank: the shape of a Paystack bank code
 * (whether it is in the bank list is checked where the list is available).
 */
export function isValidPayoutBankCode(type: unknown, value: unknown): boolean {
  if (typeof value !== 'string') return false;
  if (type === 'mobile_money') {
    return (MOBILE_MONEY_CODES as readonly string[]).includes(value);
  }
  if (type === 'bank') return /^[A-Za-z0-9]{2,20}$/.test(value);
  return false;
}

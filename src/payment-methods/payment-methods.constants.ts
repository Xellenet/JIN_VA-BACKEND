/**
 * Saved payment methods (customers): the shared rules, free of Nest so they
 * can be unit-tested directly.
 */

export const SAVED_METHOD_TYPES = ['mobile_money', 'card'] as const;
export type SavedMethodType = (typeof SAVED_METHOD_TYPES)[number];

/** Paystack's Ghana mobile money codes (as used by the name lookup). */
export const MOMO_PROVIDER_CODES = ['MTN', 'VOD', 'ATL'] as const;
export type MomoProviderCode = (typeof MOMO_PROVIDER_CODES)[number];

/**
 * The `mobile_money.provider` value Paystack's `/charge` expects for each
 * network. Paystack documents `mtn`, `vod` (Telecel) and `atl` (AirtelTigo)
 * for Ghana; confirm with a live test before launch.
 */
export const CHARGE_PROVIDER: Record<MomoProviderCode, string> = {
  MTN: 'mtn',
  VOD: 'vod',
  ATL: 'atl',
};

export const NETWORK_LABEL: Record<MomoProviderCode, string> = {
  MTN: 'MTN MoMo',
  VOD: 'Telecel Cash',
  ATL: 'AirtelTigo Money',
};

/** Most saved methods one customer can keep. */
export const MAX_SAVED_METHODS = 5;

/**
 * Ghana mobile prefixes of every network (NCA numbering plan). Numbers can
 * be ported, so any network's prefix is accepted for any network; the name
 * lookup is what tells whether the wallet is on the chosen network.
 */
export const GHANA_MOBILE_PREFIXES: readonly string[] = [
  '020',
  '023',
  '024',
  '025',
  '026',
  '027',
  '028',
  '050',
  '053',
  '054',
  '055',
  '056',
  '057',
  '059',
];

export const CUSTOMER_MOMO_NUMBER_MESSAGE =
  'Enter a 10-digit Ghana mobile number, like 0240000000.';

/** `0` + 9 digits with a Ghana mobile prefix. */
export function isGhanaMobileNumber(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^0\d{9}$/.test(value) &&
    GHANA_MOBILE_PREFIXES.includes(value.slice(0, 3))
  );
}

/** `024 ••• 4567`: the prefix and last four only. */
export function maskMobileNumber(prefix: string | null, last4: string | null) {
  return `${prefix ?? '0••'} ••• ${last4 ?? '••••'}`;
}

/** Card brand as Paystack names it (`visa `, `mastercard`), tidied. */
export function normaliseCardBrand(raw: unknown): string {
  if (typeof raw !== 'string') return 'card';
  const tidy = raw.trim().toLowerCase().replace(/\s+/g, ' ');
  return tidy ? tidy.slice(0, 30) : 'card';
}

/** Whether a card has expired by the end of its expiry month. */
export function isCardExpired(
  expMonth: number | null,
  expYear: number | null,
  now: Date = new Date(),
): boolean {
  if (!expMonth || !expYear) return false;
  const year = expYear < 100 ? 2000 + expYear : expYear;
  // First day of the month after expiry.
  const end = new Date(Date.UTC(year, expMonth, 1));
  return now.getTime() >= end.getTime();
}

/**
 * True for a body key that looks like a PIN (`pin`, `PIN`, `momoPin`,
 * `momo_pin`, `pinCode`, `pin-number`, `walletPIN`). We never take a PIN;
 * the customer approves on their phone.
 */
export function isPinLikeKey(key: string): boolean {
  const k = key.toLowerCase().replace(/[^a-z]/g, '');
  if (!k) return false;
  return (
    k === 'pin' ||
    k.startsWith('pin') ||
    k.endsWith('pin') ||
    k.includes('pincode') ||
    k.includes('pinnumber')
  );
}

/** Every PIN-like key anywhere in a JSON body (objects and arrays, any depth). */
export function findPinLikeKeys(body: unknown, depth = 0): string[] {
  if (depth > 8 || body === null || typeof body !== 'object') return [];
  const found: string[] = [];
  const entries = Array.isArray(body)
    ? body.map((v, i) => [String(i), v] as const)
    : Object.entries(body as Record<string, unknown>);
  for (const [key, value] of entries) {
    if (!Array.isArray(body) && isPinLikeKey(key)) found.push(key);
    found.push(...findPinLikeKeys(value, depth + 1));
  }
  return found;
}

export const PIN_REFUSED_MESSAGE =
  'We never ask for your PIN. You approve each payment on your phone.';

/**
 * Customer-safe text from a provider reply: short, printable, without long
 * digit runs (references, numbers) or anything that looks like an internal
 * error. `null` when nothing safe is left.
 */
export function safeProviderText(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const text = raw.replace(/\s+/g, ' ').trim();
  if (!text || text.length > 160) return null;
  if (/\d{6,}/.test(text)) return null;
  if (/[<>{}[\]`$\\]|https?:|error|exception|stack|undefined|null/i.test(text))
    return null;
  if (!/^[\p{L}\p{N}\s.,'’!?()\-:/&]+$/u.test(text)) return null;
  return text;
}

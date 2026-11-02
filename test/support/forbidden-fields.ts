/**
 * SEC-7 / SEC-8 (customer experience v2): one shared walker that every new or
 * changed customer endpoint's e2e spec runs over its response body.
 *
 * It walks every key at every depth (objects and arrays) and reports any key
 * that must never leave the API: payment-provider internals, platform fee and
 * payout figures, fraud flags, contact details and credentials. Optional
 * `forbiddenValues` catch a leak under an innocent key name, e.g. the other
 * party's phone number or email copied into a `displayName`.
 *
 * Usage in a spec:
 *
 *   expectNoForbiddenFields(res.body);
 *   expectNoForbiddenFields(res.body, { forbiddenValues: [artisanEmail] });
 *
 * Fictional data only; this file holds no real values.
 */

/** Exact key names that are never returned (compared case-insensitively). */
export const FORBIDDEN_KEYS: readonly string[] = [
  'platformFee',
  'platform_fee',
  'artisanAmount',
  'artisan_amount',
  'transferCode',
  'transfer_code',
  'transferReference',
  'transfer_reference',
  'paystackRecipientCode',
  'paystack_recipient_code',
  'accessCode',
  'access_code',
  'authorizationUrl',
  'authorization_url',
  'payoutAccountNumber',
  'payout_account_number',
  'payoutAccountName',
  'payout_account_name',
  'payoutBankCode',
  'payout_bank_code',
  'nationalId',
  'national_id',
  'password',
  'passwordHash',
  'phone',
  'phoneNumber',
  'phone_number',
  'email',
  'momoNumber',
  'momo_number',
];

/**
 * Key patterns that are never returned, whatever their exact spelling:
 * any `authorization*` field and any `fraudFlag*` / `fraud_flag*` field.
 */
export const FORBIDDEN_KEY_PATTERNS: readonly RegExp[] = [
  /^authori[sz]ation/i,
  /^fraud_?flag/i,
];

export interface ForbiddenFieldOptions {
  /** Keys that are allowed in this particular response (e.g. B5's `receiptEmail` is not `email`). */
  allowKeys?: readonly string[];
  /** Exact string values that must not appear anywhere (e.g. the artisan's phone or email). */
  forbiddenValues?: readonly string[];
}

export interface ForbiddenFieldHit {
  /** Dotted path to the offending key or value, e.g. `data[0].artisan.email`. */
  path: string;
  reason: 'key' | 'value';
}

function isForbiddenKey(key: string, allow: Set<string>): boolean {
  const lower = key.toLowerCase();
  if (allow.has(lower)) return false;
  if (FORBIDDEN_KEYS.some((k) => k.toLowerCase() === lower)) return true;
  return FORBIDDEN_KEY_PATTERNS.some((re) => re.test(key));
}

/**
 * Returns every forbidden key or value in `body`, with its path. An empty
 * array means the response is clean.
 */
export function findForbiddenFields(
  body: unknown,
  options: ForbiddenFieldOptions = {},
): ForbiddenFieldHit[] {
  const allow = new Set((options.allowKeys ?? []).map((k) => k.toLowerCase()));
  const values = (options.forbiddenValues ?? []).filter(
    (v) => typeof v === 'string' && v.length > 0,
  );
  const hits: ForbiddenFieldHit[] = [];
  const seen = new Set<unknown>();

  const walk = (node: unknown, path: string): void => {
    if (node === null || node === undefined) return;
    if (typeof node === 'string') {
      if (values.some((v) => node.includes(v))) {
        hits.push({ path: path || '(root)', reason: 'value' });
      }
      return;
    }
    if (typeof node !== 'object') return;
    if (seen.has(node)) return;
    seen.add(node);

    if (Array.isArray(node)) {
      node.forEach((item, i) => walk(item, `${path}[${i}]`));
      return;
    }
    for (const [key, value] of Object.entries(
      node as Record<string, unknown>,
    )) {
      const childPath = path ? `${path}.${key}` : key;
      if (isForbiddenKey(key, allow)) {
        hits.push({ path: childPath, reason: 'key' });
      }
      walk(value, childPath);
    }
  };

  walk(body, '');
  return hits;
}

/**
 * Jest assertion form of `findForbiddenFields`: fails listing every offending
 * path, so one run shows the whole leak rather than the first key.
 */
export function expectNoForbiddenFields(
  body: unknown,
  options: ForbiddenFieldOptions = {},
): void {
  const hits = findForbiddenFields(body, options);
  if (hits.length) {
    throw new Error(
      `Forbidden fields in response (SEC-7/SEC-8):\n` +
        hits.map((h) => `  - ${h.path} (${h.reason})`).join('\n'),
    );
  }
}

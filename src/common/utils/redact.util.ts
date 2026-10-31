/**
 * SEC-31: keys whose values never reach a log line, at any depth. Matched
 * case-insensitively against the exact key name; see
 * {@link REDACTED_LOG_KEY_PREFIXES} for the prefix matches.
 *
 * Only structured log metadata is redacted. The `message` string itself is
 * passed through untouched, so callers must never interpolate these values
 * into a log message.
 */
export const REDACTED_LOG_KEYS: readonly string[] = Object.freeze([
  'password',
  'currentPassword',
  'code',
  'otp',
  'momoNumber',
  'phoneNumber',
  'email',
  'accountNumber',
  'payoutAccountNumber',
  'payout_account_number',
  'authorization',
  'authorization_code',
  'authorization_url',
  'access_code',
  'card',
  'nationalId',
]);

/** What a redacted value is replaced with. */
export const REDACTED = '[redacted]';

/**
 * SEC-31 `momo_number*`: any key starting with one of these (case-insensitive)
 * is redacted too, e.g. `momo_number_encrypted` or `momoNumberLast4`.
 */
export const REDACTED_LOG_KEY_PREFIXES: readonly string[] = Object.freeze([
  'momo_number',
  'momonumber',
]);

const KEYS = new Set(REDACTED_LOG_KEYS.map((key) => key.toLowerCase()));

/** Deeper than this, a value is left as it is (log metadata is shallow). */
const MAX_DEPTH = 8;

export function isRedactedKey(key: string): boolean {
  const lower = key.toLowerCase();
  return (
    KEYS.has(lower) ||
    REDACTED_LOG_KEY_PREFIXES.some((prefix) => lower.startsWith(prefix))
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

function walk(value: unknown, depth: number, seen: WeakMap<object, unknown>) {
  if (depth > MAX_DEPTH) return value;
  if (Array.isArray(value)) {
    if (seen.has(value)) return seen.get(value);
    const out: unknown[] = [];
    seen.set(value, out);
    for (const item of value) out.push(walk(item, depth + 1, seen));
    return out;
  }
  if (isPlainObject(value)) {
    if (seen.has(value)) return seen.get(value);
    const out: Record<string, unknown> = {};
    seen.set(value, out);
    for (const [key, inner] of Object.entries(value)) {
      out[key] = isRedactedKey(key) ? REDACTED : walk(inner, depth + 1, seen);
    }
    return out;
  }
  return value;
}

/**
 * Returns a copy of `value` with the value of every sensitive key replaced by
 * `"[redacted]"`, at any depth of plain objects and arrays. The input is never
 * mutated; anything that is not a plain object or array is returned as is.
 */
export function redactSensitive<T>(value: T): T {
  return walk(value, 0, new WeakMap()) as T;
}

/**
 * Redacts the string keys of a winston `info` object in place (its symbol
 * keys, such as the level and the formatted message, are left alone). Nested
 * values are replaced by redacted copies, so the caller's objects are never
 * mutated.
 */
export function redactLogInfo<T extends Record<string, unknown>>(info: T): T {
  const seen = new WeakMap<object, unknown>();
  for (const key of Object.keys(info)) {
    // The message text is not redacted (see REDACTED_LOG_KEYS).
    if (key === 'level' || key === 'message') continue;
    (info as Record<string, unknown>)[key] = isRedactedKey(key)
      ? REDACTED
      : walk(info[key], 1, seen);
  }
  return info;
}

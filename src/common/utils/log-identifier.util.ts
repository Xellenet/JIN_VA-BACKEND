import { createHash } from 'node:crypto';

/**
 * M5: a stable correlation key for an email address, for the two log lines
 * that have to identify *something* before any row has been resolved.
 *
 * **The rule everywhere else is simpler: log the user id.** Once a row is in
 * hand there is never a reason to write an address, and the login path now
 * doesn't. This exists only for the moments where no id exists yet — the
 * pre-lookup line in `UsersService.findUserByEmail` (which every
 * authenticated request reaches through `JwtStrategy.validate`) and the entry
 * line in `AuthService.loginUser` — where logging nothing at all would leave
 * a failed login with no way to correlate its lines.
 *
 * Why it matters: `winstonConfig` has a Console transport only, so every line
 * lands in the hosting platform's log store under whatever retention it has.
 * An address written there outlives the C1.7 purge that overwrites
 * `users.email` with an irreversible placeholder, which made "no recoverable
 * PII after purge" true of the database and not of the logs.
 *
 * What this is and is not:
 * - it is **deterministic**, so one account's lines can be followed across a
 *   request and an operator who already knows an address can recompute the
 *   key and search for it;
 * - it is **not** a privacy guarantee against a targeted check — an
 *   unsalted hash of a known address is reproducible by anyone, which is why
 *   it is truncated and why no line pairs it with anything sensitive (never
 *   "this address has a soft-deleted account", which was M5's original leak);
 * - it carries **no account state**. It is computed from the submitted string
 *   before any lookup, so it is identical for a registered and an
 *   unregistered address and cannot become an enumeration oracle.
 *
 * Normalised (trimmed, lowercased) so the same address typed two ways
 * produces one key.
 */
export function hashEmailForLog(email: string): string {
  return createHash('sha256')
    .update(email.trim().toLowerCase())
    .digest('hex')
    .slice(0, 12);
}

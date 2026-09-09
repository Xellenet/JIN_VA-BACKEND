/**
 * The named throttlers the application configures (in `ThrottlingModule`). A
 * guard scopes itself to exactly one of these by name (see
 * `NamedThrottlerGuard`), and a route opts in by attaching that guard.
 *
 * Names are shared constants rather than inline strings because a typo between
 * the config and a guard would silently disable that guard's limit — the sort
 * of failure nothing else in the system would surface. `NamedThrottlerGuard`
 * additionally fails at bootstrap if its name matches nothing configured.
 *
 * Kept in its own file so a guard can reference a name without importing the
 * module that configures it.
 */
export const THROTTLER_NAMES = {
  /** RL1: per-sender limit on `POST /messages`. */
  MESSAGE_SEND: 'message-send',
  /**
   * Endpoints where a caller submits a secret (a password, or a one-time
   * token) and the response differs depending on whether the secret was
   * right — i.e. anything that can be brute-forced.
   */
  AUTH_CREDENTIALS: 'auth-credentials',
  /**
   * Unauthenticated endpoints whose side effect is *sending an email* to an
   * address the caller supplies. The abuse here isn't guessing a secret, it's
   * volume: signup spam, and using someone else's address as a mail-bomb
   * target. Stricter than the credential limit because no legitimate client
   * needs to trigger several of these a minute.
   */
  AUTH_EMAIL: 'auth-email',
} as const;

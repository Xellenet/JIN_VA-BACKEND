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
  /**
   * The two authenticated dispute writes that change a dispute's state:
   * `POST /disputes/:id/respond` (a party's one-shot response) and
   * `PATCH /admin/disputes/:id/resolve` (an admin's ruling, which can move
   * money). Defence in depth behind the atomic write guards those two
   * endpoints now have — unlimited attempts are what made their races
   * practically huntable.
   */
  DISPUTE_WRITE: 'dispute-write',
  /**
   * Customer Experience v2: the customer's read-only aggregates (job summary,
   * overview rail, spending analytics, paginated payment history and its
   * filter options). Each query is a handful of aggregates scoped to the
   * caller, so the limit only stops a script from hammering them.
   */
  CUSTOMER_ANALYTICS: 'customer-analytics',
  /** `GET /payments/history/export.csv`: a streamed export of up to 10,000 rows. */
  CUSTOMER_EXPORT: 'customer-export',
  /** `PATCH /users/me/payment-settings`. */
  PAYMENT_SETTINGS_WRITE: 'payment-settings-write',
  /**
   * The profile-photo writes: `POST /users/me/avatar`, `POST /uploads/avatar`
   * and `DELETE /users/me/avatar`. Each upload costs storage and processing.
   */
  PROFILE_MEDIA_WRITE: 'profile-media-write',
  /** `GET /notifications/:id`. */
  NOTIFICATION_READ: 'notification-read',
  /**
   * Artisan fixes: the artisan's read-only aggregates (overview, earnings
   * statement, analytics, review summary) and the cached bank list.
   */
  ARTISAN_INSIGHTS: 'artisan-insights',
  /** `GET /payments/my-earnings/export.csv`: a streamed export of up to 10,000 rows. */
  ARTISAN_EXPORT: 'artisan-export',
  /**
   * `POST /payments/payout-method/resolve` and `POST /payments/payout-method`.
   * Each call is a Paystack account name lookup, which reveals who owns a
   * number, so the limit is low enough to make enumeration impractical.
   */
  PAYOUT_ACCOUNT_LOOKUP: 'payout-account-lookup',
  /**
   * Saved payment methods: `POST /users/me/payment-methods/resolve` and
   * `POST /users/me/payment-methods/mobile-money`. Each is a name lookup, so
   * the limit is as low as the payout lookup's.
   */
  PAYMENT_METHOD_LOOKUP: 'payment-method-lookup',
  /** `PATCH .../payment-methods/:id/default` and `DELETE .../payment-methods/:id`. */
  PAYMENT_METHODS_WRITE: 'payment-methods-write',
  /** `POST /payments/:jobId/charge` and `POST /payments/charges/:reference/otp`. */
  PAYMENT_CHARGE: 'payment-charge',
  /** `GET /payments/charges/:reference/status` (polled while waiting). */
  PAYMENT_CHARGE_STATUS: 'payment-charge-status',
  /** `GET /admin/analytics/insights` (admin platform insights). */
  ADMIN_INSIGHTS: 'admin-insights',
} as const;

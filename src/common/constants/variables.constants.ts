export const VARIABLES = {
  /** SECURITY CONSTANTS */
  SALT_OR_ROUNDS: 12,
  PASSWORD_REGEX:
    /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*])[A-Za-z\d!@#$%^&*]{8,128}$/,
  PHONENUMBER_REGEX: /^\d{3}-\d{3}-\d{4}$/,
  TOKEN_EXAMPLE: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
  EMAIL_VERIFICATION_TOKEN_EXPIRES_IN_MINUTES: 7,
  PASSWORD_RESET_TOKEN_EXPIRES_IN_MINUTES: 60,
  ACCESS_TOKEN_EXPIRES_IN_MINUTES: 15,
  REFRESH_TOKEN_EXPIRES_IN_DAYS: 7,
  RESEND_VERIFICATION_COOLDOWN_SECONDS: 60,
  SOFT_DELETE_RETENTION_DAYS: 30,

  /** COOKIE CONSTANTS */
  REFRESH_TOKEN_COOKIE_NAME: 'refresh_token',
  /**
   * S2: second, non-sensitive HttpOnly cookie carrying only `{ sub, role }` so
   * Next.js middleware can enforce auth/role at the edge without ever touching
   * the (memory-only) access token. HMAC-signed (see `session-cookie.util.ts`),
   * NOT a bearer-usable JWT — it is signed with a dedicated secret the API's
   * JwtStrategy does not accept, so it cannot be replayed as an access token.
   */
  AUTH_SESSION_COOKIE_NAME: 'jinva_session',

  /** SOCIAL LOGIN CONSTANTS */
  GOOGLE_AUTHORIZATION_URL: 'https://accounts.google.com/o/oauth2/v2/auth',
  GOOGLE_TOKEN_URL: 'https://oauth2.googleapis.com/token',
  GOOGLE_USERINFO_URL: 'https://www.googleapis.com/oauth2/v3/userinfo',
  GOOGLE_PROVIDER_NAME: 'google',
  STATE_EXPIRY_MS: 10 * 60 * 1000,
  /**
   * G4/G7: frontend route that receives the browser after
   * `GET /auth/google/callback` completes (success or failure). Documented
   * in `docs/team/google-oauth-fix/api-contract.md` for the frontend-engineer.
   */
  OAUTH_FRONTEND_LANDING_PATH: '/auth/callback',

  /** BOOKING / JOB LIFECYCLE CONSTANTS (availability-booking-job-lifecycle remediation) */
  /** A2: used when a service has no `estimatedDurationMins` configured yet. */
  DEFAULT_SERVICE_DURATION_MINS: 60,
  /** A2: server-side sanity bounds for `estimatedDurationMins`. */
  MIN_SERVICE_DURATION_MINS: 5,
  MAX_SERVICE_DURATION_MINS: 480,
  /** A5: PENDING bookings older than this auto-expire. */
  BOOKING_EXPIRY_HOURS: 24,
  /** A9: max simultaneous PENDING bookings a single customer may hold against one artisan. */
  MAX_PENDING_BOOKINGS_PER_ARTISAN: 3,
  /** J2: IN_PROGRESS jobs with completionRequestedAt older than this auto-complete. */
  JOB_AUTO_COMPLETE_HOURS: 48,
  /** A7: reminder cron polling interval, and the size of each milestone's detection band. */
  REMINDER_POLL_MINUTES: 30,
  REMINDER_24H_HOURS: 24,
  REMINDER_2H_HOURS: 2,
  /**
   * Security report (Low, CWE-840): `agreedPrice` on `POST /bookings` must
   * stay within this tolerance band of `Service.price` (when the service has
   * one set) so a customer can't submit an arbitrary price now that would
   * later be trusted as the payment-capture amount once booking-derived jobs
   * are wired to `PaymentsService.holdPayment`. Expressed as a fraction of
   * the catalog price (0.2 = ±20%).
   */
  AGREED_PRICE_TOLERANCE_RATIO: 0.2,

  /** REVIEWS / RATINGS / FAVOURITES CONSTANTS */
  /** RE1: a review may only be edited by its original author within this many hours of `createdAt`. */
  REVIEW_EDIT_WINDOW_HOURS: 48,
  /** RP1: max photos per review and max size per photo. */
  REVIEW_MAX_PHOTOS: 3,
  REVIEW_MAX_PHOTO_SIZE_MB: 5,
  /** AR1: artisan reply is a short, one-time public response. */
  REVIEW_REPLY_MIN_LENGTH: 1,
  REVIEW_REPLY_MAX_LENGTH: 300,
  /** FL1: required reason when flagging a review. */
  REVIEW_FLAG_REASON_MIN_LENGTH: 10,
  REVIEW_FLAG_REASON_MAX_LENGTH: 500,
  /** AM3: required reason when an admin permanently removes a review. */
  REVIEW_MODERATION_REASON_MIN_LENGTH: 10,
  REVIEW_MODERATION_REASON_MAX_LENGTH: 1000,
  /** AM5: how much of the review text is snapshotted into the moderation log. */
  REVIEW_MODERATION_SNAPSHOT_EXCERPT_LENGTH: 200,
  /**
   * RA2: Bayesian weighted-rating (IMDb-style) tuning knobs.
   * `WR = (v / (v + m)) * R + (m / (v + m)) * C`
   * `m` — minimum-votes prior: how many reviews it takes before an artisan's
   * own average (R) dominates the platform mean (C). A formula constant, not
   * stored data — tune here as the platform's review volume grows.
   */
  RATING_BAYESIAN_MIN_VOTES: 10,
  /**
   * Fallback platform mean (`C`) used only until `PlatformRatingCacheService`
   * completes its first computation (e.g. immediately after a cold start) or
   * when zero reviews exist platform-wide yet. The neutral midpoint of the
   * 1–5 scale.
   */
  PLATFORM_MEAN_DEFAULT_RATING: 3,
};

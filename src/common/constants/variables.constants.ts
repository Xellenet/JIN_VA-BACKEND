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
};

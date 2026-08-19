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
};

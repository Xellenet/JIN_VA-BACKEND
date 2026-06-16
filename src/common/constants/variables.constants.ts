export const VARIABLES = {

    /** SECURITY CONSTANTS */
    SALT_OR_ROUNDS: 12,
    PASSWORD_REGEX: /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*])[A-Za-z\d!@#$%^&*]{8,128}$/,
    PHONENUMBER_REGEX: /^\d{3}-\d{3}-\d{4}$/,
    TOKEN_EXAMPLE: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
    EMAIL_VERIFICATION_TOKEN_EXPIRES_IN_MINUTES: 7,
    PASSWORD_RESET_TOKEN_EXPIRES_IN_MINUTES: 15,
    ACCESS_TOKEN_EXPIRES_IN_MINUTES: 15,
    REFRESH_TOKEN_EXPIRES_IN_DAYS: 7,

    /** SOCIAL LOGIN CONSTANTS */
    GOOGLE_OAUTH_REDIRECT_URI: 'http://localhost:3000/auth/google/callback',
    GOOGLE_AUTHORIZATION_URL: 'https://accounts.google.com/o/oauth2/v2/auth',
    GOOGLE_TOKEN_URL: 'https://oauth2.googleapis.com/token',
    GOOGLE_USERINFO_URL: 'https://www.googleapis.com/oauth2/v3/userinfo',
    GOOGLE_PROVIDER_NAME: 'google',
    STATE_EXPIRY_MS: 10 * 60 * 1000,

}

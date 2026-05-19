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

    /** USER FEEDBACK CONSTANTS */
    USER_LOGGED_IN: 'User logged in successfully',
    USER_REGISTERED: 'User registered successfully',
    EMAIL_VERIFIED: 'Email verified successfully',
    PASSWORD_RESET_EMAIL_SENT: 'Password reset link sent to your email',
    PASSWORD_RESET_SUCCESS: 'Password reset successfully',
    TOKENS_REFRESHED: 'Tokens refreshed successfully',
    PASSWORD_CHANGED_SUCCESSFULLY: 'Password changed successfully',


    /** SOCIAL LOGIN CONSTANTS */
    GOOGLE_OAUTH_REDIRECT_URI: 'http://localhost:3000/auth/google/callback',
    GOOGLE_AUTHORIZATION_URL: 'https://accounts.google.com/o/oauth2/v2/auth',
    GOOGLE_TOKEN_URL: 'https://oauth2.googleapis.com/token',
    GOOGLE_USERINFO_URL: 'https://www.googleapis.com/oauth2/v3/userinfo',
    GOOGLE_PROVIDER_NAME: 'google',
    STATE_EXPIRY_MS: 10 * 60 * 1000,

    /** SERVICE FEEDBACK CONSTANTS */
    SERVICE_CREATED: 'Service created successfully',
    SERVICE_UPDATED: 'Service updated successfully',
    SERVICE_DELETED: 'Service deleted successfully',
    SERVICE_NOT_FOUND: 'Service not found',
    ALL_SERVICES_RETRIEVED: 'All services retrieved successfully',
    SERVICE_RETRIEVED: 'Service retrieved successfully',
}

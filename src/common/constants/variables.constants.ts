export const VARIABLES = {
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

}
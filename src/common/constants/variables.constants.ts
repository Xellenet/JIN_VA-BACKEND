export const VARIABLES = {
    SALT_OR_ROUNDS: 12,
    PASSWORD_REGEX: /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*])[A-Za-z\d!@#$%^&*]{8,128}$/,
    PHONENUMBER_REGEX: /^\d{3}-\d{3}-\d{4}$/,
    TOKEN_EXAMPLE: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',

    /** USER FEEDBACK CONSTANTS */
    USER_LOGGED_IN: 'User logged in successfully',
    USER_REGISTERED: 'User registered successfully',
}
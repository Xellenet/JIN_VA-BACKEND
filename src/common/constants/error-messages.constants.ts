export const ERROR_MESSAGES = {
  USER: {
    EMAIL_REQUIRED: 'Email is required',
    NOT_FOUND_WITH_EMAIL: (email: string) => `User with email ${email} not found`,
    NOT_FOUND_WITH_ID: (email: string) => `User with email ${email} not found`,
    EMAIL_ALREADY_EXISTS: (email:string) => `User with email ${email} exists already`
  },
  AUTH: {
    INVALID_CREDENTIALS: 'Invalid email or password',
    UNAUTHORIZED: 'Unauthorized access',
  },
  // Add more categories as needed
};
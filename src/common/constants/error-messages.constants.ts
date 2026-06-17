export const ERROR_MESSAGES = {
  USER: {
    EMAIL_REQUIRED: 'Email is required',
    NOT_FOUND_WITH_EMAIL: (email: string) => `User with email ${email} not found`,
    NOT_FOUND_WITH_ID: (id: string) => `User with id ${id} not found`,
    EMAIL_ALREADY_EXISTS: (email:string) => `User with email ${email} exists already`
  },
  AUTH: {
    INVALID_CREDENTIALS: 'Invalid email or password',
    UNAUTHORIZED: 'Unauthorized access',
  },
  REVIEW: {
    JOB_NOT_FOUND: 'Job not found.',
    JOB_NOT_COMPLETED: 'You can only review an artisan after the job is marked as completed.',
    NOT_JOB_CUSTOMER: 'You can only review the artisan for jobs you posted.',
    DUPLICATE: 'You have already submitted a review for this job.',
    JOB_NO_ARTISAN: 'This job does not have an accepted artisan to review.',
  },
};
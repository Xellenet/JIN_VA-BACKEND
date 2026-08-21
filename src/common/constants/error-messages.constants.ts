export const ERROR_MESSAGES = {
  USER: {
    EMAIL_REQUIRED: 'Email is required',
    NOT_FOUND_WITH_EMAIL: (email: string) =>
      `User with email ${email} not found`,
    NOT_FOUND_WITH_ID: (id: string) => `User with id ${id} not found`,
    EMAIL_ALREADY_EXISTS: (email: string) =>
      `User with email ${email} exists already`,
  },
  AUTH: {
    INVALID_CREDENTIALS: 'Invalid email or password',
    UNAUTHORIZED: 'Unauthorized access',
    EMAIL_NOT_VERIFIED: 'Please verify your email before logging in.',
    ROLE_NOT_ALLOWED: 'Only CUSTOMER or ARTISAN accounts may self-register.',
    INVALID_REFRESH_TOKEN: 'Invalid or expired refresh token',
    RESTORE_INVALID_CREDENTIALS:
      'Unable to restore this account with the provided credentials.',
    RESTORE_WINDOW_EXPIRED:
      'This account can no longer be restored — the 30-day recovery window has passed.',
    PASSWORDS_DO_NOT_MATCH: 'newPassword and confirmNewPassword do not match',
    // G10: distinct from INVALID_CREDENTIALS so the frontend can render a
    // specific message (and a "Continue with Google" shortcut) instead of
    // folding this into the generic invalid-credentials toast.
    SOCIAL_ONLY_ACCOUNT:
      'This account signs in with Google. Continue with Google, or use "Forgot password" to set a password for this account.',
  },
  REVIEW: {
    JOB_NOT_FOUND: 'Job not found.',
    JOB_NOT_COMPLETED:
      'You can only review an artisan after the job is marked as completed.',
    NOT_JOB_CUSTOMER: 'You can only review the artisan for jobs you posted.',
    DUPLICATE: 'You have already submitted a review for this job.',
    JOB_NO_ARTISAN: 'This job does not have an accepted artisan to review.',
    NOT_FOUND: (id: number) => `Review with id ${id} not found.`,
    NO_FIELDS_TO_UPDATE:
      'Provide a rating and/or review text to update.',
    NOT_REVIEW_OWNER: 'You can only edit your own review.',
    EDIT_WINDOW_EXPIRED:
      'This review can no longer be edited — the 48-hour edit window has passed.',
    NOT_REVIEWED_ARTISAN:
      'You can only reply to reviews written about you.',
    ALREADY_REPLIED: 'This review already has a reply.',
    ALREADY_FLAGGED_BY_YOU: 'You have already flagged this review.',
    NOT_FLAGGED: 'Only a flagged review can be restored.',
  },
};

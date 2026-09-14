/**
 * Joins already-phrased clauses into readable prose: `a`, `a and b`,
 * `a, b and c`. Used by messages that enumerate several blocking conditions
 * in one sentence.
 */
function joinClauses(clauses: string[]): string {
  if (clauses.length <= 1) return clauses[0] ?? '';
  return `${clauses.slice(0, -1).join(', ')} and ${clauses[clauses.length - 1]}`;
}

export const ERROR_MESSAGES = {
  USER: {
    EMAIL_REQUIRED: 'Email is required',
    NOT_FOUND_WITH_EMAIL: (email: string) =>
      `User with email ${email} not found`,
    NOT_FOUND_WITH_ID: (id: string) => `User with id ${id} not found`,
    EMAIL_ALREADY_EXISTS: (email: string) =>
      `User with email ${email} exists already`,
    /**
     * C1.1: deletion is refused (409) while the account still has live
     * commitments. `blockers` are already-phrased clauses (see
     * `AccountCommitmentsService`), joined here so the user reads one sentence
     * that names everything outstanding rather than discovering blockers one
     * retry at a time. Deliberately amount-free — it names the blocking
     * items, never a figure, so no currency ever has to be formatted here.
     */
    DELETION_BLOCKED: (blockers: string[]) =>
      `Your account can't be deleted yet — ${joinClauses(blockers)}. ` +
      `Resolve these first, then try again.`,
    /**
     * L4: the deletion that cannot be undone by resolving anything. An ADMIN
     * account is seed-only (S3 blocks the role on public registration) and
     * there is no admin tooling to view, restore or force-purge a deleted
     * account, so an admin who self-deletes leaves the platform with no
     * administrative capability for 30 days and then permanently.
     *
     * Phrased as the consequence, not as a count: it deliberately does not
     * say how many admin accounts exist. Amount-free and digit-free like the
     * live-commitments refusal, and it follows the same "Your account can't
     * be deleted …, then try again." shape so any surface rendering a backend
     * refusal verbatim shows something sensible.
     */
    DELETION_BLOCKED_LAST_ADMIN:
      `Your account can't be deleted — deleting it would leave JinVa without ` +
      `an administrator. Another administrator account has to be in place ` +
      `first, then try again.`,
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
    /**
     * C1.7/C1.8: the purge job has already scrubbed this account. Returned
     * only to a caller that had already proven ownership before the purge
     * committed (the purge-vs-restore race) — a cold restore attempt on a
     * purged account gets `RESTORE_INVALID_CREDENTIALS`, which is
     * indistinguishable from a never-registered email.
     */
    ACCOUNT_PERMANENTLY_DELETED:
      'This account has been permanently deleted and can no longer be restored. Please create a new account.',
    /**
     * C1.4: the distinguishable pending-deletion login rejection. Only ever
     * returned *after* the submitted password has been verified.
     */
    ACCOUNT_PENDING_DELETION:
      'This account is scheduled for deletion. You can still restore it before the recovery window closes.',
    /**
     * L1: a soft-deleted account that was never a social-login account cannot
     * be restored by completing Google sign-in — that proves control of the
     * mailbox, which is not ownership proof for an account whose credential
     * was a password. Its owner restores it with `POST /auth/restore-account`
     * (or by signing in and using the pending-deletion banner) as normal.
     *
     * Never rendered to a user as it stands: `GET /auth/google/callback`
     * catches every failure and redirects to the frontend's existing generic
     * OAuth error page. It exists so the refusal is an explicit, logged
     * decision rather than a unique-constraint violation from a duplicate
     * insert, which is what the callback would otherwise fail on.
     */
    SOCIAL_RESTORE_NOT_AVAILABLE:
      'This account cannot be restored through Google sign-in. Sign in with your password to restore it.',
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
    NO_FIELDS_TO_UPDATE: 'Provide a rating and/or review text to update.',
    NOT_REVIEW_OWNER: 'You can only edit your own review.',
    EDIT_WINDOW_EXPIRED:
      'This review can no longer be edited — the 48-hour edit window has passed.',
    NOT_REVIEWED_ARTISAN: 'You can only reply to reviews written about you.',
    ALREADY_REPLIED: 'This review already has a reply.',
    ALREADY_FLAGGED_BY_YOU: 'You have already flagged this review.',
    NOT_FLAGGED: 'Only a flagged review can be restored.',
  },
};

import { HttpException, HttpStatus } from '@nestjs/common';
import { ERROR_MESSAGES } from '@common/constants/error-messages.constants';

/**
 * C1.7/C1.8: the account exists and the caller has proven ownership of it, but
 * it can never be restored — either the 30-day window closed before they
 * asked, or the purge job already scrubbed the row.
 *
 * `410 Gone` rather than a 4xx that invites a retry: this is terminal, and the
 * only remaining path is creating a new account. Both variants carry a stable
 * `meta.error` so the login form can swap its restore banner for the
 * window-closed copy; they are deliberately separate codes because "you were
 * too late" and "the data is already gone" are different facts, even though
 * the user-facing next step is the same.
 *
 * This is **not** what a cold restore attempt against a purged account
 * receives. A purged row's email has been overwritten with an irreversible
 * placeholder, so it is never found by email at all and the caller gets the
 * generic invalid-credentials response — indistinguishable from an address
 * that was never registered, per C1.7.
 */
export class AccountNotRestorableException extends HttpException {
  static readonly WINDOW_EXPIRED = 'ACCOUNT_RESTORE_WINDOW_EXPIRED';
  static readonly PERMANENTLY_DELETED = 'ACCOUNT_PERMANENTLY_DELETED';

  private constructor(message: string, errorCode: string) {
    super({ message, errorCode }, HttpStatus.GONE);
  }

  /** The 30-day window elapsed; the row has not been purged yet. */
  static windowExpired(): AccountNotRestorableException {
    return new AccountNotRestorableException(
      ERROR_MESSAGES.AUTH.RESTORE_WINDOW_EXPIRED,
      AccountNotRestorableException.WINDOW_EXPIRED,
    );
  }

  /**
   * The purge job has already scrubbed this row. Raised when a restore loses
   * the race against a concurrent purge (C1.7's edge case) — the restore fails
   * cleanly with this instead of a 500 or, far worse, a half-anonymized row
   * that is somehow authenticable again.
   */
  static permanentlyDeleted(): AccountNotRestorableException {
    return new AccountNotRestorableException(
      ERROR_MESSAGES.AUTH.ACCOUNT_PERMANENTLY_DELETED,
      AccountNotRestorableException.PERMANENTLY_DELETED,
    );
  }
}

import { HttpException, HttpStatus } from '@nestjs/common';
import { ERROR_MESSAGES } from '@common/constants/error-messages.constants';

/**
 * C1.4: thrown by `AuthService.loginUser()` when the submitted credentials are
 * **correct** but the account is soft-deleted and still inside its 30-day
 * recovery window.
 *
 * Three properties of this exception are load-bearing and must not be relaxed:
 *
 * 1. **It is only ever thrown after the password has been verified.** Throwing
 *    it on the strength of the email alone would turn login into an
 *    account-enumeration oracle — the same trap `resendVerification()` was
 *    hardened against in F1. A wrong password on a soft-deleted account, and a
 *    login attempt on an address that was never registered, both surface as
 *    the generic `InvalidCredentialsException`.
 * 2. **It issues no tokens and sets no cookies.** It is a rejection, not a
 *    degraded success: the account is not authenticable until it is restored.
 * 3. **It is distinct from `InvalidCredentialsException`** (403 + a stable
 *    `meta.error` of `ACCOUNT_PENDING_DELETION`) so the login form can render
 *    the restore prompt instead of a wrong-password toast.
 *
 * `deletedAt` and `restorableUntil` ride along in `meta.details` so the client
 * prints real dates from the server rather than computing "+30 days" itself
 * and drifting from whatever the purge job actually enforces.
 */
export class AccountPendingDeletionException extends HttpException {
  static readonly ERROR_CODE = 'ACCOUNT_PENDING_DELETION';

  constructor(deletedAt: Date, restorableUntil: Date) {
    super(
      {
        message: ERROR_MESSAGES.AUTH.ACCOUNT_PENDING_DELETION,
        errorCode: AccountPendingDeletionException.ERROR_CODE,
        details: {
          deletedAt: deletedAt.toISOString(),
          restorableUntil: restorableUntil.toISOString(),
        },
      },
      HttpStatus.FORBIDDEN,
    );
  }
}

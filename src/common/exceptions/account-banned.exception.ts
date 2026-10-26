import { HttpException, HttpStatus } from '@nestjs/common';
import { ERROR_MESSAGES } from '@common/constants/error-messages.constants';

/**
 * QA AUTH-17 / ADM-04: a banned account used to receive fresh tokens at login
 * and refresh, then be bounced back to /login with no explanation. Login,
 * refresh, Google sign-in and every authenticated request now refuse it with
 * this one machine-readable response so the frontend can say why.
 */
export class AccountBannedException extends HttpException {
  static readonly ERROR_CODE = 'ACCOUNT_BANNED';

  constructor() {
    super(
      {
        message: ERROR_MESSAGES.AUTH.ACCOUNT_BANNED,
        errorCode: AccountBannedException.ERROR_CODE,
      },
      HttpStatus.FORBIDDEN,
    );
  }
}

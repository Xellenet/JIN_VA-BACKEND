import { HttpException, HttpStatus } from '@nestjs/common';
import { ERROR_MESSAGES } from '@common/constants/error-messages.constants';
import { AUTH_RATE_LIMIT_ERROR_CODE } from '../guards/auth-throttler.guard';
import type { SendReservation } from './auth-code.service';

export const CODE_INVALID_ERROR_CODE = 'CODE_INVALID';
export const CODE_ATTEMPTS_EXCEEDED_ERROR_CODE = 'CODE_ATTEMPTS_EXCEEDED';

/** 400 `CODE_INVALID` — wrong, expired, used or never sent; one message for all. */
export function codeInvalid(): HttpException {
  return new HttpException(
    {
      errorCode: CODE_INVALID_ERROR_CODE,
      message: ERROR_MESSAGES.AUTH.CODE_INVALID,
    },
    HttpStatus.BAD_REQUEST,
  );
}

/** 400 `CODE_ATTEMPTS_EXCEEDED` — the code had 5 wrong tries; ask for a new one. */
export function codeAttemptsExceeded(): HttpException {
  return new HttpException(
    {
      errorCode: CODE_ATTEMPTS_EXCEEDED_ERROR_CODE,
      message: ERROR_MESSAGES.AUTH.CODE_ATTEMPTS_EXCEEDED,
    },
    HttpStatus.BAD_REQUEST,
  );
}

/**
 * 429 for the per-email cooldown or hourly cap. Same code as the per-IP auth
 * limit (`AUTH_RATE_LIMIT_EXCEEDED`), with `meta.retryAfterSeconds` and
 * `data.resendAvailableAt`. Produced identically for an address with or
 * without an account.
 */
export function codeSendLimited(
  reservation: Extract<SendReservation, { allowed: false }>,
): HttpException {
  return new HttpException(
    {
      errorCode: AUTH_RATE_LIMIT_ERROR_CODE,
      message: ERROR_MESSAGES.AUTH.CODE_SEND_LIMITED(
        reservation.retryAfterSeconds,
      ),
      retryAfterSeconds: reservation.retryAfterSeconds,
      data: { resendAvailableAt: reservation.resendAvailableAt.toISOString() },
    },
    HttpStatus.TOO_MANY_REQUESTS,
  );
}

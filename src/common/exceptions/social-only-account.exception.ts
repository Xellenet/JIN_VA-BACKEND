import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * G10: thrown by `AuthService.loginUser()` when an account has no usable
 * password (it was created — or has only ever been used — via Google
 * sign-in) and the caller attempts an email/password login.
 *
 * Deliberately a distinct exception (and therefore a distinct
 * `meta.error: 'SocialOnlyAccountException'` in the JSON error body, via
 * `AllExceptionsFilter`) from `InvalidCredentialsException` so the frontend
 * can render a specific "use Google instead" message rather than folding it
 * into the generic invalid-credentials toast.
 */
export class SocialOnlyAccountException extends HttpException {
  constructor(message: string) {
    super(message, HttpStatus.UNAUTHORIZED);
  }
}

import { VARIABLES } from '@common/constants/variables.constants';
import { IsNotEmpty, Matches, MinLength } from 'class-validator';
import { VALIDATION_MESSAGES } from '@common/constants/validation-messages.constants';

/**
 * Body shape for `POST /auth/reset-password`. The reset token itself travels as
 * a `?token=` query param (see `AuthController.resetPassword`), not in this body.
 */
export class ResetPasswordDto {
  @IsNotEmpty({ message: 'New password is required' })
  @Matches(VARIABLES.PASSWORD_REGEX, {
    message: VALIDATION_MESSAGES.PASSWORD_WEAK,
  })
  @MinLength(8, { message: VALIDATION_MESSAGES.PASSWORD_WEAK })
  newPassword: string;

  @IsNotEmpty({ message: 'Confirm new password is required' })
  @Matches(VARIABLES.PASSWORD_REGEX, {
    message: VALIDATION_MESSAGES.PASSWORD_WEAK,
  })
  @MinLength(8, { message: VALIDATION_MESSAGES.PASSWORD_WEAK })
  confirmNewPassword: string;
}

import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsNotEmpty, IsString, MinLength } from 'class-validator';
import { VALIDATION_MESSAGES } from '@common/constants/validation-messages.constants';

/**
 * C1.4/B5: restoring requires **email and password**, never email alone — a
 * bare-email endpoint would let anyone un-delete a stranger's account. The
 * user has already typed both at the point the restore prompt appears, so
 * requiring them again costs the flow nothing.
 *
 * Google-only accounts (no password) do not use this endpoint at all; for
 * them, completing the Google OAuth flow is the proof of ownership and the
 * restore happens inside `GET /auth/google/callback`.
 */
export class RestoreAccountDto {
  @ApiProperty({
    example: 'user@example.com',
    description: 'Email of the soft-deleted account to restore',
  })
  @IsEmail({}, { message: VALIDATION_MESSAGES.EMAIL_INVALID })
  @IsNotEmpty({ message: VALIDATION_MESSAGES.EMAIL_REQUIRED })
  @IsString()
  email: string;

  @ApiProperty({
    example: 'password123',
    description: "The account's password — proof of ownership",
  })
  @IsString()
  @MinLength(8, { message: VALIDATION_MESSAGES.PASSWORD_WEAK })
  @IsNotEmpty({ message: VALIDATION_MESSAGES.PASSWORD_REQUIRED })
  password: string;
}

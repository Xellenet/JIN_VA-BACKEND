import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { VALIDATION_MESSAGES } from '@common/constants/validation-messages.constants';
import { VARIABLES } from '@common/constants/variables.constants';

/** The purposes a client may name. `password_reset` codes go through `/auth/password/*`. */
export const CLIENT_CODE_PURPOSES = ['signup', 'login'] as const;
export type ClientCodePurpose = (typeof CLIENT_CODE_PURPOSES)[number];

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

/** Shared: the optional Turnstile token every auth v2 body may carry. */
export class TurnstileTokenDto {
  @ApiPropertyOptional({
    description:
      'Cloudflare Turnstile token from the widget. Required on register, code requests and forgot password when Turnstile is configured; on login only after repeated failures.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  turnstileToken?: string;
}

export class EmailField extends TurnstileTokenDto {
  @ApiProperty({ example: 'kofi.asante@example.com' })
  @Transform(trim)
  @IsEmail({}, { message: VALIDATION_MESSAGES.EMAIL_INVALID })
  @IsNotEmpty({ message: VALIDATION_MESSAGES.EMAIL_REQUIRED })
  @MaxLength(254)
  email: string;
}

/** `POST /auth/code/request`. */
export class RequestCodeDto extends EmailField {
  @ApiProperty({ enum: CLIENT_CODE_PURPOSES, example: 'login' })
  @IsIn(CLIENT_CODE_PURPOSES, { message: 'purpose must be signup or login' })
  purpose: ClientCodePurpose;
}

/** The 6 digits, spaces stripped (a pasted "482 915" works). */
const codeField = () =>
  Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.replace(/\s+/g, '') : value,
  );

/** `POST /auth/code/verify`. */
export class VerifyCodeDto extends RequestCodeDto {
  @ApiProperty({
    example: '482915',
    description: 'The 6-digit code from the email.',
  })
  @codeField()
  @IsString()
  @Matches(/^\d{6}$/, { message: 'code must be 6 digits' })
  code: string;

  @ApiPropertyOptional({
    example: true,
    default: true,
    description:
      'Same as login: false keeps the session to this browser session.',
  })
  @IsOptional()
  @IsBoolean()
  rememberMe?: boolean;
}

/** `POST /auth/password/forgot`. */
export class ForgotPasswordCodeDto extends EmailField {}

/** `POST /auth/password/reset/check`. */
export class CheckResetCodeDto extends EmailField {
  @ApiProperty({ example: '482915' })
  @codeField()
  @IsString()
  @Matches(/^\d{6}$/, { message: 'code must be 6 digits' })
  code: string;
}

/** `POST /auth/password/reset`. */
export class ResetPasswordWithCodeDto extends EmailField {
  @ApiProperty({ example: '482915' })
  @codeField()
  @IsString()
  @Matches(/^\d{6}$/, { message: 'code must be 6 digits' })
  code: string;

  @ApiProperty({
    example: 'Strong@123',
    description: VALIDATION_MESSAGES.PASSWORD_WEAK,
  })
  @IsString()
  @IsNotEmpty({ message: 'New password is required' })
  @Matches(VARIABLES.PASSWORD_REGEX, {
    message: VALIDATION_MESSAGES.PASSWORD_WEAK,
  })
  @MinLength(8, { message: VALIDATION_MESSAGES.PASSWORD_WEAK })
  newPassword: string;

  @ApiPropertyOptional({ example: true, default: true })
  @IsOptional()
  @IsBoolean()
  rememberMe?: boolean;
}

/** `{ data }` of register, code/request and password/forgot. */
export interface CodeSentData {
  resendAvailableAt: string;
}

export interface RegisterData extends CodeSentData {
  email: string;
}

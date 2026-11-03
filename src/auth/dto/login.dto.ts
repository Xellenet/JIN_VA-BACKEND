import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { VALIDATION_MESSAGES } from '@common/constants/validation-messages.constants';

export class LoginDto {
  @ApiProperty({
    example: 'user@example.com',
    description: 'Email of the user',
  })
  @IsEmail({}, { message: VALIDATION_MESSAGES.EMAIL_INVALID })
  @IsNotEmpty({ message: VALIDATION_MESSAGES.EMAIL_REQUIRED })
  @IsString()
  email: string;

  @ApiProperty({ example: 'password123', description: 'Password of the user' })
  @IsString()
  @MinLength(8, { message: VALIDATION_MESSAGES.PASSWORD_WEAK })
  @IsNotEmpty({ message: VALIDATION_MESSAGES.PASSWORD_REQUIRED })
  password: string;

  /**
   * QA AUTH-31: false keeps the sign-in to this browser session — the cookies
   * go when the browser closes. Left out, the session is remembered, as every
   * login was before this option existed.
   */
  @ApiPropertyOptional({ example: true, default: true })
  @IsOptional()
  @IsBoolean()
  rememberMe?: boolean;

  /**
   * Auth v2: required only after repeated failures for this email or IP
   * (the login then answers 401 `TURNSTILE_REQUIRED`). Action `login`.
   */
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  turnstileToken?: string;
}

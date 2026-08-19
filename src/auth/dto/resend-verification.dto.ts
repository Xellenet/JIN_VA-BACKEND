import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsNotEmpty, IsString } from 'class-validator';
import { VALIDATION_MESSAGES } from '@common/constants/validation-messages.constants';

export class ResendVerificationDto {
  @ApiProperty({
    example: 'user@example.com',
    description: 'The account email to resend a verification link to',
  })
  @IsEmail({}, { message: VALIDATION_MESSAGES.EMAIL_INVALID })
  @IsNotEmpty({ message: VALIDATION_MESSAGES.EMAIL_REQUIRED })
  @IsString()
  email: string;
}

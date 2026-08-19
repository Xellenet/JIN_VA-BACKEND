import { ApiPropertyOptional } from '@nestjs/swagger';
import { Gender } from '@common/types/enums';
import {
  IsDateString,
  IsEnum,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import { VARIABLES } from '@common/constants/variables.constants';
import { VALIDATION_MESSAGES } from '@common/constants/validation-messages.constants';

/**
 * DTO for a user updating their own base profile via `PATCH /users/me`.
 * Email, password, and role are intentionally excluded — they each require
 * dedicated, security-sensitive flows.
 */
export class UpdateMeDto {
  @ApiPropertyOptional({ example: 'johndoe', description: 'Unique display username' })
  @IsOptional()
  @IsString()
  username?: string;

  @ApiPropertyOptional({ example: 'John', description: 'First name (max 15 chars)' })
  @IsOptional()
  @IsString()
  @MaxLength(15, { message: VALIDATION_MESSAGES.FIRSTNAME_MAX_LENGTH })
  firstname?: string;

  @ApiPropertyOptional({ example: 'Doe', description: 'Last name (max 15 chars)' })
  @IsOptional()
  @IsString()
  @MaxLength(15, { message: VALIDATION_MESSAGES.LASTNAME_MAX_LENGTH })
  lastname?: string;

  @ApiPropertyOptional({ example: '123-456-7890', description: 'Phone in NXX-NXX-XXXX format' })
  @IsOptional()
  @IsString()
  @MaxLength(12, { message: VALIDATION_MESSAGES.PHONE_NUMBER_MAX_LENGTH })
  @Matches(VARIABLES.PHONENUMBER_REGEX, { message: VALIDATION_MESSAGES.PHONE_NUMBER_INVALID })
  phoneNumber?: string;

  @ApiPropertyOptional({ example: '1990-01-15', description: 'Date of birth (ISO 8601)' })
  @IsOptional()
  @IsDateString({}, { message: VALIDATION_MESSAGES.DATE_OF_BIRTH_INVALID })
  dateOfBirth?: string;

  @ApiPropertyOptional({ example: 'MALE', enum: Gender, description: 'Gender' })
  @IsOptional()
  @IsEnum(Gender, { message: VALIDATION_MESSAGES.GENDER_INVALID })
  gender?: Gender;

  @ApiPropertyOptional({ example: 'https://cdn.example.com/avatar.jpg', description: 'Profile picture URL' })
  @IsOptional()
  @IsString()
  profilePicture?: string;
}

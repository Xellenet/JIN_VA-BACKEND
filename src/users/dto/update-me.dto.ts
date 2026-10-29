import { ApiPropertyOptional } from '@nestjs/swagger';
import { Gender } from '@common/types/enums';
import {
  IsDateString,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { VALIDATION_MESSAGES } from '@common/constants/validation-messages.constants';
import {
  IsSupportedPhoneNumber,
  NormalizePhoneNumber,
} from '@common/validators/is-supported-phone-number.decorator';
import { INPUT_GENDERS } from './create-user.dto';

/**
 * DTO for a user updating their own base profile via `PATCH /users/me`.
 * Email, password, and role are intentionally excluded — they each require
 * dedicated, security-sensitive flows.
 */
export class UpdateMeDto {
  @ApiPropertyOptional({
    example: 'johndoe',
    description: 'Unique display username',
  })
  @IsOptional()
  @IsString()
  username?: string;

  @ApiPropertyOptional({
    example: 'John',
    description: 'First name (max 15 chars)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(15, { message: VALIDATION_MESSAGES.FIRSTNAME_MAX_LENGTH })
  firstname?: string;

  @ApiPropertyOptional({
    example: 'Doe',
    description: 'Last name (max 15 chars)',
  })
  @IsOptional()
  @IsString()
  @MaxLength(15, { message: VALIDATION_MESSAGES.LASTNAME_MAX_LENGTH })
  lastname?: string;

  @ApiPropertyOptional({
    example: '+233241234567',
    description:
      'Phone number; omit to leave unchanged (PH6). Normalised to E.164 ' +
      '(PH7): national input is read as Ghanaian. Must be a valid number ' +
      'from a supported country.',
  })
  @NormalizePhoneNumber()
  @IsOptional()
  @IsString()
  @MaxLength(16, { message: VALIDATION_MESSAGES.PHONE_NUMBER_MAX_LENGTH })
  @IsSupportedPhoneNumber()
  phoneNumber?: string;

  @ApiPropertyOptional({
    example: '1990-01-15',
    description: 'Date of birth (ISO 8601)',
  })
  @IsOptional()
  @IsDateString({}, { message: VALIDATION_MESSAGES.DATE_OF_BIRTH_INVALID })
  dateOfBirth?: string;

  @ApiPropertyOptional({
    example: 'MALE',
    enum: INPUT_GENDERS,
    description:
      'Gender, MALE or FEMALE (DI5). An existing OTHER value still reads back but cannot be set.',
  })
  @IsOptional()
  @IsIn(INPUT_GENDERS, { message: VALIDATION_MESSAGES.GENDER_INVALID })
  gender?: Gender;

  @ApiPropertyOptional({
    example: 'https://cdn.example.com/avatar.jpg',
    description: 'Profile picture URL',
  })
  @IsOptional()
  @IsString()
  profilePicture?: string;

  @ApiPropertyOptional({
    example: 'GHA-123456789-0',
    description:
      'National ID (e.g. Ghana Card number). Can be set once; changing it needs support.',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @IsString()
  @Matches(/^[A-Z0-9][A-Z0-9-]{4,29}$/, {
    message:
      'nationalId must be 5 to 30 letters, numbers or dashes, like GHA-123456789-0',
  })
  nationalId?: string;
}

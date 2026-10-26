import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsDateString,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { Gender, Role } from '@common/types/enums';
import { VALIDATION_MESSAGES } from '@common/constants/validation-messages.constants';
import {
  IsSupportedPhoneNumber,
  NormalizePhoneNumber,
} from '@common/validators/is-supported-phone-number.decorator';
import { INPUT_GENDERS } from '@users/dto/create-user.dto';

/** Rejects whitespace-only strings, which `computeProfileCompleteness` trims to empty. */
const NOT_BLANK = /\S/;

/** The artisan-only fields are validated only when the chosen role is ARTISAN. */
const isArtisan = (o: CompleteSocialSignupDto) => o.role === Role.ARTISAN;

/**
 * Body of `POST /auth/social/complete`: what a brand-new social user picks and
 * fills in before their account is created.
 *
 * The personal fields reuse `CreateUserDto`'s validators. The required
 * artisan fields are exactly the ones `computeProfileCompleteness` requires
 * (plus three optional extras, bio among them since B1), so an artisan created
 * this way is searchable immediately. For a CUSTOMER they are not validated
 * and are ignored.
 */
export class CompleteSocialSignupDto {
  @ApiProperty({ enum: [Role.CUSTOMER, Role.ARTISAN], example: Role.ARTISAN })
  @IsIn([Role.CUSTOMER, Role.ARTISAN], {
    message: VALIDATION_MESSAGES.ROLE_INVALID,
  })
  role: Role.CUSTOMER | Role.ARTISAN;

  @ApiProperty({ example: 'John', description: 'Prefilled from Google.' })
  @IsString()
  @Matches(NOT_BLANK, { message: 'firstname should not be empty' })
  @MaxLength(15, { message: VALIDATION_MESSAGES.FIRSTNAME_MAX_LENGTH })
  firstname: string;

  @ApiProperty({ example: 'Doe', description: 'Prefilled from Google.' })
  @IsString()
  @Matches(NOT_BLANK, { message: 'lastname should not be empty' })
  @MaxLength(15, { message: VALIDATION_MESSAGES.LASTNAME_MAX_LENGTH })
  lastname: string;

  @ApiProperty({
    example: '+233241234567',
    description:
      'Required (PH6). Normalised to E.164 (PH7): national input is read as ' +
      'Ghanaian, so `024 123 4567` is stored as `+233241234567`. Must be a ' +
      'valid number from a supported country.',
  })
  @NormalizePhoneNumber()
  @IsString()
  @IsNotEmpty({ message: VALIDATION_MESSAGES.PHONE_NUMBER_REQUIRED })
  @MaxLength(16, { message: VALIDATION_MESSAGES.PHONE_NUMBER_MAX_LENGTH })
  @IsSupportedPhoneNumber()
  phoneNumber: string;

  @ApiProperty({
    enum: INPUT_GENDERS,
    example: Gender.MALE,
    description: 'Required (DI5). MALE or FEMALE only.',
  })
  @IsNotEmpty({ message: VALIDATION_MESSAGES.GENDER_REQUIRED })
  @IsIn(INPUT_GENDERS, { message: VALIDATION_MESSAGES.GENDER_INVALID })
  gender: Gender.MALE | Gender.FEMALE;

  @ApiPropertyOptional({ example: '1995-10-25' })
  @IsOptional()
  @IsDateString({}, { message: VALIDATION_MESSAGES.DATE_OF_BIRTH_INVALID })
  dateOfBirth?: string;

  // ─── ARTISAN only ────────────────────────────────────────────────────────────

  @ApiPropertyOptional({
    example: [1, 2],
    type: [Number],
    description: 'ARTISAN only (required). Every id must exist.',
  })
  @ValidateIf(isArtisan)
  @IsArray()
  @ArrayMinSize(1, { message: 'Select at least one service' })
  @ArrayUnique()
  @IsInt({ each: true })
  serviceIds?: number[];

  @ApiPropertyOptional({
    example: 'Accra, Ghana',
    description: 'ARTISAN only (required).',
  })
  @ValidateIf(isArtisan)
  @IsString()
  @Matches(NOT_BLANK, { message: 'location should not be empty' })
  @MaxLength(150)
  location?: string;

  @ApiPropertyOptional({
    example: 45.5,
    description: 'ARTISAN only (required).',
  })
  @ValidateIf(isArtisan)
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  hourlyRate?: number;

  @ApiPropertyOptional({
    example: 'Experienced plumber serving Greater Accra.',
    description:
      'ARTISAN only (optional, B1). An empty or whitespace-only bio is stored as null.',
  })
  // B1: optional. Blank input is folded to `undefined` so it is stored as
  // null rather than `""` — the same "not set" state as omitting it.
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' && value.trim() === '' ? undefined : value,
  )
  @ValidateIf(isArtisan)
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  bio?: string;

  @ApiPropertyOptional({
    example: 'Doe Plumbing',
    description: 'ARTISAN only (optional).',
  })
  @ValidateIf(isArtisan)
  @IsOptional()
  @IsString()
  @MaxLength(150)
  businessName?: string;

  @ApiPropertyOptional({
    example: 5,
    description:
      'ARTISAN only (optional). `0` is accepted and stored as "not set" — the column only allows positive values.',
  })
  @ValidateIf(isArtisan)
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(80)
  experienceYears?: number;
}

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
import { NormalizeMiddleName } from '@common/validators/middle-name.decorator';
import { VARIABLES } from '@common/constants/variables.constants';

/** Rejects whitespace-only strings, which `computeProfileCompleteness` trims to empty. */
const NOT_BLANK = /\S/;

/**
 * The artisan-only fields are validated unless the body explicitly says
 * CUSTOMER — with `role` omitted, the role comes from the pending signup and
 * may be ARTISAN.
 */
const isArtisan = (o: CompleteSocialSignupDto) => o.role !== Role.CUSTOMER;

/**
 * Body of `POST /auth/social/complete`: what a brand-new social user fills in
 * before their account is created.
 *
 * Auth v2: only `phoneNumber` is required. The role defaults to the one
 * chosen before Google, the names to what Google supplied, gender is asked
 * later in Settings, and an artisan's services, area and rate are filled in
 * from the setup checklist. Old clients that still send any of them keep
 * working: each is validated as before when present, and an artisan who sends
 * the full set is searchable immediately. For a CUSTOMER the artisan fields
 * are ignored.
 */
export class CompleteSocialSignupDto {
  @ApiPropertyOptional({
    enum: [Role.CUSTOMER, Role.ARTISAN],
    example: Role.ARTISAN,
    description:
      'Auth v2: optional. Defaults to the role chosen before Google (`suggestedRole`); ' +
      'required only when the flow started without one.',
  })
  @IsOptional()
  @IsIn([Role.CUSTOMER, Role.ARTISAN], {
    message: VALIDATION_MESSAGES.ROLE_INVALID,
  })
  role?: Role.CUSTOMER | Role.ARTISAN;

  @ApiPropertyOptional({
    example: 'John',
    description: 'Optional (auth v2): defaults to the name Google supplied.',
  })
  @IsOptional()
  @IsString()
  @Matches(NOT_BLANK, { message: 'firstname should not be empty' })
  @MaxLength(15, { message: VALIDATION_MESSAGES.FIRSTNAME_MAX_LENGTH })
  firstname?: string;

  @ApiPropertyOptional({
    example: 'Kwame',
    description: 'Optional. Trimmed; blank is stored as null.',
    nullable: true,
  })
  @NormalizeMiddleName()
  @IsOptional()
  @IsString()
  @MaxLength(VARIABLES.NAME_MAX_LENGTH, {
    message: VALIDATION_MESSAGES.MIDDLENAME_MAX_LENGTH,
  })
  middlename?: string | null;

  @ApiPropertyOptional({
    example: 'Doe',
    description: 'Optional (auth v2): defaults to the name Google supplied.',
  })
  @IsOptional()
  @IsString()
  @Matches(NOT_BLANK, { message: 'lastname should not be empty' })
  @MaxLength(15, { message: VALIDATION_MESSAGES.LASTNAME_MAX_LENGTH })
  lastname?: string;

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

  @ApiPropertyOptional({
    enum: INPUT_GENDERS,
    example: Gender.MALE,
    description: 'Optional (auth v2). MALE or FEMALE only when sent.',
  })
  @IsOptional()
  @IsIn(INPUT_GENDERS, { message: VALIDATION_MESSAGES.GENDER_INVALID })
  gender?: Gender.MALE | Gender.FEMALE;

  @ApiPropertyOptional({ example: '1995-10-25' })
  @IsOptional()
  @IsDateString({}, { message: VALIDATION_MESSAGES.DATE_OF_BIRTH_INVALID })
  dateOfBirth?: string;

  // ─── ARTISAN only ────────────────────────────────────────────────────────────

  @ApiPropertyOptional({
    example: [1, 2],
    type: [Number],
    description:
      'ARTISAN only, optional (auth v2: set in the setup checklist). Every id must exist.',
  })
  @ValidateIf(isArtisan)
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1, { message: 'Select at least one service' })
  @ArrayUnique()
  @IsInt({ each: true })
  serviceIds?: number[];

  @ApiPropertyOptional({
    example: 'Accra, Ghana',
    description: 'ARTISAN only, optional (auth v2: no area at sign-up).',
  })
  @ValidateIf(isArtisan)
  @IsOptional()
  @IsString()
  @Matches(NOT_BLANK, { message: 'location should not be empty' })
  @MaxLength(150)
  location?: string;

  @ApiPropertyOptional({
    example: 45.5,
    description: 'ARTISAN only, optional (auth v2).',
  })
  @ValidateIf(isArtisan)
  @IsOptional()
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

  @ApiPropertyOptional({
    description: 'Accepted and ignored (auth v2 bodies may carry it).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  turnstileToken?: string;
}

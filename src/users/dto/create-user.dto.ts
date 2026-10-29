import { Gender, Role } from '@common/types/enums';
import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsEmail,
  IsNotEmpty,
  MinLength,
  IsString,
  MaxLength,
  Matches,
  IsEnum,
  IsIn,
  ArrayMinSize,
  IsArray,
  IsOptional,
  ValidateNested,
  IsDateString,
} from 'class-validator';
import { CreateAddressDto } from './create-address.dto';
import { VALIDATION_MESSAGES } from '@common/constants/validation-messages.constants';
import { VARIABLES } from '@common/constants/variables.constants';
import {
  IsSupportedPhoneNumber,
  NormalizePhoneNumber,
} from '@common/validators/is-supported-phone-number.decorator';

/**
 * DI5: the genders an endpoint accepts as **new input**. The `Gender` enum
 * (and the `users_gender_enum` Postgres type) keeps `OTHER` so existing rows
 * stay valid and still read back, but no endpoint accepts it any more.
 */
export const INPUT_GENDERS: readonly [Gender.MALE, Gender.FEMALE] = [
  Gender.MALE,
  Gender.FEMALE,
];

export class CreateUserDto {
  @ApiProperty({
    example: 'john@example.com',
    description: 'Unique email of the user',
  })
  @IsEmail({}, { message: VALIDATION_MESSAGES.EMAIL_INVALID })
  email: string;

  @ApiProperty({
    example: 'Strong@123',
    description: VALIDATION_MESSAGES.PASSWORD_WEAK,
    required: false,
  })
  // G5 fix: social signups (AuthService.registerSocialUser) build this DTO
  // with no `password` — Google never supplies one. This never actually ran
  // through the ValidationPipe for that path (registerSocialUser() calls
  // UsersService.createUser() directly, bypassing @Body() validation
  // entirely), so this was a documentation/Swagger-accuracy and spec-drift
  // gap versus requirements.md's G5, not a live bug — but it's fragile
  // against any future code path that runs this exact DTO through
  // class-validator's validate()/a ValidationPipe. See
  // docs/team/google-oauth-fix/qa-report.md ([MINOR]).
  @IsOptional()
  @IsString()
  @Matches(VARIABLES.PASSWORD_REGEX, {
    message: VALIDATION_MESSAGES.PASSWORD_WEAK,
  })
  @MinLength(8)
  password?: string;

  @ApiProperty({ example: 'johndoe', description: 'Full name of the user' })
  @IsString()
  @IsNotEmpty({ message: VALIDATION_MESSAGES.USERNAME_REQUIRED })
  username?: string;

  @ApiProperty({
    example: '2025-10-25',
    description: 'Date of Birth of the User',
    required: false,
  })
  @IsOptional()
  @IsDateString({}, { message: VALIDATION_MESSAGES.DATE_OF_BIRTH_INVALID })
  dateOfBirth?: string;

  @ApiProperty({ example: 'John', description: 'The first name of the user.' })
  @IsString()
  @MaxLength(15, { message: VALIDATION_MESSAGES.FIRSTNAME_MAX_LENGTH })
  firstname: string;

  @ApiProperty({ example: 'Doe', description: 'The last name of the user.' })
  @IsString()
  @MaxLength(15, { message: VALIDATION_MESSAGES.LASTNAME_MAX_LENGTH })
  lastname: string;

  @ApiProperty({
    example: '+233241234567',
    description:
      'Phone number of the user. Normalised to E.164 (PH7): national input is ' +
      'read as Ghanaian, so `024 123 4567` is stored as `+233241234567`. Must ' +
      'be a valid number from a supported country.',
    required: false,
  })
  @NormalizePhoneNumber()
  @IsString()
  @IsOptional()
  @MaxLength(16, { message: VALIDATION_MESSAGES.PHONE_NUMBER_MAX_LENGTH })
  @IsSupportedPhoneNumber()
  phoneNumber?: string;

  @ApiProperty({
    enum: INPUT_GENDERS,
    example: Gender.MALE,
    description: 'The gender of the user. MALE or FEMALE only (DI5).',
    required: false,
  })
  // G5 fix: social signups never supply a gender (Google doesn't provide
  // one), and the `users.gender` column is nullable via migration. See the
  // `password` field above for the same reasoning. See
  // docs/team/google-oauth-fix/qa-report.md ([MINOR]).
  @IsOptional()
  @IsIn(INPUT_GENDERS, { message: VALIDATION_MESSAGES.GENDER_INVALID })
  gender?: Gender;

  @ApiProperty({
    example: 'customer',
    description:
      'The role of the user. Optional on self-registration — omit to default to CUSTOMER; ADMIN is rejected.',
    required: false,
  })
  @IsOptional()
  @IsEnum(Role, { message: VALIDATION_MESSAGES.ROLE_INVALID })
  role?: Role;

  @ApiProperty({
    type: [CreateAddressDto],
    description: 'List of addresses for the user',
    required: false,
  })
  @ApiProperty({
    example: 'google',
    description: 'The social provider of the user.',
  })
  @IsOptional()
  @IsString()
  socialProvider?: string;

  @ApiProperty({
    example: 'google-unique-id-12345',
    description: 'The social provider ID of the user.',
  })
  @IsOptional()
  @IsString()
  socialProviderId?: string;

  @ApiProperty({
    example: true,
    description: 'Indicates if the user registered via social login.',
  })
  @IsOptional()
  @IsNotEmpty()
  @IsString()
  isSocialLogin?: boolean;

  @ApiProperty({
    example: 'http://example.com/profile.jpg',
    description: "URL of the user's profile picture.",
  })
  @IsOptional()
  @IsString()
  profilePicture?: string;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(0)
  @ValidateNested({ each: true })
  @Type(() => CreateAddressDto)
  addresses?: CreateAddressDto[];
}

import { ApiProperty, ApiPropertyOptional, OmitType } from '@nestjs/swagger';
import {
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import { Gender } from '@common/types/enums';
import { VALIDATION_MESSAGES } from '@common/constants/validation-messages.constants';
import { VARIABLES } from '@common/constants/variables.constants';
import {
  IsSupportedPhoneNumber,
  NormalizePhoneNumber,
} from '@common/validators/is-supported-phone-number.decorator';
import { CreateUserDto, INPUT_GENDERS } from '@users/dto/create-user.dto';

/**
 * Body of `POST /auth/register` (email/password self-registration).
 *
 * Auth v2: `username` and `gender` are **optional**. The username is
 * generated from the first and last name when it isn't sent; an old client
 * that still sends one has it validated by the existing rule (and gets a
 * generated one instead if it's already taken). Gender is asked later, in
 * Settings. Phone stays required (PH6).
 *
 * `OmitType` (not plain `extends CreateUserDto`) matters: class-validator
 * merges a subclass's rules with the parent's for the same property, so the
 * parent's rules would still apply. Omitting the fields drops those rules, and
 * every other field keeps `CreateUserDto`'s validators and transforms.
 */
export class RegisterUserDto extends OmitType(CreateUserDto, [
  'phoneNumber',
  'gender',
  'username',
  // SEC-5: no free-text avatar URL at signup. A photo is only ever set by
  // uploading one (`POST /users/me/avatar`), so a new account can never
  // point at another user's avatar file.
  'profilePicture',
] as const) {
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
    example: Gender.FEMALE,
    description:
      'Optional (auth v2). Old clients may still send it; MALE or FEMALE only.',
  })
  @IsOptional()
  @IsIn(INPUT_GENDERS, { message: VALIDATION_MESSAGES.GENDER_INVALID })
  gender?: Gender.MALE | Gender.FEMALE;

  @ApiPropertyOptional({
    example: 'kofi.asante',
    description:
      'Optional (auth v2): generated from the name when absent. When sent it ' +
      'must match the username rule; a taken one is replaced by a generated one.',
  })
  @IsOptional()
  @IsString()
  @Matches(VARIABLES.USERNAME_REGEX, {
    message: VALIDATION_MESSAGES.USERNAME_INVALID,
  })
  username?: string;

  @ApiPropertyOptional({
    description: 'Cloudflare Turnstile token (action `register`).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  turnstileToken?: string;
}

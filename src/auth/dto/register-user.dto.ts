import { ApiProperty, OmitType } from '@nestjs/swagger';
import { IsIn, IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { Gender } from '@common/types/enums';
import { VALIDATION_MESSAGES } from '@common/constants/validation-messages.constants';
import {
  IsSupportedPhoneNumber,
  NormalizePhoneNumber,
} from '@common/validators/is-supported-phone-number.decorator';
import { CreateUserDto, INPUT_GENDERS } from '@users/dto/create-user.dto';

/**
 * Body of `POST /auth/register` (email/password self-registration).
 *
 * PH6 + DI5: phone and gender are **required** here. `CreateUserDto` keeps
 * them optional because it is also used for social account creation and by
 * the admin `POST /users` route, so this DTO redeclares the two fields rather
 * than changing the shared one.
 *
 * `OmitType` (not plain `extends CreateUserDto`) matters: class-validator
 * merges a subclass's rules with the parent's for the same property, so the
 * parent's `@IsOptional()` would still skip validation of a missing value.
 * Omitting the fields drops those rules, and every other field keeps
 * `CreateUserDto`'s validators and transforms unchanged.
 */
export class RegisterUserDto extends OmitType(CreateUserDto, [
  'phoneNumber',
  'gender',
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

  @ApiProperty({
    enum: INPUT_GENDERS,
    example: Gender.FEMALE,
    description: 'Required (DI5). MALE or FEMALE only.',
  })
  @IsNotEmpty({ message: VALIDATION_MESSAGES.GENDER_REQUIRED })
  @IsIn(INPUT_GENDERS, { message: VALIDATION_MESSAGES.GENDER_INVALID })
  gender: Gender.MALE | Gender.FEMALE;
}

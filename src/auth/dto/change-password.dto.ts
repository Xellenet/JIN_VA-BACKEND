import { IsNotEmpty, Matches, MinLength } from 'class-validator';
import { ResetPasswordDto } from './reset-password.dto';
import { VARIABLES } from '@common/constants/variables.constants';
import { VALIDATION_MESSAGES } from '@common/constants/validation-messages.constants';


export class ChangePasswordDto extends ResetPasswordDto {
    @IsNotEmpty({ message: 'Current password is required' })
    @Matches(VARIABLES.PASSWORD_REGEX, {
            message: VALIDATION_MESSAGES.PASSWORD_WEAK,
        })
    @MinLength(8, { message: VALIDATION_MESSAGES.PASSWORD_WEAK })
    currentPassword: string;
}
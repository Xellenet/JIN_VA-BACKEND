import { VARIABLES } from "@common/constants/variables.constants";
import { IsNotEmpty, Matches, MinLength } from "class-validator";
import { VALIDATION_MESSAGES,  } from "@common/constants/validation-messages.constants";

export class ResetPasswordDto {

    @IsNotEmpty({ message: 'New password is required' })
    @Matches(VARIABLES.PASSWORD_REGEX, {
        message: VALIDATION_MESSAGES.PASSWORD_WEAK,
    })
    @MinLength(8, { message: VALIDATION_MESSAGES.PASSWORD_WEAK })
    newPassword: string;

    @IsNotEmpty({ message: 'Confirm new password is required' })
    @Matches(VARIABLES.PASSWORD_REGEX, {
        message: VALIDATION_MESSAGES.PASSWORD_WEAK,
    })
    @MinLength(8, { message: VALIDATION_MESSAGES.PASSWORD_WEAK })
    confirmNewPassword: string;
}

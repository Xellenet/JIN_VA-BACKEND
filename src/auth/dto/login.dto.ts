import { ApiProperty } from "@nestjs/swagger";
import { IsEmail, IsNotEmpty, IsString, MinLength } from "class-validator";
import { VALIDATION_MESSAGES } from "@common/constants/validation-messages.constants";


export class LoginDto {
    @ApiProperty({ example: 'user@example.com', description: 'Email of the user' })
    @IsEmail({},{ message: VALIDATION_MESSAGES.EMAIL_INVALID })
    @IsNotEmpty({ message: VALIDATION_MESSAGES.EMAIL_REQUIRED })
    @IsString()
    email: string;

    @ApiProperty({ example: 'password123', description: 'Password of the user' })
    @IsString()
    @MinLength(8, { message: VALIDATION_MESSAGES.PASSWORD_WEAK })
    @IsNotEmpty({ message: VALIDATION_MESSAGES.PASSWORD_REQUIRED })
    password: string;
}
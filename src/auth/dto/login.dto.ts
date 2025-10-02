import { ApiProperty } from "@nestjs/swagger";
import { IsEmail, IsString, MinLength } from "class-validator";


export class LoginDto {
    @ApiProperty({ example: 'user@example.com', description: 'Email of the user' })
    @IsEmail()
    email: string;

    @ApiProperty({ example: 'password123', description: 'Password of the user' })
    @IsString()
    @MinLength(6)
    password: string;
}
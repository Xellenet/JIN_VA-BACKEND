import { SUCCESS_MESSAGES } from "@common/constants/success-messages.constants";
import { ApiProperty } from "@nestjs/swagger";
import { UserResponseDto } from "@users/dto/user-response.dto";
import { Expose } from "class-transformer";

export class LoginResponseDto {
    @ApiProperty({ example: 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...', description: 'JWT access token' })
    @Expose()
    access_token: string;

    @ApiProperty({ example: 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...', description: 'Refresh token for obtaining new access tokens' })
    @Expose()
    refresh_token: string;

    @ApiProperty({ example: '2026-06-16T14:03:21.000Z', description: 'ISO timestamp when the access token expires' })
    @Expose()
    expires_at: Date;

    @ApiProperty({ example: SUCCESS_MESSAGES.AUTH.USER_LOGGED_IN, description: 'Login success message' })
    @Expose()
    message: string;

    @ApiProperty({ example: {}, description: 'Additional data related to the login response', type: UserResponseDto })
    @Expose()
    data: UserResponseDto;
}
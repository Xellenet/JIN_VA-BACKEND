import { VARIABLES } from "@common/constants/variables.constants";
import { ApiProperty } from "@nestjs/swagger";
import { UserResponseDto } from "@users/dto/user-response.dto";
import { Expose } from "class-transformer";

export class LoginResponseDto {
    @ApiProperty({ example: VARIABLES.TOKEN_EXAMPLE, description: 'JWT token for authenticated user' })
    @Expose()
    access_token: string;

    @ApiProperty({ example: VARIABLES.TOKEN_EXAMPLE, description: 'Refresh token for obtaining new access tokens' })
    @Expose()
    refresh_token: string;

    @ApiProperty({ example: VARIABLES.USER_LOGGED_IN, description: 'Login success message' })
    @Expose()
    message: string;

    @ApiProperty({ example: {}, description: 'Additional data related to the login response', type: UserResponseDto })
    @Expose()
    data: UserResponseDto;
}
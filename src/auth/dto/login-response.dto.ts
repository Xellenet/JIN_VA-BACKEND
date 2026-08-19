import { SUCCESS_MESSAGES } from '@common/constants/success-messages.constants';
import { ApiProperty } from '@nestjs/swagger';
import { UserResponseDto } from '@users/dto/user-response.dto';
import { Expose } from 'class-transformer';

/**
 * Shape of every auth response that issues tokens (login, refresh, change-password).
 *
 * The refresh token is intentionally NOT a field here — it is never returned in the
 * JSON body. It is set exclusively via an httpOnly `Set-Cookie` header by the
 * controller (see `AuthController`'s cookie helpers).
 */
export class LoginResponseDto {
  @ApiProperty({
    example: 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...',
    description: 'JWT access token',
  })
  @Expose()
  access_token: string;

  @ApiProperty({
    example: '2026-06-16T14:03:21.000Z',
    description: 'ISO timestamp when the access token expires',
  })
  @Expose()
  expires_at: Date;

  @ApiProperty({
    example: SUCCESS_MESSAGES.AUTH.USER_LOGGED_IN,
    description: 'Login success message',
  })
  @Expose()
  message: string;

  @ApiProperty({
    example: {},
    description: 'Additional data related to the login response',
    type: UserResponseDto,
  })
  @Expose()
  data: UserResponseDto;
}

/**
 * Internal (never serialized directly) pairing of the client-facing response body
 * with the raw refresh token string the controller needs to set as an httpOnly cookie.
 * Service methods that issue a fresh token pair return this shape; controllers must
 * destructure it, set the cookie from `refreshToken`, and return only `result`.
 */
export interface AuthTokenResult {
  result: LoginResponseDto;
  refreshToken: string;
}

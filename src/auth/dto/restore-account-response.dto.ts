import { ApiProperty } from '@nestjs/swagger';
import { Expose } from 'class-transformer';
import { UserResponseDto } from '@users/dto/user-response.dto';
import { SUCCESS_MESSAGES } from '@common/constants/success-messages.constants';

/**
 * C1.4: what `POST /auth/restore-account` returns on success.
 *
 * One shape covers both outcomes rather than two, so the caller branches on a
 * field instead of on a status code:
 *
 * - **Verified account** — `access_token` and `expires_at` are present, the
 *   httpOnly refresh + session cookies are set, and the user is logged in
 *   exactly as `POST /auth/login` would leave them.
 * - **Unverified account** — `requiresEmailVerification` is `true` and no
 *   token is issued. The restore itself still succeeded (that is what
 *   `restored: true` means): C1.4 gives restore precedence over the
 *   email-verification gate, and then the ordinary "verify your email" block
 *   applies to the now-restored account as normal. The caller should show its
 *   existing unverified-login prompt, not a restore failure.
 *
 * The refresh token is never a field here — same contract as
 * `LoginResponseDto`: it is set exclusively via an httpOnly `Set-Cookie`.
 */
export class RestoreAccountResponseDto {
  @ApiProperty({
    example: SUCCESS_MESSAGES.AUTH.ACCOUNT_RESTORED,
    description: 'Restore confirmation message',
  })
  @Expose()
  message: string;

  @ApiProperty({
    example: true,
    description:
      'Always `true` on a 2xx — the account is active again. A failed restore ' +
      'is an error response, never `restored: false`.',
  })
  @Expose()
  restored: boolean;

  @ApiProperty({
    example: false,
    description:
      'When `true`, the restored account had not verified its email before ' +
      'deletion, so no token was issued and the caller must send the user ' +
      'through the existing verify-email flow. The restore still succeeded.',
  })
  @Expose()
  requiresEmailVerification: boolean;

  @ApiProperty({
    example: 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...',
    required: false,
    description:
      'JWT access token. Absent when `requiresEmailVerification` is `true`.',
  })
  @Expose()
  access_token?: string;

  @ApiProperty({
    example: '2026-09-07T14:03:21.000Z',
    required: false,
    description:
      'When the access token expires. Absent when no token was issued.',
  })
  @Expose()
  expires_at?: Date;

  @ApiProperty({ type: UserResponseDto })
  @Expose()
  data: UserResponseDto;
}

/**
 * Internal pairing of the client-facing body with the raw refresh token the
 * controller sets as an httpOnly cookie. `refreshToken` is `undefined` when no
 * session was issued (the unverified-account case above). Mirrors
 * `AuthTokenResult`.
 */
export interface RestoreAccountResult {
  result: RestoreAccountResponseDto;
  refreshToken?: string;
}

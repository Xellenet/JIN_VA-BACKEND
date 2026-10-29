import { IsOptional, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * Shape of the query params Google appends to `GET /auth/google/callback`.
 *
 * `code` and `state` are deliberately optional here (not `@IsNotEmpty()`):
 * this DTO is only used to type/document the callback's expected shape —
 * `AuthController.googleCallback` reads the raw query object directly
 * (bypassing the global `ValidationPipe`) so that a malformed, denied, or
 * otherwise off-contract callback request can never be rejected with a raw
 * 400 before the controller gets a chance to redirect back to the frontend
 * with an error indicator (G4). Presence/shape is validated defensively
 * inside `AuthService.handleOAuthCallback` instead.
 */
export class OAuthCallbackDto {
  @ApiProperty({
    description: 'Authorization code returned by the OAuth provider',
    required: false,
  })
  @IsOptional()
  @IsString()
  code?: string;

  @ApiProperty({
    description: 'State parameter to prevent CSRF attacks',
    required: false,
  })
  @IsOptional()
  @IsString()
  state?: string;

  @ApiProperty({ description: 'Error message, if any' })
  @IsOptional()
  @IsString()
  error?: string;

  @ApiProperty({ description: 'Error description, if any' })
  @IsOptional()
  @IsString()
  error_description?: string;
}

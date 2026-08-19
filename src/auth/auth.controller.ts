import {
  Body,
  Controller,
  Get,
  Post,
  HttpCode,
  Logger,
  Query,
  UseGuards,
  Req,
  Res,
  BadRequestException,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { CreateUserDto } from '@users/dto/create-user.dto';
import { UserResponseDto } from '@users/dto/user-response.dto';
import { SUCCESS_MESSAGES } from '@common/constants/success-messages.constants';
import { ERROR_MESSAGES } from '@common/constants/error-messages.constants';
import { VARIABLES } from '@common/constants/variables.constants';
import { LoginDto } from './dto/login.dto';
import { LoginResponseDto } from './dto/login-response.dto';
import { OAuthCallbackDto } from './dto/oauth-callback.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { ResendVerificationDto } from './dto/resend-verification.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { ChangePasswordDto } from './dto/change-password.dto';
import {
  setRefreshTokenCookie,
  clearRefreshTokenCookie,
  readRefreshTokenCookie,
} from './utils/refresh-cookie.util';
import {
  setAuthSessionCookie,
  clearAuthSessionCookie,
} from './utils/session-cookie.util';

/**
 * G4: query-param convention for the redirect back to the frontend after
 * `GET /auth/google/callback`. Documented in
 * `docs/team/google-oauth-fix/api-contract.md`.
 */
const OAUTH_ERROR_CODES = {
  /** Google reported an error on the callback (denied/cancelled consent). */
  ACCESS_DENIED: 'access_denied',
  /** Any other failure: invalid/expired/replayed state, provider errors,
   *  account-creation errors, etc. Deliberately not split into finer-grained
   *  codes — the frontend shows a generic "sign-in failed" message for this
   *  case (see api-contract.md). */
  OAUTH_FAILED: 'oauth_failed',
} as const;

/**
 * Handles all authentication flows: registration, login, token refresh,
 * email verification, password reset, password change, and logout.
 * Auth routes are excluded from the global response interceptor and return
 * their own structured payloads.
 */
@ApiTags('Authentication')
@Controller('auth')
export class AuthController {
  private readonly logger = new Logger(AuthController.name);

  constructor(private readonly authService: AuthService) {}

  /**
   * Registers a new user account and sends a verification email.
   * A verification email is dispatched asynchronously on success.
   *
   * @param createUserDto - Required fields for the new account.
   * @returns The created user profile (password excluded).
   */
  @Post('register')
  @ApiOperation({
    summary: 'Register a new user account',
    description:
      'Creates a new CUSTOMER or ARTISAN account. ' +
      'A one-time email verification link is sent to the provided address on success. ' +
      'Passwords must be at least 8 characters and contain an uppercase letter, a digit, and a special character.',
  })
  @ApiCreatedResponse({
    description: 'User registered successfully',
    type: UserResponseDto,
  })
  @ApiBadRequestResponse({
    description:
      'Validation failed (missing fields, weak password, invalid email format)',
  })
  @ApiConflictResponse({
    description: 'An account with this email address already exists',
  })
  registerUser(@Body() createUserDto: CreateUserDto) {
    return this.authService.registerUser(createUserDto);
  }

  /**
   * Authenticates an existing user and returns a JWT access token.
   * The refresh token is never returned in the response body — it is set
   * exclusively via an HttpOnly `Set-Cookie` header (S1), alongside a second,
   * non-sensitive HttpOnly cookie carrying `{ sub, role }` that Next.js
   * middleware reads to enforce auth/role at the edge (S2).
   *
   * @param loginDto - Email and password credentials.
   * @param res      - Express response; used to set the httpOnly cookies (never sent to the client directly).
   * @returns Access token, expiry timestamp, and user profile (no refresh token).
   */
  @Post('login')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Login with email and password',
    description:
      'Validates credentials and issues an RS256-signed access token (15 min) in the response body. ' +
      'The refresh token (7 days) is set exclusively via an httpOnly `Set-Cookie` header — it never ' +
      'appears in the JSON body. ' +
      'Both email-not-found and wrong-password surface as a single 401 to prevent user enumeration.',
  })
  @ApiOkResponse({
    description:
      'Login successful — access token returned; refresh token set as httpOnly cookie',
    type: LoginResponseDto,
  })
  @ApiBadRequestResponse({ description: 'Email or password field is missing' })
  @ApiUnauthorizedResponse({ description: 'Invalid email or password' })
  async loginUser(
    @Body() loginDto: LoginDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<LoginResponseDto> {
    const { result, refreshToken } = await this.authService.loginUser(loginDto);
    setRefreshTokenCookie(res, refreshToken);
    setAuthSessionCookie(res, { sub: result.data.id, role: result.data.role });
    return result;
  }

  /**
   * Verifies a user's email address using the one-time token sent during registration.
   * The token is immediately revoked after use. A welcome email is sent on success.
   *
   * @param token - The email verification token from the registration email.
   * @returns A confirmation message.
   */
  @Post('verify-email')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Verify email address using the one-time registration token',
    description:
      'Marks the account as verified and stamps `verifiedAt`. ' +
      'The token is single-use and expires after the configured TTL. ' +
      'A welcome email is dispatched on success.',
  })
  @ApiBody({
    schema: {
      required: ['token'],
      properties: {
        token: {
          type: 'string',
          example: 'a3f9d2c1b0e8...',
          description: 'One-time email verification token',
        },
      },
    },
  })
  @ApiOkResponse({ description: 'Email verified successfully' })
  @ApiBadRequestResponse({
    description: 'Token is missing, invalid, or already expired',
  })
  async verifyEmail(
    @Body('token') token: string,
  ): Promise<{ message: string }> {
    await this.authService.verifyEmail(token);
    return { message: SUCCESS_MESSAGES.AUTH.EMAIL_VERIFIED };
  }

  /**
   * Sends a password-reset link to the provided email address.
   * Always returns 200 regardless of whether the email is registered,
   * to prevent email enumeration. If an unexpired reset token already exists
   * for the account it is reused rather than creating a new one.
   *
   * @param email - The account email to send the reset link to.
   * @returns A confirmation message.
   */
  @Post('forgot-password')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Request a password-reset link',
    description:
      'Generates a short-lived password-reset token and emails it to the provided address. ' +
      'If a valid unexpired token already exists for this account it is reused. ' +
      'Always returns 200 — even for unregistered emails — to prevent email enumeration.',
  })
  @ApiBody({
    schema: {
      required: ['email'],
      properties: {
        email: {
          type: 'string',
          example: 'user@example.com',
          description: 'Registered account email',
        },
      },
    },
  })
  @ApiOkResponse({
    description: 'Password reset link sent to the registered email address',
  })
  @ApiBadRequestResponse({
    description: 'Email is not registered on the platform',
  })
  async forgotPassword(
    @Body('email') email: string,
  ): Promise<{ message: string }> {
    await this.authService.forgotPassword(email);
    return { message: SUCCESS_MESSAGES.AUTH.PASSWORD_RESET_EMAIL_SENT };
  }

  /**
   * Resets the user's password using the token from the forgot-password email.
   * On success the reset token is revoked and all existing refresh tokens for
   * the account are invalidated, forcing re-login on all devices.
   *
   * @param token           - The reset token from the email (query param).
   * @param resetPasswordDto - New password and confirmation.
   * @returns A confirmation message.
   */
  @Post('reset-password')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Reset password using the token from the forgot-password email',
    description:
      'Validates the reset token, hashes the new password, and revokes both the reset token ' +
      'and all existing refresh tokens for the account (forces re-login on all devices). ' +
      'Pass the token from the email as a query parameter.',
  })
  @ApiQuery({
    name: 'token',
    required: true,
    description: 'Password-reset token received by email',
    example: 'a3f9d2c1b0e8...',
  })
  @ApiOkResponse({ description: 'Password reset successfully' })
  @ApiBadRequestResponse({
    description:
      '`newPassword` and `confirmNewPassword` do not match, or token is invalid / expired',
  })
  async resetPassword(
    @Query('token') token: string,
    @Body() resetPasswordDto: ResetPasswordDto,
  ): Promise<{ message: string }> {
    await this.authService.resetPassword(token, resetPasswordDto);
    return { message: SUCCESS_MESSAGES.AUTH.PASSWORD_RESET_SUCCESS };
  }

  /**
   * Issues a new access + refresh token pair using the refresh token from the
   * httpOnly cookie set at login. The old refresh token is atomically revoked
   * (S5) — replaying it a second time fails with 401 — and the new refresh
   * token is set back onto the httpOnly cookie; it is never present in the body.
   *
   * @param req - Express request; the refresh token is read from its httpOnly cookie.
   * @param res - Express response; used to rotate the httpOnly cookies.
   * @returns New access token, expiry timestamp, and user profile (no refresh token).
   */
  @Post('refresh-token')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Exchange the httpOnly refresh-token cookie for a new access + refresh token pair',
    description:
      'Reads the refresh token from its httpOnly cookie, revokes it, and issues a fresh pair. ' +
      'The new refresh token is set back onto the httpOnly cookie — it is never returned in the body. ' +
      'A previously-rotated (already-used) refresh token is rejected with 401. ' +
      'Use this endpoint before the access token expires to maintain a seamless session. ' +
      'Refresh tokens expire after 7 days.',
  })
  @ApiOkResponse({
    description:
      'New access token issued; refresh token rotated as httpOnly cookie',
    type: LoginResponseDto,
  })
  @ApiBadRequestResponse({
    description:
      'Refresh token cookie is missing, invalid, revoked, or expired',
  })
  async refreshToken(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<LoginResponseDto> {
    const token = readRefreshTokenCookie(req);
    if (!token) {
      throw new BadRequestException(ERROR_MESSAGES.AUTH.INVALID_REFRESH_TOKEN);
    }
    const { result, refreshToken } =
      await this.authService.refreshTokens(token);
    setRefreshTokenCookie(res, refreshToken);
    setAuthSessionCookie(res, { sub: result.data.id, role: result.data.role });
    return result;
  }

  /**
   * Revokes the refresh token from the httpOnly cookie, effectively logging the
   * user out, and clears both the refresh-token and session cookies.
   *
   * @param req - Express request; the refresh token is read from its httpOnly cookie (if present).
   * @param res - Express response; used to clear the httpOnly cookies.
   * @returns A confirmation message.
   */
  @Post('logout')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Revoke the current session and clear auth cookies',
    description:
      'Revokes the refresh token read from its httpOnly cookie (so it can no longer be used) and clears ' +
      'both the refresh-token and session cookies via `Set-Cookie` with `Max-Age=0`. ' +
      'The access token in the Authorization header is used solely to authenticate the request.',
  })
  @ApiOkResponse({
    description: 'Logged out successfully — token revoked and cookies cleared',
  })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid JWT in Authorization header',
  })
  async logout(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ message: string }> {
    const token = readRefreshTokenCookie(req);
    if (token) {
      await this.authService.logout(token);
    }
    clearRefreshTokenCookie(res);
    clearAuthSessionCookie(res);
    return { message: SUCCESS_MESSAGES.AUTH.LOGGED_OUT };
  }

  /**
   * Changes the authenticated user's password.
   * Verifies the current password before accepting the new one.
   * On success all existing refresh tokens are revoked and a fresh token
   * pair is issued so the caller remains authenticated with the new credentials.
   *
   * @param changePasswordDto - Current password and the desired new password (+ confirmation).
   * @param req               - Express request; `req.user.id` injected by `JwtAuthGuard`.
   * @returns New access token, refresh token, and user profile.
   */
  @Post('change-password')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Change password for the authenticated user',
    description:
      'Verifies the current password, hashes the new password, ' +
      'revokes all existing refresh tokens (logs out all other devices), ' +
      'and returns a fresh access token so the current session stays active. ' +
      'The new refresh token is set as an httpOnly cookie — it is never returned in the body.',
  })
  @ApiOkResponse({
    description:
      'Password changed — new access token returned; refresh token set as httpOnly cookie',
    type: LoginResponseDto,
  })
  @ApiBadRequestResponse({
    description:
      'Current password is incorrect, passwords do not match, or validation fails',
  })
  @ApiUnauthorizedResponse({
    description: 'Missing or invalid JWT in Authorization header',
  })
  async changePassword(
    @Body() changePasswordDto: ChangePasswordDto,
    @Req() req: any,
    @Res({ passthrough: true }) res: Response,
  ): Promise<LoginResponseDto> {
    const { result, refreshToken } = await this.authService.changePassword(
      changePasswordDto,
      req.user.id,
    );
    setRefreshTokenCookie(res, refreshToken);
    setAuthSessionCookie(res, { sub: result.data.id, role: result.data.role });
    return result;
  }

  /**
   * F1: (Re)sends the email-verification link for an unverified account.
   * Always returns 200 — for an unknown email, an already-verified account, or
   * a cooldown-throttled retry — so the endpoint cannot be used to enumerate
   * accounts or their verification state.
   *
   * @param dto - The account email to resend a verification link to.
   * @returns A confirmation message (generic, enumeration-safe).
   */
  @Post('resend-verification')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Resend the email-verification link for an unverified account',
    description:
      'Issues a fresh email-verification token and resends the verification email. ' +
      'Always returns 200 regardless of whether the email exists, is already verified, ' +
      'or is within its resend cooldown, to prevent account enumeration.',
  })
  @ApiBody({ type: ResendVerificationDto })
  @ApiOkResponse({
    description:
      'If the account exists and is unverified, a new verification email is sent',
  })
  @ApiBadRequestResponse({ description: 'Email is missing or invalid' })
  async resendVerification(
    @Body() dto: ResendVerificationDto,
  ): Promise<{ message: string }> {
    await this.authService.resendVerification(dto.email);
    return { message: SUCCESS_MESSAGES.AUTH.VERIFICATION_EMAIL_RESENT };
  }

  /**
   * G1: Starts the Google OAuth flow by redirecting the browser to Google's
   * consent screen.
   *
   * @param role - G9: optional signup-intent hint (`customer` | `artisan`)
   *   from the signup page's role toggle. Embedded into the CSRF `state` and
   *   applied only if the callback goes on to create a brand-new account
   *   (never for an existing account — G6 — and never producing ADMIN — G9).
   * @param res - Used to issue the 302 redirect to Google.
   */
  @Get('google')
  @ApiOperation({
    summary: "Start the 'Continue with Google' OAuth flow",
    description:
      'Redirects the browser to the Google consent screen. Optionally accepts ' +
      "a `role` query param (`customer` | `artisan`) from the signup page's role " +
      'toggle — embedded into the CSRF state and applied only when the callback ' +
      'creates a brand-new account; missing/unrecognized values default to ' +
      '`customer` and this can never produce an `admin` account.',
  })
  @ApiQuery({
    name: 'role',
    required: false,
    enum: ['customer', 'artisan'],
    description:
      'Intended role for a brand-new signup. Ignored for an existing account (matched by email).',
  })
  @ApiFoundResponse({
    description: "302 redirect to Google's OAuth consent screen",
  })
  googleLogin(
    @Query('role') role: string | undefined,
    @Res() res: Response,
  ): void {
    this.authService
      .initiateOAuthFlow('google', role)
      .then((url) => res.redirect(url))
      .catch((err) => {
        this.logger.error('Failed to initiate Google OAuth flow', err);
        res.redirect(
          this.buildFrontendRedirect(OAUTH_ERROR_CODES.OAUTH_FAILED),
        );
      });
  }

  /**
   * G1/G3/G4: Completes the Google OAuth flow. On success, issues sessions the
   * same way `POST /auth/login` does (httpOnly refresh + session cookies —
   * G3) and redirects the browser back into the frontend app (G4). On any
   * failure — denied consent, invalid/expired/replayed CSRF state, or any
   * other error — it still redirects back to the frontend, carrying an
   * `error` query param, rather than ever returning raw JSON.
   *
   * Reads the raw query object (not a validated DTO) so that an off-contract
   * or malformed callback request can never be rejected with a bare 400 by
   * the global `ValidationPipe` before this handler gets a chance to redirect.
   *
   * @param query - Raw query params Google appends (`code`, `state`, or
   *   `error`/`error_description` on failure).
   * @param res   - Used to set the httpOnly cookies and issue the redirect.
   */
  @Get('google/callback')
  @ApiOperation({
    summary: 'Google OAuth callback',
    description:
      'Called by Google after the user completes (or denies) consent. On success, ' +
      'sets the same httpOnly refresh + session cookies as `POST /auth/login` and ' +
      '302-redirects to `${FRONTEND_URL}' +
      `${VARIABLES.OAUTH_FRONTEND_LANDING_PATH}\`. On any failure it still redirects ` +
      'there, with `?error=access_denied` (consent denied/cancelled) or ' +
      '`?error=oauth_failed` (anything else) — never a raw JSON error response.',
  })
  @ApiFoundResponse({
    description:
      "302 redirect to the frontend's OAuth landing route, with `?error=...` on failure",
  })
  async googleCallback(
    @Query() query: Record<string, string>,
    @Res() res: Response,
  ): Promise<void> {
    const callbackDto: OAuthCallbackDto = {
      code: query.code,
      state: query.state,
      error: query.error,
      error_description: query.error_description,
    };

    try {
      const { result, refreshToken } =
        await this.authService.handleOAuthCallback('google', callbackDto);
      setRefreshTokenCookie(res, refreshToken);
      setAuthSessionCookie(res, {
        sub: result.data.id,
        role: result.data.role,
      });
      res.redirect(this.buildFrontendRedirect());
    } catch (err) {
      this.logger.warn(
        `Google OAuth callback failed: ${err instanceof Error ? err.message : err}`,
      );
      const code = callbackDto.error
        ? OAUTH_ERROR_CODES.ACCESS_DENIED
        : OAUTH_ERROR_CODES.OAUTH_FAILED;
      res.redirect(this.buildFrontendRedirect(code));
    }
  }

  /**
   * G4: builds the frontend redirect target for the OAuth callback —
   * `${FRONTEND_URL}${OAUTH_FRONTEND_LANDING_PATH}`, with `?error=<code>`
   * appended on failure.
   */
  private buildFrontendRedirect(errorCode?: string): string {
    const base = `${process.env.FRONTEND_URL ?? ''}${VARIABLES.OAUTH_FRONTEND_LANDING_PATH}`;
    return errorCode ? `${base}?error=${encodeURIComponent(errorCode)}` : base;
  }
}

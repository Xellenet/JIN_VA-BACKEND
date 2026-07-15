import { Body, Controller, Post, HttpCode, Query, UseGuards, Req } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiConflictResponse,
  ApiCreatedResponse,
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
import { LoginDto } from './dto/login.dto';
import { LoginResponseDto } from './dto/login-response.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { ChangePasswordDto } from './dto/change-password.dto';

/**
 * Handles all authentication flows: registration, login, token refresh,
 * email verification, password reset, password change, and logout.
 * Auth routes are excluded from the global response interceptor and return
 * their own structured payloads.
 */
@ApiTags('Authentication')
@Controller('auth')
export class AuthController {
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
    @ApiCreatedResponse({ description: 'User registered successfully', type: UserResponseDto })
    @ApiBadRequestResponse({ description: 'Validation failed (missing fields, weak password, invalid email format)' })
    @ApiConflictResponse({ description: 'An account with this email address already exists' })
    registerUser(@Body() createUserDto: CreateUserDto) {
        return this.authService.registerUser(createUserDto);
    }

    /**
     * Authenticates an existing user and returns a JWT access + refresh token pair.
     *
     * @param loginDto - Email and password credentials.
     * @returns Access token, refresh token, expiry timestamp, and user profile.
     */
    @Post('login')
    @HttpCode(200)
    @ApiOperation({
        summary: 'Login with email and password',
        description:
            'Validates credentials and issues an RS256-signed access token (15 min) and a refresh token (7 days). ' +
            'Both email-not-found and wrong-password surface as a single 401 to prevent user enumeration.',
    })
    @ApiOkResponse({ description: 'Login successful — JWT token pair returned', type: LoginResponseDto })
    @ApiBadRequestResponse({ description: 'Email or password field is missing' })
    @ApiUnauthorizedResponse({ description: 'Invalid email or password' })
    loginUser(@Body() loginDto: LoginDto) {
        return this.authService.loginUser(loginDto);
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
                token: { type: 'string', example: 'a3f9d2c1b0e8...', description: 'One-time email verification token' },
            },
        },
    })
    @ApiOkResponse({ description: 'Email verified successfully' })
    @ApiBadRequestResponse({ description: 'Token is missing, invalid, or already expired' })
    async verifyEmail(@Body('token') token: string): Promise<{ message: string }> {
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
                email: { type: 'string', example: 'user@example.com', description: 'Registered account email' },
            },
        },
    })
    @ApiOkResponse({ description: 'Password reset link sent to the registered email address' })
    @ApiBadRequestResponse({ description: 'Email is not registered on the platform' })
    async forgotPassword(@Body('email') email: string): Promise<{ message: string }> {
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
    @ApiBadRequestResponse({ description: '`newPassword` and `confirmNewPassword` do not match, or token is invalid / expired' })
    async resetPassword(
        @Query('token') token: string,
        @Body() resetPasswordDto: ResetPasswordDto,
    ): Promise<{ message: string }> {
        await this.authService.resetPassword(token, resetPasswordDto);
        return { message: SUCCESS_MESSAGES.AUTH.PASSWORD_RESET_SUCCESS };
    }

    /**
     * Issues a new access + refresh token pair using a valid refresh token.
     * The old refresh token is consumed and a new one is issued.
     *
     * @param token - The refresh token to exchange.
     * @returns New access token, refresh token, expiry timestamp, and user profile.
     */
    @Post('refresh-token')
    @HttpCode(200)
    @ApiOperation({
        summary: 'Exchange a valid refresh token for a new access + refresh token pair',
        description:
            'Validates the refresh token, revokes it, and issues a fresh token pair. ' +
            'Use this endpoint before the access token expires to maintain a seamless session. ' +
            'Refresh tokens expire after 7 days.',
    })
    @ApiBody({
        schema: {
            required: ['refreshToken'],
            properties: {
                refreshToken: {
                    type: 'string',
                    example: 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...',
                    description: 'The refresh token obtained at login or from a previous refresh',
                },
            },
        },
    })
    @ApiOkResponse({ description: 'New token pair issued successfully', type: LoginResponseDto })
    @ApiBadRequestResponse({ description: 'Refresh token is invalid, revoked, or expired' })
    refreshToken(@Body('refreshToken') token: string): Promise<LoginResponseDto> {
        return this.authService.refreshTokens(token);
    }

    /**
     * Revokes the provided token, effectively logging the user out.
     * The client should discard both tokens after calling this endpoint.
     *
     * @param token - The token to revoke (typically the refresh token).
     * @returns A confirmation message.
     */
    @Post('logout')
    @HttpCode(200)
    @UseGuards(JwtAuthGuard)
    @ApiBearerAuth()
    @ApiOperation({
        summary: 'Revoke a token and invalidate the current session',
        description:
            'Revokes the provided token so it can no longer be used. ' +
            'Pass the refresh token in the request body. The access token in the Authorization header ' +
            'is used solely to authenticate the request.',
    })
    @ApiBody({
        schema: {
            required: ['token'],
            properties: {
                token: {
                    type: 'string',
                    example: 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...',
                    description: 'The token to revoke (typically the refresh token)',
                },
            },
        },
    })
    @ApiOkResponse({ description: 'Logged out successfully — token revoked' })
    @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT in Authorization header' })
    async logout(@Body('token') token: string): Promise<{ message: string }> {
        await this.authService.logout(token);
        return { message: 'User logged out successfully' };
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
            'and returns a fresh token pair so the current session stays active.',
    })
    @ApiOkResponse({ description: 'Password changed — new token pair returned', type: LoginResponseDto })
    @ApiBadRequestResponse({ description: 'Current password is incorrect, passwords do not match, or validation fails' })
    @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT in Authorization header' })
    changePassword(@Body() changePasswordDto: ChangePasswordDto, @Req() req: any): Promise<LoginResponseDto> {
        return this.authService.changePassword(changePasswordDto, req.user.id);
    }
}

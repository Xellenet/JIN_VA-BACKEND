import { Body, Controller, Post, HttpCode, Query, UseGuards, Req } from '@nestjs/common';
import { AuthService } from './auth.service';
import { ApiResponse, ApiTags } from '@nestjs/swagger';
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
     *
     * @param createUserDto - Required fields for the new account.
     * @returns The created user profile (passwords excluded).
     */
    @Post('register')
    @ApiResponse({ status: 201, description: SUCCESS_MESSAGES.AUTH.USER_REGISTERED, type: UserResponseDto })
    registerUser(@Body() createUserDto: CreateUserDto): UserResponseDto | Promise<UserResponseDto> {
        return this.authService.registerUser(createUserDto);
    }

    /**
     * Authenticates an existing user and returns a JWT access + refresh token pair.
     *
     * @param loginDto - Email and password credentials.
     * @returns Access token, refresh token, and the authenticated user's profile.
     */
    @Post('login')
    @HttpCode(200)
    @ApiResponse({ status: 200, description: SUCCESS_MESSAGES.AUTH.USER_LOGGED_IN, type: LoginResponseDto })
    async loginUser(@Body() loginDto: LoginDto): Promise<LoginResponseDto> {
        return this.authService.loginUser(loginDto);
    }

    /**
     * Verifies a user's email address using the token sent during registration.
     *
     * @param token - The email verification token from the registration email.
     * @returns A confirmation message.
     */
    @Post('verify-email')
    @HttpCode(200)
    @ApiResponse({ status: 200, description: SUCCESS_MESSAGES.AUTH.EMAIL_VERIFIED })
    async verifyEmail(@Body('token') token: string): Promise<{ message: string }> {
        await this.authService.verifyEmail(token);
        return { message: SUCCESS_MESSAGES.AUTH.EMAIL_VERIFIED };
    }

    /**
     * Sends a password-reset link to the provided email address.
     *
     * @param email - The account email to send the reset link to.
     * @returns A confirmation message (always succeeds to prevent email enumeration).
     */
    @Post('forgot-password')
    @HttpCode(200)
    @ApiResponse({ status: 200, description: SUCCESS_MESSAGES.AUTH.PASSWORD_RESET_EMAIL_SENT })
    async forgotPassword(@Body('email') email: string): Promise<{ message: string }> {
        await this.authService.forgotPassword(email);
        return { message: SUCCESS_MESSAGES.AUTH.PASSWORD_RESET_EMAIL_SENT };
    }

    /**
     * Resets the user's password using a valid password-reset token.
     *
     * @param token - The reset token from the forgot-password email.
     * @param resetPasswordDto - New password and confirmation.
     * @returns A confirmation message.
     */
    @Post('reset-password')
    @HttpCode(200)
    @ApiResponse({ status: 200, description: SUCCESS_MESSAGES.AUTH.PASSWORD_RESET_SUCCESS })
    async resetPassword(
        @Query('token') token: string,
        @Body() resetPasswordDto: ResetPasswordDto,
    ): Promise<{ message: string }> {
        await this.authService.resetPassword(token, resetPasswordDto);
        return { message: SUCCESS_MESSAGES.AUTH.PASSWORD_RESET_SUCCESS };
    }

    /**
     * Issues a new access + refresh token pair using a valid refresh token.
     *
     * @param token - The refresh token to exchange.
     * @returns New access token, refresh token, and the user's profile.
     */
    @Post('refresh-token')
    @HttpCode(200)
    @ApiResponse({ status: 200, description: SUCCESS_MESSAGES.AUTH.TOKENS_REFRESHED, type: LoginResponseDto })
    async refreshToken(@Body('refreshToken') token: string): Promise<LoginResponseDto> {
        return this.authService.refreshTokens(token);
    }

    /**
     * Revokes the provided token, effectively logging the user out.
     *
     * @param token - The token to revoke.
     * @returns A confirmation message.
     */
    @Post('logout')
    @HttpCode(200)
    @UseGuards(JwtAuthGuard)
    @ApiResponse({ status: 200, description: 'User logged out successfully' })
    async logout(@Body('token') token: string): Promise<{ message: string }> {
        await this.authService.logout(token);
        return { message: 'User logged out successfully' };
    }

    /**
     * Changes the authenticated user's password, revokes all existing refresh tokens,
     * and issues a new token pair.
     *
     * @param changePasswordDto - Current password and the desired new password.
     * @param req - Express request; `req.user.id` is injected by `JwtAuthGuard`.
     * @returns New access token, refresh token, and the user's profile.
     */
    @Post('change-password')
    @HttpCode(200)
    @UseGuards(JwtAuthGuard)
    @ApiResponse({ status: 200, description: SUCCESS_MESSAGES.AUTH.PASSWORD_CHANGED })
    async changePassword(@Body() changePasswordDto: ChangePasswordDto, @Req() req): Promise<LoginResponseDto> {
        return this.authService.changePassword(changePasswordDto, req.user.id);
    }
}

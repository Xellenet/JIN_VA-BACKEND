import { Body, Controller, Post, HttpCode, Query, UseGuards, Req } from '@nestjs/common';
import { AuthService } from './auth.service';
import { ApiResponse, ApiTags } from '@nestjs/swagger';
import { CreateUserDto } from '@users/dto/create-user.dto';
import { UserResponseDto } from '@users/dto/user-response.dto';
import { VARIABLES } from '@common/constants/variables.constants';
import { LoginDto } from './dto/login.dto';
import { LoginResponseDto } from './dto/login-response.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { ChangePasswordDto } from './dto/change-password.dto';

/**
 * Auth Controller
 */
@ApiTags('Authentication')
@Controller('auth')
export class AuthController {
    constructor(private readonly authService: AuthService) {}

    /**
     * Register a new user
     * @param createUserDto - Data Transfer Object for creating a user
     * @returns UserResponseDto - Registered user details
     */
    @Post('register')
    @ApiResponse({status: 201, description: 'User Registered Successfully', type:UserResponseDto})
    registerUser(@Body() createUserDto: CreateUserDto): UserResponseDto | Promise<UserResponseDto> {
        return this.authService.registerUser(createUserDto);
    }

    /**
     * Login an existing user
     * @param loginDto - Data Transfer Object for user login
     * @returns LoginResponseDto - Logged in user details
     */
    @Post('login')
    @HttpCode(200)
    @ApiResponse({status: 200, description: VARIABLES.USER_LOGGED_IN, type:LoginResponseDto})
    async loginUser(@Body() loginDto: LoginDto): Promise<LoginResponseDto> {
        return  await this.authService.loginUser(loginDto);
    }

    /**
     * Verify user email
     * @param token - Email verification token
     * @returns { message: string } - Verification result message
     */
    @Post('verify-email')
    @HttpCode(200)
    @ApiResponse({status: 200, description: VARIABLES.EMAIL_VERIFIED})
    async verifyEmail(@Body('token') token: string): Promise<{message: string}> {
        await this.authService.verifyEmail(token);
        return { message: VARIABLES.EMAIL_VERIFIED };
    }

    /**
     * Request a password reset link
     * @param email - User's email address
     * @returns { message: string } - Success message
     */
    @Post('forgot-password')
    @HttpCode(200)
    @ApiResponse({status: 200, description: VARIABLES.PASSWORD_RESET_EMAIL_SENT})
    async forgotPassword(@Body('email') email: string): Promise<{message: string}> {
        await this.authService.forgotPassword(email);
        return { message: VARIABLES.PASSWORD_RESET_EMAIL_SENT };
    }

    /**
     * Reset user password
     * @param token - Password reset token
     * @param resetPasswordDto - Data Transfer Object for resetting password
     * @returns { message: string } - Success message
     */
    @Post('reset-password')
    @HttpCode(200)
    @ApiResponse({status: 200, description: VARIABLES.PASSWORD_RESET_SUCCESS})
    async resetPassword(@Query('token') token: string, @Body() resetPasswordDto: ResetPasswordDto): Promise<{message: string}> {
        await this.authService.resetPassword(token, resetPasswordDto);
        return { message: VARIABLES.PASSWORD_RESET_SUCCESS };
    }

    /**
     * Refresh authentication tokens
     * @param token - Refresh token
     * @returns LoginResponseDto - New authentication tokens
     */
    @Post('refresh-token')
    @HttpCode(200)
    @ApiResponse({status: 200, description: VARIABLES.TOKENS_REFRESHED, type:LoginResponseDto})
    async refreshToken(@Body('refreshToken') token: string): Promise<LoginResponseDto> {
        return await this.authService.refreshTokens(token);
    }

    @Post('logout')
    @HttpCode(200)
    @UseGuards(JwtAuthGuard)
    @ApiResponse({status: 200, description: 'User logged out successfully'})
    async logout(@Body('token') token: string): Promise<{message: string}> {
        await this.authService.logout(token);
        return { message: 'User logged out successfully' };
    }


    @Post('change-password')
    @HttpCode(200)
    @UseGuards(JwtAuthGuard)
    @ApiResponse({status: 200, description: VARIABLES.PASSWORD_CHANGED_SUCCESSFULLY})
    async changePassword(@Body() changePasswordDto: ChangePasswordDto, @Req() req): Promise<LoginResponseDto> {
        const userId = req.user.id;
        return await this.authService.changePassword(changePasswordDto, userId);  
    }
}
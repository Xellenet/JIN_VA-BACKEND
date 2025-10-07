import { Body, Controller, Post, HttpCode, Query } from '@nestjs/common';
import { AuthService } from './auth.service';
import { ApiResponse } from '@nestjs/swagger';
import { CreateUserDto } from '@users/dto/create-user.dto';
import { UserResponseDto } from '@users/dto/user-response.dto';
import { VARIABLES } from '@common/constants/variables.constants';
import { LoginDto } from './dto/login.dto';
import { LoginResponseDto } from './dto/login-response.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';

@Controller('auth')
export class AuthController {
    constructor(private readonly authSerivice:AuthService){}

    @Post('register')
    @ApiResponse({status: 201, description: 'User Registered Successfully', type:UserResponseDto})
    registerUser(@Body() createUserDto: CreateUserDto): UserResponseDto | Promise<UserResponseDto> {
        return this.authSerivice.registerUser(createUserDto);
    }

    @Post('login')
    @HttpCode(200)
    @ApiResponse({status: 200, description: VARIABLES.USER_LOGGED_IN, type:LoginResponseDto})
    async loginUser(@Body() loginDto: LoginDto): Promise<LoginResponseDto> {
        return  await this.authSerivice.loginUser(loginDto);
    }

    @Post('verify-email')
    @HttpCode(200)
    @ApiResponse({status: 200, description: VARIABLES.EMAIL_VERIFIED})
    async verifyEmail(@Body('token') token: string): Promise<{message: string}> {
        await this.authSerivice.verifyEmail(token);
        return { message: VARIABLES.EMAIL_VERIFIED };
    }

    @Post('forgot-password')
    @HttpCode(200)
    @ApiResponse({status: 200, description: VARIABLES.PASSWORD_RESET_EMAIL_SENT})
    async forgotPassword(@Body('email') email: string): Promise<{message: string}> {
        await this.authSerivice.forgotPassword(email);
        return { message: VARIABLES.PASSWORD_RESET_EMAIL_SENT };
    }

    @Post('reset-password')
    @HttpCode(200)
    @ApiResponse({status: 200, description: VARIABLES.PASSWORD_RESET_SUCCESS})
    async resetPassword(@Query('token') token: string, @Body() resetPasswordDto: ResetPasswordDto): Promise<{message: string}> {
        await this.authSerivice.resetPassword(token, resetPasswordDto);
        return { message: VARIABLES.PASSWORD_RESET_SUCCESS };
    }
}

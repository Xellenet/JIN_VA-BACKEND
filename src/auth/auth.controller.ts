import { Body, Controller, Post } from '@nestjs/common';
import { AuthService } from './auth.service';
import { ApiResponse } from '@nestjs/swagger';
import { CreateUserDto } from '@users/dto/create-user.dto';
import { UserResponseDto } from '@users/dto/user-response.dto';

@Controller('auth')
export class AuthController {
    constructor(private readonly authSerivice:AuthService){}

    @Post('register')
    @ApiResponse({status: 201, description: 'User Registered Successfully', type:UserResponseDto})
    registerUser(@Body() createUserDto: CreateUserDto): UserResponseDto | Promise<UserResponseDto> {
        return this.authSerivice.registerUser(createUserDto);
    }
    
}

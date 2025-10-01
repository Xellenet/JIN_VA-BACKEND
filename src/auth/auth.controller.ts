import { Body, Controller, Post } from '@nestjs/common';
import { AuthService } from './auth.service';
import { ApiProperty, ApiResponse } from '@nestjs/swagger';
import { User } from 'src/users/entities/user.entity';
import { CreateUserDto } from 'src/users/dto/create-user.dto';

@Controller('auth')
export class AuthController {
    constructor(private readonly authSerivice:AuthService){}

    @Post('register')
    @ApiResponse({status: 201, description: 'User Registered Successfully', type:User})
    registerUser(@Body() createUserDto: CreateUserDto){
        return this.authSerivice.registerUser(createUserDto);
    }
    
}

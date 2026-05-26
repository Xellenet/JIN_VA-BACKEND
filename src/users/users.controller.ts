import { Controller, Post, Body, Get, Patch, Req, UseGuards } from '@nestjs/common';
import { UsersService } from './users.service';
import { CreateUserDto } from './dto/create-user.dto';
import { ApiResponse, ApiCreatedResponse } from '@nestjs/swagger';
import { User } from './entities/user.entity';
import { UpdateArtisanProfileDto } from './dto/update-artisan-profile.dto';
import { UpdateCustomerProfileDto } from './dto/update-customer-profile.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ArtisanProfileResponseDto } from './dto/artisan-profile-response.dto';
import { CustomerProfileResponseDto } from './dto/customer-profile-response.dto';


@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Post()
  @ApiCreatedResponse({ description: 'User created successfully', type: User })
  @ApiResponse({ status: 400, description: 'Bad Request', type: Error } )
  createUser(@Body() createUserDto: CreateUserDto) {
    return this.usersService.createUser(createUserDto);
  }

  @Get('me/artisan-profile')
  @UseGuards(JwtAuthGuard)
  @ApiResponse({ status: 200, description: 'Artisan profile retrieved successfully', type: ArtisanProfileResponseDto })
  getArtisanProfile(@Req() req) {
    return this.usersService.findArtisanProfileByUserId(req.user.id);
  }

  @Patch('me/artisan-profile')
  @UseGuards(JwtAuthGuard)
  @ApiResponse({ status: 200, description: 'Artisan profile updated successfully', type: ArtisanProfileResponseDto })
  updateArtisanProfile(
    @Req() req,
    @Body() updateArtisanProfileDto: UpdateArtisanProfileDto,
  ) {
    return this.usersService.updateArtisanProfile(req.user.id, updateArtisanProfileDto);
  }

  @Get('me/customer-profile')
  @UseGuards(JwtAuthGuard)
  @ApiResponse({ status: 200, description: 'Customer profile retrieved successfully', type: CustomerProfileResponseDto })
  getCustomerProfile(@Req() req) {
    return this.usersService.findCustomerProfileByUserId(req.user.id);
  }

  @Patch('me/customer-profile')
  @UseGuards(JwtAuthGuard)
  @ApiResponse({ status: 200, description: 'Customer profile updated successfully', type: CustomerProfileResponseDto })
  updateCustomerProfile(
    @Req() req,
    @Body() updateCustomerProfileDto: UpdateCustomerProfileDto,
  ) {
    return this.usersService.updateCustomerProfile(req.user.id, updateCustomerProfileDto);
  }

}

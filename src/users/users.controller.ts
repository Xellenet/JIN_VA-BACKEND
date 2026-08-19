import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  MaxFileSizeValidator,
  Param,
  ParseFilePipe,
  ParseIntPipe,
  Patch,
  Post,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '@common/decorators/roles.decorator';
import { Role } from '@common/types/enums';
import { UsersService } from './users.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateMeDto } from './dto/update-me.dto';
import { UpdateArtisanProfileDto } from './dto/update-artisan-profile.dto';
import { UpdateCustomerProfileDto } from './dto/update-customer-profile.dto';
import { UserResponseDto } from './dto/user-response.dto';
import { ArtisanProfileResponseDto } from './dto/artisan-profile-response.dto';
import { CustomerProfileResponseDto } from './dto/customer-profile-response.dto';
import { UploadsService } from '../uploads/uploads.service';
import { CreateAddressDto } from './dto/create-address.dto';
import { UpdateAddressDto } from './dto/update-address.dto';
import { AddressResponseDto } from './dto/address-response.dto';

/**
 * Handles user management and self-service profile operations.
 *
 * Routes under `/users/me` are scoped to the authenticated caller.
 * Role-restricted endpoints require both a valid JWT (`JwtAuthGuard`) and the
 * correct role (`RolesGuard`), applied in that order.
 */
@ApiTags('Users')
@Controller('users')
export class UsersController {
  constructor(
    private readonly usersService: UsersService,
    private readonly uploadsService: UploadsService,
  ) {}

  /**
   * Creates a new user account. This is an admin-only operation; regular users
   * register through `POST /auth/register`.
   *
   * @param createUserDto - All required fields for the new user.
   * @returns The persisted user (password is stripped by the response interceptor).
   */
  @Post()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create a new user (admin only)' })
  @ApiCreatedResponse({ description: 'User created successfully', type: UserResponseDto })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT token' })
  @ApiForbiddenResponse({ description: 'Caller does not have the ADMIN role' })
  createUser(@Body() createUserDto: CreateUserDto) {
    return this.usersService.createUser(createUserDto);
  }

  /**
   * Returns the base profile of the currently authenticated user,
   * including their linked addresses.
   *
   * @param req - Express request; `req.user.id` is injected by `JwtAuthGuard`.
   * @returns The caller's {@link UserResponseDto}.
   */
  @Get('me')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Get the authenticated user's own profile" })
  @ApiOkResponse({ description: 'Profile retrieved successfully', type: UserResponseDto })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT token' })
  getMe(@Req() req: any) {
    return this.usersService.findMe(req.user.id);
  }

  /**
   * Partially updates the base profile of the currently authenticated user.
   * Email, password, and role changes are handled by dedicated endpoints.
   * Duplicate phone/username violations return a `409` via `TypeOrmFilter`.
   *
   * @param req - Express request; `req.user.id` is injected by `JwtAuthGuard`.
   * @param updateMeDto - Fields to update (all optional).
   * @returns The updated {@link UserResponseDto}.
   */
  @Patch('me')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Update the authenticated user's own profile" })
  @ApiOkResponse({ description: 'Profile updated successfully', type: UserResponseDto })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT token' })
  updateMe(@Req() req: any, @Body() updateMeDto: UpdateMeDto) {
    return this.usersService.updateMe(req.user.id, updateMeDto);
  }

  /**
   * Soft-deletes the authenticated user's account. The record is retained in
   * the database but treated as inactive. All active refresh tokens are revoked.
   *
   * @param req - Express request; `req.user.id` is injected by `JwtAuthGuard`.
   * @returns Confirmation message.
   */
  @Delete('me')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete the authenticated user account (soft-delete)' })
  @ApiOkResponse({ description: 'Account deleted successfully' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT token' })
  deleteMe(@Req() req: any) {
    return this.usersService.deleteMe(req.user.id);
  }

  /**
   * Uploads or replaces the authenticated user's profile picture.
   * Accepted formats: jpeg, jpg, png, webp. Maximum file size: 5 MB.
   * The stored URL is available via `/uploads/avatars/<filename>`.
   *
   * @param req - Express request; `req.user.id` is injected by `JwtAuthGuard`.
   * @param file - The uploaded file provided by Multer via `FileInterceptor`.
   * @returns The updated {@link UserResponseDto} with the new `profilePicture` URL.
   */
  @Post('me/avatar')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Upload or replace the authenticated user's profile picture" })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['avatar'],
      properties: {
        avatar: { type: 'string', format: 'binary', description: 'Image file (jpeg/jpg/png/webp, max 5 MB)' },
      },
    },
  })
  @ApiOkResponse({ description: 'Profile picture updated successfully', type: UserResponseDto })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT token' })
  @UseInterceptors(FileInterceptor('avatar', { storage: memoryStorage() }))
  async uploadAvatar(
    @Req() req: any,
    @UploadedFile(
      new ParseFilePipe({
        validators: [new MaxFileSizeValidator({ maxSize: 5 * 1024 * 1024 })],
      }),
    )
    file: Express.Multer.File,
  ) {
    const upload = await this.uploadsService.uploadAvatar(file);
    return this.usersService.updateAvatar(req.user.id, upload.url);
  }

  /**
   * Returns the artisan profile of the authenticated artisan, including their
   * linked user data, addresses, and offered services.
   *
   * @param req - Express request; `req.user.id` identifies the artisan.
   * @returns The caller's {@link ArtisanProfileResponseDto}.
   */
  @Get('me/artisan-profile')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ARTISAN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get the artisan profile of the authenticated artisan' })
  @ApiOkResponse({ description: 'Artisan profile retrieved successfully', type: ArtisanProfileResponseDto })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT token' })
  @ApiForbiddenResponse({ description: 'Caller does not have the ARTISAN role' })
  getArtisanProfile(@Req() req: any) {
    return this.usersService.findArtisanProfileByUserId(req.user.id);
  }

  /**
   * Partially updates the artisan profile of the currently authenticated artisan.
   * Pass `serviceIds: []` to unlink all services from the profile.
   *
   * @param req - Express request; `req.user.id` identifies the artisan.
   * @param updateArtisanProfileDto - Fields to update on the artisan profile.
   * @returns The updated {@link ArtisanProfileResponseDto}.
   */
  @Patch('me/artisan-profile')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ARTISAN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update the artisan profile of the authenticated artisan' })
  @ApiOkResponse({ description: 'Artisan profile updated successfully', type: ArtisanProfileResponseDto })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT token' })
  @ApiForbiddenResponse({ description: 'Caller does not have the ARTISAN role' })
  updateArtisanProfile(
    @Req() req: any,
    @Body() updateArtisanProfileDto: UpdateArtisanProfileDto,
  ) {
    return this.usersService.updateArtisanProfile(req.user.id, updateArtisanProfileDto);
  }

  /**
   * Returns the customer profile of the authenticated customer, including their
   * linked user data, addresses, and preferred services.
   *
   * @param req - Express request; `req.user.id` identifies the customer.
   * @returns The caller's {@link CustomerProfileResponseDto}.
   */
  @Get('me/customer-profile')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.CUSTOMER)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get the customer profile of the authenticated customer' })
  @ApiOkResponse({ description: 'Customer profile retrieved successfully', type: CustomerProfileResponseDto })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT token' })
  @ApiForbiddenResponse({ description: 'Caller does not have the CUSTOMER role' })
  getCustomerProfile(@Req() req: any) {
    return this.usersService.findCustomerProfileByUserId(req.user.id);
  }

  /**
   * Partially updates the customer profile of the currently authenticated customer.
   * Pass `preferredServiceIds: []` to clear all preferred services.
   * Budget validation (`max >= min`) is enforced in the service layer.
   *
   * @param req - Express request; `req.user.id` identifies the customer.
   * @param updateCustomerProfileDto - Fields to update on the customer profile.
   * @returns The updated {@link CustomerProfileResponseDto}.
   */
  @Patch('me/customer-profile')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.CUSTOMER)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update the customer profile of the authenticated customer' })
  @ApiOkResponse({ description: 'Customer profile updated successfully', type: CustomerProfileResponseDto })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT token' })
  @ApiForbiddenResponse({ description: 'Caller does not have the CUSTOMER role' })
  updateCustomerProfile(
    @Req() req: any,
    @Body() updateCustomerProfileDto: UpdateCustomerProfileDto,
  ) {
    return this.usersService.updateCustomerProfile(req.user.id, updateCustomerProfileDto);
  }

  @Post('me/addresses')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Add a new address to the authenticated user account' })
  @ApiCreatedResponse({ description: 'Address added successfully', type: AddressResponseDto })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT token' })
  addAddress(@Req() req: any, @Body() dto: CreateAddressDto) {
    return this.usersService.addAddress(req.user.id, dto);
  }

  @Patch('me/addresses/:id')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Update one of the authenticated user\'s addresses' })
  @ApiOkResponse({ description: 'Address updated successfully', type: AddressResponseDto })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT token' })
  updateAddress(
    @Req() req: any,
    @Param('id', ParseIntPipe) addressId: number,
    @Body() dto: UpdateAddressDto,
  ) {
    return this.usersService.updateAddress(req.user.id, addressId, dto);
  }

  @Delete('me/addresses/:id')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Remove one of the authenticated user\'s addresses' })
  @ApiOkResponse({ description: 'Address removed successfully' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT token' })
  removeAddress(
    @Req() req: any,
    @Param('id', ParseIntPipe) addressId: number,
  ) {
    return this.usersService.removeAddress(req.user.id, addressId);
  }
}

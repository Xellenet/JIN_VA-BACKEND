import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  MaxFileSizeValidator,
  Param,
  ParseFilePipe,
  ParseIntPipe,
  Patch,
  Post,
  Req,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConflictResponse,
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
import { DeleteAccountResponseDto } from './dto/delete-account-response.dto';
import type { AuthenticatedRequest } from '@common/types/authenticated-request.type';
import { clearRefreshTokenCookie } from '../auth/utils/refresh-cookie.util';
import { clearAuthSessionCookie } from '../auth/utils/session-cookie.util';

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
  private readonly logger = new Logger(UsersController.name);

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
  @ApiCreatedResponse({
    description: 'User created successfully',
    type: UserResponseDto,
  })
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
  @ApiOkResponse({
    description: 'Profile retrieved successfully',
    type: UserResponseDto,
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT token' })
  getMe(@Req() req: AuthenticatedRequest) {
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
  @ApiOkResponse({
    description: 'Profile updated successfully',
    type: UserResponseDto,
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT token' })
  updateMe(@Req() req: AuthenticatedRequest, @Body() updateMeDto: UpdateMeDto) {
    return this.usersService.updateMe(req.user.id, updateMeDto);
  }

  /**
   * Soft-deletes the authenticated user's account. The record is retained in
   * the database but treated as inactive. All active refresh tokens are revoked.
   *
   * C1.1: refused with 409 while the account still has live commitments.
   * C1.2/C1.5: the response carries the server-computed purge date, and a
   * confirmation email stating that date is sent unconditionally.
   *
   * L2: on success this also clears both auth cookies, which is what actually
   * ends the session on the calling device. Deletion revokes every refresh
   * token in the database, but the `jinva_session` cookie Next.js middleware
   * reads is signed and self-contained — nothing invalidated it — and the
   * now-soft-deleted principal can no longer reach `POST /auth/logout`
   * (`JwtStrategy` 401s them), so the browser kept presenting a valid-looking
   * session for the cookie's full 7-day life and the dashboard shell mounted
   * before the API 401'd.
   *
   * **No ownership proof beyond a valid access token is required** — see
   * `docs/team/auth-residual-findings/api-contract.md` for the accepted-risk
   * rationale (security `M1`): deletion is reversible for 30 days, the
   * confirmation email carries the restore notice, a confirm dialog stands in
   * front of the request, and the one irreversible case (the last admin) is
   * refused outright by `AccountCommitmentsService`.
   *
   * @param req - Express request; `req.user.id` is injected by `JwtAuthGuard`.
   * @param res - Express response; used only to clear the httpOnly cookies.
   * @returns Confirmation message plus `deletedAt` / `purgeAt`.
   */
  @Delete('me')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Delete the authenticated user account (soft-delete)',
    description:
      'Soft-deletes the account, revokes every refresh token, and emails a ' +
      'confirmation stating the exact date the account is permanently purged. ' +
      'The account can be restored by signing in again (or completing Google ' +
      'sign-in) at any point up to `purgeAt`. ' +
      'Refused with 409 (`meta.error: ACCOUNT_HAS_LIVE_COMMITMENTS`) while the ' +
      'account still has a pending/confirmed booking, an open or in-progress ' +
      'job, a payment in flight, or an unresolved dispute — the message names ' +
      'what is outstanding. Also refused with 409 ' +
      '(`meta.error: LAST_ADMIN_CANNOT_DELETE`) when the caller is an ADMIN and ' +
      'no other usable admin account remains. ' +
      'On success only, both auth cookies (`refresh_token` and `jinva_session`) ' +
      'are cleared via `Set-Cookie` with `Max-Age=0`, exactly as ' +
      '`POST /auth/logout` does — a refusal clears nothing and leaves the ' +
      'caller fully authenticated. ' +
      'Requires no ownership proof beyond a valid access token (accepted risk: ' +
      'the deletion is reversible for 30 days and the confirmation email carries ' +
      'the restore notice).',
  })
  @ApiOkResponse({
    description:
      'Account soft-deleted; response carries the recovery-window deadline, ' +
      'and both auth cookies are cleared',
    type: DeleteAccountResponseDto,
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT token' })
  @ApiConflictResponse({
    description:
      'Deletion refused — the account still has live bookings, jobs, ' +
      'payments or disputes (`ACCOUNT_HAS_LIVE_COMMITMENTS`), or the caller is ' +
      'the only usable administrator (`LAST_ADMIN_CANNOT_DELETE`). No cookie is ' +
      'cleared and the caller stays authenticated.',
  })
  async deleteMe(
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.usersService.deleteMe(req.user.id);

    // Ordering is the requirement, not a detail: `deleteMe` throws on every
    // refusal, so nothing below runs unless the account really was deleted.
    // Cookies clear on success only.
    this.clearAuthCookies(res);

    return result;
  }

  /**
   * Clears the two httpOnly auth cookies, using the same helpers
   * `POST /auth/logout` calls so the attributes match and browsers reliably
   * drop them.
   *
   * Deliberately swallowing: the deletion has already committed by the time
   * this runs, and a failure to write a `Set-Cookie` header must not turn a
   * successful, irreversible-in-30-days action into an error the user sees and
   * retries. The account is gone either way; the worst case is the stale
   * cookie this fix exists to remove, which the API still refuses to honour.
   */
  private clearAuthCookies(res: Response): void {
    try {
      clearRefreshTokenCookie(res);
      clearAuthSessionCookie(res);
    } catch (err) {
      this.logger.warn(
        `Account deleted, but clearing the auth cookies failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
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
  @ApiOperation({
    summary: "Upload or replace the authenticated user's profile picture",
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['avatar'],
      properties: {
        avatar: {
          type: 'string',
          format: 'binary',
          description: 'Image file (jpeg/jpg/png/webp, max 5 MB)',
        },
      },
    },
  })
  @ApiOkResponse({
    description: 'Profile picture updated successfully',
    type: UserResponseDto,
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT token' })
  @UseInterceptors(FileInterceptor('avatar', { storage: memoryStorage() }))
  async uploadAvatar(
    @Req() req: AuthenticatedRequest,
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
  @ApiOperation({
    summary: 'Get the artisan profile of the authenticated artisan',
    description:
      'Self-view only. Always includes `isProfileComplete` and a populated ' +
      '`missingFields` array — `[]` when the profile is complete, never ' +
      'absent. Possible keys: `bio`, `hourlyRate`, `location`, `services`. ' +
      '`missingFields` is never exposed on any public artisan profile.',
  })
  @ApiOkResponse({
    description: 'Artisan profile retrieved successfully',
    type: ArtisanProfileResponseDto,
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT token' })
  @ApiForbiddenResponse({
    description: 'Caller does not have the ARTISAN role',
  })
  getArtisanProfile(@Req() req: AuthenticatedRequest) {
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
  @ApiOperation({
    summary: 'Update the artisan profile of the authenticated artisan',
    description:
      'Recomputes and persists `isProfileComplete` against the post-merge ' +
      'profile on every save, so search visibility follows the save ' +
      'immediately — no second save and no service add/remove is needed. ' +
      'The response carries the freshly-recomputed `isProfileComplete` and ' +
      '`missingFields`, so the caller can update a completeness indicator ' +
      'straight from the save response without re-fetching.',
  })
  @ApiOkResponse({
    description: 'Artisan profile updated successfully',
    type: ArtisanProfileResponseDto,
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT token' })
  @ApiForbiddenResponse({
    description: 'Caller does not have the ARTISAN role',
  })
  updateArtisanProfile(
    @Req() req: AuthenticatedRequest,
    @Body() updateArtisanProfileDto: UpdateArtisanProfileDto,
  ) {
    return this.usersService.updateArtisanProfile(
      req.user.id,
      updateArtisanProfileDto,
    );
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
  @ApiOperation({
    summary: 'Get the customer profile of the authenticated customer',
  })
  @ApiOkResponse({
    description: 'Customer profile retrieved successfully',
    type: CustomerProfileResponseDto,
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT token' })
  @ApiForbiddenResponse({
    description: 'Caller does not have the CUSTOMER role',
  })
  getCustomerProfile(@Req() req: AuthenticatedRequest) {
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
  @ApiOperation({
    summary: 'Update the customer profile of the authenticated customer',
  })
  @ApiOkResponse({
    description: 'Customer profile updated successfully',
    type: CustomerProfileResponseDto,
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT token' })
  @ApiForbiddenResponse({
    description: 'Caller does not have the CUSTOMER role',
  })
  updateCustomerProfile(
    @Req() req: AuthenticatedRequest,
    @Body() updateCustomerProfileDto: UpdateCustomerProfileDto,
  ) {
    return this.usersService.updateCustomerProfile(
      req.user.id,
      updateCustomerProfileDto,
    );
  }

  @Post('me/addresses')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Add a new address to the authenticated user account',
  })
  @ApiCreatedResponse({
    description: 'Address added successfully',
    type: AddressResponseDto,
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT token' })
  addAddress(@Req() req: AuthenticatedRequest, @Body() dto: CreateAddressDto) {
    return this.usersService.addAddress(req.user.id, dto);
  }

  @Patch('me/addresses/:id')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Update one of the authenticated user's addresses" })
  @ApiOkResponse({
    description: 'Address updated successfully',
    type: AddressResponseDto,
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT token' })
  updateAddress(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseIntPipe) addressId: number,
    @Body() dto: UpdateAddressDto,
  ) {
    return this.usersService.updateAddress(req.user.id, addressId, dto);
  }

  @Delete('me/addresses/:id')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Remove one of the authenticated user's addresses" })
  @ApiOkResponse({ description: 'Address removed successfully' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT token' })
  removeAddress(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseIntPipe) addressId: number,
  ) {
    return this.usersService.removeAddress(req.user.id, addressId);
  }
}

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '@common/decorators/roles.decorator';
import { Role } from '@common/types/enums';
import { ArtisansService } from './artisans.service';
import { GetArtisansQueryDto } from './dto/get-artisans-query.dto';
import { ArtisanPublicResponseDto } from './dto/artisan-public-response.dto';
import { UpdateArtisanProfileDto } from '@users/dto/update-artisan-profile.dto';
import { ArtisanProfileResponseDto } from '@users/dto/artisan-profile-response.dto';

/**
 * Public-facing artisan discovery and authenticated artisan self-management.
 *
 * Public endpoints (`GET /artisans`, `GET /artisans/:id`) require no authentication.
 * Write endpoints require a valid JWT and the ARTISAN role.
 */
@ApiTags('Artisans')
@Controller('artisans')
export class ArtisansController {
  constructor(private readonly artisansService: ArtisansService) {}

  // ─── Public discovery ──────────────────────────────────────────────────────

  /**
   * Searches artisan profiles with optional keyword, location, service category,
   * rating, availability, and verification filters.
   *
   * Supports `sortBy` (rating | newest | experience | hourlyRate) and standard
   * `page` / `limit` pagination. No authentication required.
   *
   * @param query - All filters and pagination params (all optional).
   * @returns Paginated list of public artisan profiles.
   */
  @Get()
  @ApiOperation({ summary: 'Search artisans (public)' })
  @ApiOkResponse({ description: 'Paginated artisan profiles', type: [ArtisanPublicResponseDto] })
  search(@Query() query: GetArtisansQueryDto) {
    return this.artisansService.search(query);
  }

  /**
   * Returns the public profile of a single artisan by their artisan profile ID.
   * No authentication required.
   *
   * @param id - The artisan profile ID.
   * @returns The public artisan profile with offered services.
   */
  @Get(':id')
  @ApiOperation({ summary: 'Get a public artisan profile by ID' })
  @ApiOkResponse({ description: 'Artisan profile retrieved', type: ArtisanPublicResponseDto })
  @ApiNotFoundResponse({ description: 'Artisan profile not found' })
  findById(@Param('id', ParseIntPipe) id: number) {
    return this.artisansService.findById(id);
  }

  // ─── Authenticated artisan self-management ─────────────────────────────────

  /**
   * Partially updates the authenticated artisan's own profile.
   * Pass `serviceIds` to bulk-replace the entire services list, or use the
   * dedicated `POST/DELETE /artisans/me/services/:serviceId` endpoints for
   * individual service management.
   *
   * Fields that cannot be set here: `isVerified` (admin-only), `averageRating`,
   * `totalReviews` (computed).
   *
   * @param req - Express request; `req.user.id` is injected by `JwtAuthGuard`.
   * @param dto - Partial artisan profile fields to update.
   * @returns The updated artisan profile (authenticated view).
   */
  @Patch('me')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ARTISAN)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Update the authenticated artisan's own profile" })
  @ApiOkResponse({ description: 'Profile updated', type: ArtisanProfileResponseDto })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT token' })
  @ApiForbiddenResponse({ description: 'Caller does not have the ARTISAN role' })
  updateMe(@Req() req: any, @Body() dto: UpdateArtisanProfileDto) {
    return this.artisansService.updateMe(req.user.id, dto);
  }

  /**
   * Adds a single service category to the authenticated artisan's offered services.
   * Use this instead of `PATCH /artisans/me` when you only want to add one service
   * without replacing the entire list.
   *
   * @param req       - Express request; `req.user.id` is injected by `JwtAuthGuard`.
   * @param serviceId - The service category ID to add.
   * @returns The updated artisan profile.
   */
  @Post('me/services/:serviceId')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ARTISAN)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Add a service to the artisan profile' })
  @ApiOkResponse({ description: 'Service added', type: ArtisanProfileResponseDto })
  @ApiCreatedResponse({ description: 'Service added to profile' })
  @ApiNotFoundResponse({ description: 'Artisan profile or service not found' })
  @ApiConflictResponse({ description: 'Service is already on the profile' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT token' })
  @ApiForbiddenResponse({ description: 'Caller does not have the ARTISAN role' })
  addService(@Req() req: any, @Param('serviceId', ParseIntPipe) serviceId: number) {
    return this.artisansService.addService(req.user.id, serviceId);
  }

  /**
   * Removes a single service category from the authenticated artisan's offered services.
   *
   * @param req       - Express request; `req.user.id` is injected by `JwtAuthGuard`.
   * @param serviceId - The service category ID to remove.
   * @returns The updated artisan profile.
   */
  @Delete('me/services/:serviceId')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ARTISAN)
  @ApiBearerAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Remove a service from the artisan profile' })
  @ApiOkResponse({ description: 'Service removed', type: ArtisanProfileResponseDto })
  @ApiNotFoundResponse({ description: 'Artisan profile not found' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT token' })
  @ApiForbiddenResponse({ description: 'Caller does not have the ARTISAN role' })
  removeService(@Req() req: any, @Param('serviceId', ParseIntPipe) serviceId: number) {
    return this.artisansService.removeService(req.user.id, serviceId);
  }
}

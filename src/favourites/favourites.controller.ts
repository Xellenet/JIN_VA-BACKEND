import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
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
import { FavouritesService } from './favourites.service';
import { GetFavouritesQueryDto } from './dto/get-favourites-query.dto';
import { ArtisanPublicResponseDto } from '@artisans/dto/artisan-public-response.dto';

/**
 * Allows customers to save and manage their favourite artisans.
 * All endpoints require authentication and the CUSTOMER role.
 */
@ApiTags('Favourites')
@Controller('favourites')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.CUSTOMER)
@ApiBearerAuth()
export class FavouritesController {
  constructor(private readonly favouritesService: FavouritesService) {}

  /**
   * Returns the authenticated customer's paginated list of saved artisans,
   * ordered by most recently saved first.
   *
   * @param req   - Express request; `req.user.id` is injected by `JwtAuthGuard`.
   * @param query - Pagination options (`page`, `limit`).
   * @returns Paginated array of {@link ArtisanPublicResponseDto}.
   */
  @Get()
  @ApiOperation({ summary: "Get the customer's saved artisans (paginated)" })
  @ApiOkResponse({ description: 'Favourites retrieved successfully', type: [ArtisanPublicResponseDto] })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT token' })
  @ApiForbiddenResponse({ description: 'Caller does not have the CUSTOMER role' })
  findAll(@Req() req: any, @Query() query: GetFavouritesQueryDto) {
    return this.favouritesService.findAll(req.user.id, query);
  }

  /**
   * Adds an artisan to the authenticated customer's favourites.
   *
   * @param req              - Express request; `req.user.id` identifies the customer.
   * @param artisanProfileId - The artisan profile ID to save.
   * @returns Confirmation message.
   */
  @Post(':artisanProfileId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Save an artisan to favourites' })
  @ApiOkResponse({ description: 'Artisan added to favourites' })
  @ApiNotFoundResponse({ description: 'Artisan profile not found' })
  @ApiConflictResponse({ description: 'Artisan is already in favourites' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT token' })
  @ApiForbiddenResponse({ description: 'Caller does not have the CUSTOMER role' })
  add(@Req() req: any, @Param('artisanProfileId', ParseIntPipe) artisanProfileId: number) {
    return this.favouritesService.add(req.user.id, artisanProfileId);
  }

  /**
   * Removes an artisan from the authenticated customer's favourites.
   *
   * @param req              - Express request; `req.user.id` identifies the customer.
   * @param artisanProfileId - The artisan profile ID to remove.
   * @returns Confirmation message.
   */
  @Delete(':artisanProfileId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Remove an artisan from favourites' })
  @ApiOkResponse({ description: 'Artisan removed from favourites' })
  @ApiNotFoundResponse({ description: 'Artisan is not in favourites' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT token' })
  @ApiForbiddenResponse({ description: 'Caller does not have the CUSTOMER role' })
  remove(@Req() req: any, @Param('artisanProfileId', ParseIntPipe) artisanProfileId: number) {
    return this.favouritesService.remove(req.user.id, artisanProfileId);
  }
}

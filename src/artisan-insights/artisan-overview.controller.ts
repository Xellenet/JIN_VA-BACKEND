import { Controller, Get, Header, Query, Req, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '@common/decorators/roles.decorator';
import { Role } from '@common/types/enums';
import { ArtisanInsightsThrottlerGuard } from '@common/throttling/artisan-throttler.guards';
import type { AuthenticatedRequest } from '@common/types/authenticated-request.type';
import { EmptyQueryDto } from '../customer-insights/dto/empty-query.dto';
import { ArtisanOverviewService } from './artisan-overview.service';

/**
 * Artisan fixes (B1): the artisan Overview. The owner is the JWT subject
 * only; the route takes no parameters.
 */
@ApiTags('Artisans')
@ApiBearerAuth()
@Controller('artisans')
export class ArtisanOverviewController {
  constructor(private readonly overview: ArtisanOverviewService) {}

  @Get('me/overview')
  @UseGuards(JwtAuthGuard, RolesGuard, ArtisanInsightsThrottlerGuard)
  @Roles(Role.ARTISAN)
  @Header('Cache-Control', 'private, no-store')
  @ApiOperation({
    summary:
      "The authenticated artisan's job stages, booking requests, appointments, earnings and disputes needing a response",
  })
  @ApiOkResponse({ description: 'Overview retrieved' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT' })
  @ApiForbiddenResponse({ description: 'Caller is not an artisan' })
  @ApiNotFoundResponse({ description: 'No artisan profile' })
  @ApiTooManyRequestsResponse({ description: 'artisan-insights limit' })
  async getOverview(
    @Req() req: AuthenticatedRequest,
    @Query() _query: EmptyQueryDto,
  ) {
    return {
      message: 'Overview retrieved',
      data: await this.overview.getOverview(req.user.id),
    };
  }
}

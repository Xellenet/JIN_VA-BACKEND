import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { ArtisanAnalyticsService } from './artisan-analytics.service';
import { ArtisanAnalyticsQueryDto } from './dto/analytics-query.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '@common/decorators/roles.decorator';
import { AnalyticsRange, Role } from '@common/types/enums';
import type { AuthenticatedRequest } from '@common/types/authenticated-request.type';

/**
 * AN1: PRD §7's `GET /analytics/artisan`. No analytics module, file or import
 * existed anywhere in the backend before this round — both analytics screens
 * were pure presentation of a payload with no producer.
 */
@ApiTags('Analytics')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('analytics')
export class AnalyticsController {
  constructor(private readonly artisanAnalytics: ArtisanAnalyticsService) {}

  /**
   * AN1: an artisan's **own** performance data, and only their own.
   *
   * The scoping is structural, not a filter that could be forgotten: the
   * artisan profile is resolved from `req.user.id` and the endpoint accepts no
   * artisan id at all, so there is no parameter to substitute for someone
   * else's. No platform-wide figure is returned here either — those live
   * behind the admin-only endpoint.
   */
  @Get('artisan')
  @Roles(Role.ARTISAN)
  @ApiOperation({
    summary:
      "AA1–AA6: the authenticated artisan's own earnings, job counts, repeat-client rate, rating trend and top services",
    description:
      'Ranges: `7d | 30d | 90d | all` (PRD §5.12). Daily buckets for 7d/30d, weekly for ' +
      '90d, monthly for all-time. Computed live — every figure describes the selected ' +
      'range unless the field name says otherwise (`allTime`, `*AllTime`). ' +
      'Portfolio view counts are deliberately absent: no view-tracking mechanism exists ' +
      'and a fabricated figure is worse than an omitted one.',
  })
  @ApiOkResponse({ description: 'Artisan analytics for the selected range' })
  @ApiForbiddenResponse({ description: 'Caller is not an artisan' })
  @ApiNotFoundResponse({
    description: 'The authenticated user has no artisan profile',
  })
  getArtisanAnalytics(
    @Req() req: AuthenticatedRequest,
    @Query() query: ArtisanAnalyticsQueryDto,
  ) {
    return this.artisanAnalytics
      .build(req.user.id, query.range ?? AnalyticsRange.LAST_30_DAYS)
      .then((data) => ({
        message: 'Artisan analytics retrieved.',
        data,
      }));
  }
}

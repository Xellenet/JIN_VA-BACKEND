import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { PlatformAnalyticsCacheService } from './platform-analytics-cache.service';
import { AdminAnalyticsQueryDto } from './dto/analytics-query.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '@common/decorators/roles.decorator';
import { AnalyticsRange, Role } from '@common/types/enums';

/**
 * AN1: PRD §7's `GET /admin/analytics`.
 *
 * A separate controller from `AnalyticsController` purely because Nest binds
 * one path prefix per controller and the PRD names two different prefixes
 * (`/analytics/artisan` and `/admin/analytics`). Both live in
 * `AnalyticsModule`. There is no route collision with `AdminController`
 * (`@Controller('admin')`), which declares no `analytics` route.
 */
@ApiTags('Admin')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
@Controller('admin/analytics')
export class AdminAnalyticsController {
  constructor(private readonly cache: PlatformAnalyticsCacheService) {}

  /**
   * AP1–AP4: user growth, booking volume, gross **and** net revenue,
   * completion rate, top service categories, top artisans (by the existing
   * Bayesian weighted score) and the dispute resolution-time metrics.
   *
   * Admin-only, enforced server-side by the controller-level `RolesGuard` — a
   * customer or artisan hitting this route directly gets a 403, not a trimmed
   * payload.
   */
  @Get()
  @ApiOperation({
    summary:
      'AP1–AP4: platform analytics for the selected range — user growth, booking volume, gross/net revenue, completion rate, top categories, top artisans and dispute SLA',
    description:
      'Ranges: `7d | 30d | 90d | 1y` (PRD §5.13); `all` is not accepted here. Daily ' +
      'buckets for 7d/30d, weekly for 90d, monthly for 1y. Served from a rollup ' +
      'refreshed every 10 minutes (the `PlatformRatingCacheService` precedent) — check ' +
      '`generatedAt` and `cached` to render an honest freshness line. `previous` carries ' +
      'the immediately preceding equivalent period so a trend is a real comparison or ' +
      'absent, never invented. **Partial results (DC2.4):** each section is computed ' +
      'independently, so one failing sub-query no longer fails the whole response. A ' +
      'section that could not be computed is `null` and is named in `degraded` (e.g. ' +
      '`["topArtisans","series.revenue"]`). A `null` section means *unavailable* — it ' +
      'must be rendered as unavailable and never as `0`, `[]` or a flat line, or an ' +
      'admin will read a missing revenue figure as GH₵ 0.00. `degraded` is `[]` on a ' +
      'healthy rollup.',
  })
  @ApiOkResponse({
    description:
      'Platform analytics for the selected range. Sections named in `degraded` are `null` and unavailable, not zero.',
  })
  @ApiForbiddenResponse({ description: 'Caller is not an admin' })
  async getAdminAnalytics(@Query() query: AdminAnalyticsQueryDto) {
    const data = await this.cache.get(
      query.range ?? AnalyticsRange.LAST_30_DAYS,
    );
    return { message: 'Platform analytics retrieved.', data };
  }
}

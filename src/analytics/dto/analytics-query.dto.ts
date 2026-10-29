import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import { AnalyticsRange } from '@common/types/enums';

/**
 * AN2 (Open Question 12, resolved): admin ranges are `7d | 30d | 90d | 1y`,
 * per PRD §5.13. `all` is deliberately **not** accepted here — the admin
 * screen's fourth option was "All time", which the PRD does not list, and
 * accepting both would leave two sources of truth for the same control.
 */
const ADMIN_RANGES = [
  AnalyticsRange.LAST_7_DAYS,
  AnalyticsRange.LAST_30_DAYS,
  AnalyticsRange.LAST_90_DAYS,
  AnalyticsRange.LAST_YEAR,
] as const;

/** AN2: artisan ranges are `7d | 30d | 90d | all`, per PRD §5.12. */
const ARTISAN_RANGES = [
  AnalyticsRange.LAST_7_DAYS,
  AnalyticsRange.LAST_30_DAYS,
  AnalyticsRange.LAST_90_DAYS,
  AnalyticsRange.ALL_TIME,
] as const;

export class AdminAnalyticsQueryDto {
  @ApiPropertyOptional({
    enum: ADMIN_RANGES,
    default: AnalyticsRange.LAST_30_DAYS,
    description:
      'Daily buckets for 7d/30d, weekly for 90d, monthly for 1y. `all` is not valid here — use the artisan endpoint for all-time.',
  })
  @IsOptional()
  @IsIn(ADMIN_RANGES as unknown as string[], {
    message: 'range must be one of: 7d, 30d, 90d, 1y',
  })
  range?: AnalyticsRange = AnalyticsRange.LAST_30_DAYS;
}

export class ArtisanAnalyticsQueryDto {
  @ApiPropertyOptional({
    enum: ARTISAN_RANGES,
    default: AnalyticsRange.LAST_30_DAYS,
    description:
      'Daily buckets for 7d/30d, weekly for 90d, monthly for all-time. `1y` is not valid here.',
  })
  @IsOptional()
  @IsIn(ARTISAN_RANGES as unknown as string[], {
    message: 'range must be one of: 7d, 30d, 90d, all',
  })
  range?: AnalyticsRange = AnalyticsRange.LAST_30_DAYS;
}

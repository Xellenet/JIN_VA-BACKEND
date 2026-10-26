import {
  Controller,
  Get,
  Query,
  Res,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { LocationsService } from './locations.service';
import { LocationSuggestionsQueryDto } from './dto/location-suggestions-query.dto';
import { LocationSuggestionsResponseDto } from './dto/location-suggestions-response.dto';
import { LocationSuggestionsThrottlerGuard } from './guards/location-suggestions-throttler.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import {
  ReverseLocationQueryDto,
  ReverseLocationResponseDto,
} from './dto/reverse-location.dto';
import { LocationSuggestionsExceptionFilter } from './filters/location-suggestions-exception.filter';

/** Browser cache for a successful answer; matches the server cache (LOC10). */
const SUCCESS_CACHE_CONTROL = 'private, max-age=86400';

@ApiTags('Locations')
@Controller('locations')
export class LocationsController {
  constructor(private readonly locationsService: LocationsService) {}

  /**
   * LOC3/LOC10: town-or-area suggestions for "Complete your account".
   *
   * Public (the user has no session yet), per-IP throttled, cached 24 h. Only
   * `q` and `country` are read from the request — no header, cookie or IP is
   * passed on (PR1). Upstream failures are a 200 with `available: false`
   * (LOC8), never an error status.
   */
  @Get('suggestions')
  @UseGuards(LocationSuggestionsThrottlerGuard)
  @UseFilters(LocationSuggestionsExceptionFilter)
  @ApiOperation({
    summary: 'Suggest towns or areas for the location field (public)',
    description:
      'Proxies to an OpenStreetMap geocoder (Photon). Sends only the typed text, ' +
      'the country code and fixed parameters upstream. Suggestions © OpenStreetMap ' +
      'contributors (ODbL). Returns 200 with `available: false` and no suggestions ' +
      'when the upstream service is unavailable.',
  })
  @ApiOkResponse({
    description:
      'Wrapped in the standard success envelope; `data` has this shape.',
    type: LocationSuggestionsResponseDto,
  })
  @ApiBadRequestResponse({
    description:
      '`q` not 2–100 characters after trimming, or unsupported `country`.',
  })
  @ApiTooManyRequestsResponse({
    description:
      'Per-IP limit exceeded; `meta.error = "LOCATION_SUGGESTIONS_RATE_LIMITED"`.',
  })
  async suggest(
    @Query() query: LocationSuggestionsQueryDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ message: string; data: LocationSuggestionsResponseDto }> {
    const result = await this.locationsService.suggest(query.q, query.country);
    res.setHeader(
      'Cache-Control',
      result.available ? SUCCESS_CACHE_CONTROL : 'no-store',
    );
    return {
      message: result.available
        ? 'Location suggestions retrieved'
        : 'Location suggestions unavailable',
      data: result,
    };
  }

  /** QA JOB-04: an address for "Use my location" (see LocationsService.reverse). */
  @Get('reverse')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, LocationSuggestionsThrottlerGuard)
  @UseFilters(LocationSuggestionsExceptionFilter)
  @ApiOperation({
    summary: 'A readable address for a point (signed-in users)',
    description:
      'Sends only the point rounded to about 100 m to the OpenStreetMap geocoder (Photon). ' +
      'Returns 200 with `available: false` and no label when it is unavailable.',
  })
  @ApiOkResponse({ type: ReverseLocationResponseDto })
  async reverse(
    @Query() query: ReverseLocationQueryDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ message: string; data: ReverseLocationResponseDto }> {
    const result = await this.locationsService.reverse(query.lat, query.lon);
    res.setHeader('Cache-Control', 'no-store');
    return {
      message: result.available
        ? 'Location found'
        : 'Location lookup unavailable',
      data: result,
    };
  }
}

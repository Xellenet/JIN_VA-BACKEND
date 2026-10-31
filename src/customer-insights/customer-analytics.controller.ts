import { Controller, Get, Header, Query, Req, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
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
import { CustomerAnalyticsThrottlerGuard } from '@common/throttling/customer-throttler.guards';
import type { AuthenticatedRequest } from '@common/types/authenticated-request.type';
import { CustomerAnalyticsService } from './customer-analytics.service';
import { CustomerAnalyticsQueryDto } from './dto/customer-analytics-query.dto';
import { DEFAULT_CUSTOMER_SPEND_RANGE } from './customer-range';

/**
 * Customer experience v2 (B2): `GET /analytics/customer`, the Spending
 * report. A separate controller from the artisan one so its guards, role and
 * throttle are explicit on the route; both share the `analytics` prefix.
 */
@ApiTags('Analytics')
@ApiBearerAuth()
@Controller('analytics')
export class CustomerAnalyticsController {
  constructor(private readonly analytics: CustomerAnalyticsService) {}

  @Get('customer')
  @UseGuards(JwtAuthGuard, RolesGuard, CustomerAnalyticsThrottlerGuard)
  @Roles(Role.CUSTOMER)
  @Header('Cache-Control', 'private, no-store')
  @ApiOperation({
    summary:
      "The authenticated customer's spending: totals, series, by service, artisan and method",
  })
  @ApiOkResponse({ description: 'Spending analytics retrieved' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT' })
  @ApiForbiddenResponse({ description: 'Caller is not a customer' })
  @ApiTooManyRequestsResponse({ description: 'customer-analytics limit' })
  async getSpending(
    @Req() req: AuthenticatedRequest,
    @Query() query: CustomerAnalyticsQueryDto,
  ) {
    return {
      message: 'Spending analytics retrieved',
      data: await this.analytics.getSpending(
        req.user.id,
        query.range ?? DEFAULT_CUSTOMER_SPEND_RANGE,
      ),
    };
  }
}

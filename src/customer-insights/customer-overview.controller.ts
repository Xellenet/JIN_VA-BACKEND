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
import { CustomerOverviewService } from './customer-overview.service';
import { EmptyQueryDto } from './dto/empty-query.dto';

/**
 * Customer experience v2 (B6): the Overview rail. The owner is the JWT
 * subject only; the route takes no parameters.
 */
@ApiTags('Customers')
@ApiBearerAuth()
@Controller('customers')
export class CustomerOverviewController {
  constructor(private readonly overview: CustomerOverviewService) {}

  @Get('me/overview')
  @UseGuards(JwtAuthGuard, RolesGuard, CustomerAnalyticsThrottlerGuard)
  @Roles(Role.CUSTOMER)
  @Header('Cache-Control', 'private, no-store')
  @ApiOperation({
    summary:
      "The authenticated customer's action items, next booking and spending snapshot",
  })
  @ApiOkResponse({ description: 'Overview retrieved' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT' })
  @ApiForbiddenResponse({ description: 'Caller is not a customer' })
  @ApiTooManyRequestsResponse({ description: 'customer-analytics limit' })
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

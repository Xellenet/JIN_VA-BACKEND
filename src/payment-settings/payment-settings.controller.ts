import {
  Body,
  Controller,
  Get,
  Header,
  Patch,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
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
import { NotSuspendedGuard } from '@common/guards/not-suspended.guard';
import { Roles } from '@common/decorators/roles.decorator';
import { Role } from '@common/types/enums';
import type { AuthenticatedRequest } from '@common/types/authenticated-request.type';
import { PaymentSettingsWriteThrottlerGuard } from '@common/throttling/customer-throttler.guards';
import { securityContextFrom } from '../account-security/account-security.service';
import { PaymentSettingsService } from './payment-settings.service';
import { UpdatePaymentSettingsDto } from './dto/update-payment-settings.dto';
import { PaymentSettingsResponseDto } from './dto/payment-settings-response.dto';

/**
 * B5: the customer's checkout preferences. The owner is always the JWT
 * subject; no route takes a user id.
 */
@ApiTags('Users')
@ApiBearerAuth()
@Controller('users')
export class PaymentSettingsController {
  constructor(private readonly paymentSettings: PaymentSettingsService) {}

  @Get('me/payment-settings')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.CUSTOMER)
  @Header('Cache-Control', 'private, no-store')
  @ApiOperation({
    summary: "Get the customer's payment preferences",
    description:
      'Returns defaults (all null) when nothing has been saved. Never creates a row. ' +
      '`receiptEmail` is the account email; `editable` is false while suspended.',
  })
  @ApiOkResponse({ type: PaymentSettingsResponseDto })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT token' })
  @ApiForbiddenResponse({ description: 'Caller is not a customer' })
  getSettings(@Req() req: AuthenticatedRequest) {
    return this.paymentSettings.getSettings(req.user.id);
  }

  @Patch('me/payment-settings')
  @UseGuards(
    JwtAuthGuard,
    RolesGuard,
    NotSuspendedGuard,
    PaymentSettingsWriteThrottlerGuard,
  )
  @Roles(Role.CUSTOMER)
  @Header('Cache-Control', 'private, no-store')
  @ApiOperation({
    summary: "Save the customer's payment preferences",
    description:
      'Both fields are optional; `null` clears one. Any other field gives 400. ' +
      'A body with no real change returns the current settings without writing.',
  })
  @ApiOkResponse({ type: PaymentSettingsResponseDto })
  @ApiBadRequestResponse({ description: 'Invalid value or unknown field' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT token' })
  @ApiForbiddenResponse({
    description: 'Caller is not a customer, or the account is suspended',
  })
  @ApiTooManyRequestsResponse({
    description: '`meta.error: "PAYMENT_SETTINGS_RATE_LIMIT_EXCEEDED"`',
  })
  updateSettings(
    @Req() req: AuthenticatedRequest,
    @Body() dto: UpdatePaymentSettingsDto,
  ) {
    return this.paymentSettings.updateSettings(
      req.user.id,
      dto,
      securityContextFrom(req),
    );
  }
}

import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { NotSuspendedGuard } from '@common/guards/not-suspended.guard';
import { RejectPinFieldsGuard } from '@common/guards/reject-pin-fields.guard';
import { Roles } from '@common/decorators/roles.decorator';
import { Role } from '@common/types/enums';
import type { AuthenticatedRequest } from '@common/types/authenticated-request.type';
import {
  CustomerAnalyticsThrottlerGuard,
  PaymentMethodLookupThrottlerGuard,
  PaymentMethodsWriteThrottlerGuard,
} from '@common/throttling/customer-throttler.guards';
import { securityContextFrom } from '../account-security/account-security.service';
import { PaymentMethodsService } from './payment-methods.service';
import { MobileMoneyMethodDto } from './dto/mobile-money-method.dto';
import {
  PaymentMethodListDto,
  SavedPaymentMethodDto,
} from './dto/payment-method-response.dto';

/**
 * A customer's saved payment methods. The owner is always the JWT subject;
 * another customer's id answers 404. Responses carry labels only (masked
 * number, name, card brand/last 4), never a full number or authorization
 * code, and are never cached.
 */
@ApiTags('Users')
@ApiBearerAuth()
@Controller('users')
export class PaymentMethodsController {
  constructor(private readonly methods: PaymentMethodsService) {}

  @Get('me/payment-methods')
  @UseGuards(JwtAuthGuard, RolesGuard, CustomerAnalyticsThrottlerGuard)
  @Roles(Role.CUSTOMER)
  @Header('Cache-Control', 'private, no-store')
  @ApiOperation({ summary: 'My saved payment methods (masked)' })
  @ApiOkResponse({ type: PaymentMethodListDto })
  async list(@Req() req: AuthenticatedRequest) {
    return {
      message: 'Payment methods retrieved',
      data: await this.methods.list(req.user.id),
    };
  }

  @Post('me/payment-methods/resolve')
  @HttpCode(HttpStatus.OK)
  @UseGuards(
    JwtAuthGuard,
    RolesGuard,
    RejectPinFieldsGuard,
    PaymentMethodLookupThrottlerGuard,
  )
  @Roles(Role.CUSTOMER)
  @Header('Cache-Control', 'private, no-store')
  @ApiOperation({
    summary: 'Look up the name on a mobile money number',
    description:
      'POST so the number stays out of URLs and logs. 422 when the network has no such wallet, 503 when the lookup is unavailable.',
  })
  async resolve(@Body() dto: MobileMoneyMethodDto) {
    return {
      message: 'Account name found',
      data: await this.methods.resolve(dto),
    };
  }

  @Post('me/payment-methods/mobile-money')
  @UseGuards(
    JwtAuthGuard,
    RolesGuard,
    NotSuspendedGuard,
    RejectPinFieldsGuard,
    PaymentMethodLookupThrottlerGuard,
  )
  @Roles(Role.CUSTOMER)
  @Header('Cache-Control', 'private, no-store')
  @ApiOperation({
    summary: 'Save a mobile money number',
    description:
      'The name is looked up on the server and must be found (422/503 otherwise). 409 when already saved or at the limit. 503 with meta.error PAYMENT_METHODS_DISABLED when saving is switched off.',
  })
  @ApiOkResponse({ type: SavedPaymentMethodDto })
  async addMobileMoney(
    @Req() req: AuthenticatedRequest,
    @Body() dto: MobileMoneyMethodDto,
  ) {
    return {
      message: 'Mobile money number saved',
      data: await this.methods.addMobileMoney(
        req.user.id,
        dto,
        securityContextFrom(req as unknown as Request),
      ),
    };
  }

  @Patch('me/payment-methods/:id/default')
  @UseGuards(JwtAuthGuard, RolesGuard, PaymentMethodsWriteThrottlerGuard)
  @Roles(Role.CUSTOMER)
  @Header('Cache-Control', 'private, no-store')
  @ApiOperation({ summary: 'Make a saved method the default' })
  @ApiOkResponse({ type: PaymentMethodListDto })
  async setDefault(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return {
      message: 'Default payment method updated',
      data: await this.methods.setDefault(req.user.id, id),
    };
  }

  @Delete('me/payment-methods/:id')
  @UseGuards(JwtAuthGuard, RolesGuard, PaymentMethodsWriteThrottlerGuard)
  @Roles(Role.CUSTOMER)
  @Header('Cache-Control', 'private, no-store')
  @ApiOperation({ summary: 'Remove a saved method' })
  @ApiOkResponse({ type: PaymentMethodListDto })
  async remove(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return {
      message: 'Payment method removed',
      data: await this.methods.remove(
        req.user.id,
        id,
        securityContextFrom(req as unknown as Request),
      ),
    };
  }
}

import {
  Body,
  Controller,
  Get,
  Headers,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { PaymentsService } from './payments.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '@common/decorators/roles.decorator';
import { Role } from '@common/types/enums';
import { InitializePaymentDto } from './dto/initialize-payment.dto';
import { SetupPayoutMethodDto } from './dto/setup-payout-method.dto';
import { AdminRefundDto } from './dto/admin-refund.dto';

@ApiTags('Payments')
@Controller('payments')
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  // ─── Public — no auth (Paystack calls this directly) ──────────────────────────

  /**
   * Paystack sends charge.success and transfer.* events here.
   * Must NOT have auth guards. Paystack signs the payload with HMAC SHA512.
   */
  @Post('webhook')
  @ApiOperation({ summary: 'Paystack webhook receiver — do not call directly' })
  webhook(@Headers('x-paystack-signature') signature: string, @Req() req: any) {
    const rawBody: Buffer = req.rawBody;
    return this.paymentsService.processWebhook(rawBody?.toString() ?? '', signature ?? '');
  }

  // ─── Customer routes ──────────────────────────────────────────────────────────

  @Post('initialize')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.CUSTOMER)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get Paystack payment URL for an accepted job' })
  initialize(@Req() req: any, @Body() dto: InitializePaymentDto) {
    return this.paymentsService.initializePayment(req.user.id, dto.jobId);
  }

  @Get('history')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.CUSTOMER)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'My payment history' })
  getHistory(@Req() req: any) {
    return this.paymentsService.getMyHistory(req.user.id);
  }

  // ─── Artisan routes ───────────────────────────────────────────────────────────

  @Post('payout-method')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ARTISAN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Register or update mobile money / bank account for payouts' })
  setupPayout(@Req() req: any, @Body() dto: SetupPayoutMethodDto) {
    return this.paymentsService.setupPayoutMethod(req.user.id, dto);
  }

  @Post('retry-transfer/:jobId')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ARTISAN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Retry a payout that was blocked by missing payout method' })
  retryTransfer(@Param('jobId', ParseIntPipe) jobId: number) {
    return this.paymentsService.retryPendingTransfer(jobId);
  }

  // ─── Admin routes (also in admin.controller for admin prefix) ─────────────────

  @Get('admin/all')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Admin: full payment log with pagination' })
  adminList(
    @Query('page', new ParseIntPipe({ optional: true })) page?: number,
    @Query('limit', new ParseIntPipe({ optional: true })) limit?: number,
  ) {
    return this.paymentsService.getAllPayments(page, limit);
  }

  @Post('admin/refund/:paymentId')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Admin: issue a (partial) refund on any HELD payment' })
  adminRefund(
    @Param('paymentId', ParseIntPipe) paymentId: number,
    @Body() dto: AdminRefundDto,
  ) {
    return this.paymentsService.adminRefund(paymentId, dto.amountGhs);
  }
}

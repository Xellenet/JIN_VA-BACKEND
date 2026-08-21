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
import type { AuthenticatedRequest } from '@common/types/authenticated-request.type';
import type { Request } from 'express';

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
  webhook(
    @Headers('x-paystack-signature') signature: string,
    @Req() req: Request & { rawBody?: Buffer },
  ) {
    const rawBody = req.rawBody ?? Buffer.from('');
    return this.paymentsService.processWebhook(
      rawBody?.toString() ?? '',
      signature ?? '',
    );
  }

  // ─── Customer routes ──────────────────────────────────────────────────────────

  @Post('initialize')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.CUSTOMER)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get Paystack payment URL for an accepted job' })
  initialize(
    @Req() req: AuthenticatedRequest,
    @Body() dto: InitializePaymentDto,
  ) {
    return this.paymentsService.initializePayment(req.user.id, dto.jobId);
  }

  @Get('history')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.CUSTOMER)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'My payment history' })
  getHistory(@Req() req: AuthenticatedRequest) {
    return this.paymentsService.getMyHistory(req.user.id);
  }

  @Get('verify/:reference')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.CUSTOMER)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Reconcile a payment reference against Paystack directly (belt-and-suspenders check for the post-redirect landing page)',
  })
  verify(
    @Req() req: AuthenticatedRequest,
    @Param('reference') reference: string,
  ) {
    return this.paymentsService.verifyPayment(req.user.id, reference);
  }

  // ─── Artisan routes ───────────────────────────────────────────────────────────

  @Post('payout-method')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ARTISAN)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Register or update mobile money / bank account for payouts',
  })
  setupPayout(
    @Req() req: AuthenticatedRequest,
    @Body() dto: SetupPayoutMethodDto,
  ) {
    return this.paymentsService.setupPayoutMethod(req.user.id, dto);
  }

  @Post('retry-transfer/:jobId')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ARTISAN)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Retry a payout blocked by a missing payout method or a failed/reversed transfer',
  })
  retryTransfer(
    @Req() req: AuthenticatedRequest,
    @Param('jobId', ParseIntPipe) jobId: number,
  ) {
    return this.paymentsService.retryPendingTransfer(req.user.id, jobId);
  }

  @Get('my-earnings')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ARTISAN)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'My earnings/payout history — job, my payout amount, status, and date only. Never provider-internal fields.',
  })
  getMyEarnings(@Req() req: AuthenticatedRequest) {
    return this.paymentsService.getMyEarnings(req.user.id);
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
  @ApiOperation({
    summary: 'Admin: issue a (partial) refund on any HELD payment',
  })
  adminRefund(
    @Param('paymentId', ParseIntPipe) paymentId: number,
    @Body() dto: AdminRefundDto,
  ) {
    return this.paymentsService.adminRefund(paymentId, dto.amountGhs);
  }
}

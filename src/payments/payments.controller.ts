import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
  UseInterceptors,
  ParseEnumPipe,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiHeader,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { IdempotencyInterceptor } from '@common/idempotency/idempotency.interceptor';
import { PaymentsService } from './payments.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '@common/decorators/roles.decorator';
import { PaymentStatus, Role } from '@common/types/enums';
import { InitializePaymentDto } from './dto/initialize-payment.dto';
import { SetupPayoutMethodDto } from './dto/setup-payout-method.dto';
import { AdminRefundDto } from './dto/admin-refund.dto';
import { FraudFlagDto } from './dto/fraud-flag.dto';
import type { AuthenticatedRequest } from '@common/types/authenticated-request.type';
import type { Request, Response } from 'express';
import { CustomerPaymentHistoryService } from './customer-payment-history.service';
import {
  PaymentHistoryExportQueryDto,
  PaymentHistoryQueryDto,
} from './dto/payment-history-query.dto';
import { PaymentHistoryThrottlerGuard } from './payment-history-throttler.guard';
import {
  CustomerAnalyticsThrottlerGuard,
  CustomerExportThrottlerGuard,
} from '@common/throttling/customer-throttler.guards';
import { securityContextFrom } from '../account-security/account-security.service';
import { EmptyQueryDto } from '../customer-insights/dto/empty-query.dto';
import {
  ArtisanExportThrottlerGuard,
  ArtisanInsightsThrottlerGuard,
  PayoutAccountLookupThrottlerGuard,
} from '@common/throttling/artisan-throttler.guards';
import { ArtisanEarningsService } from './artisan-earnings.service';
import {
  ArtisanStatementExportQueryDto,
  ArtisanStatementQueryDto,
} from './dto/artisan-statement-query.dto';
import { BankListService } from './bank-list';
import { PayoutAccountService } from './payout-account.service';
import { ResolvePayoutAccountDto } from './dto/resolve-payout-account.dto';
import { RejectPinFieldsGuard } from '@common/guards/reject-pin-fields.guard';
import {
  PaymentChargeStatusThrottlerGuard,
  PaymentChargeThrottlerGuard,
} from '@common/throttling/customer-throttler.guards';
import { SavedMethodChargeService } from './saved-method-charge.service';
import {
  ChargeWithSavedMethodDto,
  SubmitChargeOtpDto,
} from './dto/saved-method-charge.dto';

/** Swagger: the optional header on the payment POSTs. */
const IDEMPOTENCY_KEY_HEADER = {
  name: 'Idempotency-Key',
  required: false,
  description:
    'Optional. A UUID (or 16-64 URL-safe characters) per customer intent. The same key with ' +
    'the same request replays the first response for 24 hours (header Idempotency-Replayed: true); ' +
    'with a different request it is 422 IDEMPOTENCY_KEY_REUSED; while the first is still running ' +
    'it is 409 IDEMPOTENCY_IN_PROGRESS.',
};

@ApiTags('Payments')
@Controller('payments')
export class PaymentsController {
  constructor(
    private readonly paymentsService: PaymentsService,
    private readonly history: CustomerPaymentHistoryService,
    private readonly earnings: ArtisanEarningsService,
    private readonly banks: BankListService,
    private readonly payoutAccounts: PayoutAccountService,
    private readonly savedCharges: SavedMethodChargeService,
  ) {}

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

  /**
   * One active attempt per job: the same open checkout comes back while it
   * is open; 409 `PAYMENT_ATTEMPT_ACTIVE` (with the attempt in `data`) while
   * a saved-method charge is waiting; 409 `ALREADY_PAID` (with the payment)
   * once the job is paid.
   */
  @Post('initialize')
  @UseGuards(JwtAuthGuard, RolesGuard, RejectPinFieldsGuard)
  @UseInterceptors(IdempotencyInterceptor)
  @Roles(Role.CUSTOMER)
  @ApiBearerAuth()
  @ApiHeader(IDEMPOTENCY_KEY_HEADER)
  @ApiOperation({ summary: 'Get Paystack payment URL for an accepted job' })
  initialize(
    @Req() req: AuthenticatedRequest,
    @Body() dto: InitializePaymentDto,
  ) {
    return this.paymentsService.initializePayment(req.user.id, dto.jobId, {
      saveCard: dto.saveCard,
    });
  }

  // ─── Saved payment methods: paying with one ──────────────────────────────────

  /**
   * Pays the job's pending payment with a saved method. Mobile money sends
   * the network's approval prompt to the customer's phone (they approve with
   * their PIN there; no PIN is ever sent here). The payment becomes HELD
   * only via the webhook or a verify, exactly as with the hosted checkout.
   * A second call with the same method while an attempt is active returns
   * that attempt; another kind is 409 `PAYMENT_ATTEMPT_ACTIVE`; a paid job
   * is 409 `ALREADY_PAID`.
   */
  @Post(':jobId/charge')
  @HttpCode(HttpStatus.OK)
  @UseGuards(
    JwtAuthGuard,
    RolesGuard,
    RejectPinFieldsGuard,
    PaymentChargeThrottlerGuard,
  )
  @UseInterceptors(IdempotencyInterceptor)
  @Roles(Role.CUSTOMER)
  @Header('Cache-Control', 'private, no-store')
  @ApiBearerAuth()
  @ApiHeader(IDEMPOTENCY_KEY_HEADER)
  @ApiOperation({ summary: 'Pay a job with a saved payment method' })
  async chargeSavedMethod(
    @Req() req: AuthenticatedRequest,
    @Param('jobId', ParseIntPipe) jobId: number,
    @Body() dto: ChargeWithSavedMethodDto,
  ) {
    return {
      message: 'Payment started',
      data: await this.savedCharges.charge(
        req.user.id,
        jobId,
        dto.paymentMethodId,
      ),
    };
  }

  /** The one-time code Telecel sends for some mobile money charges. Never a PIN. */
  @Post('charges/:reference/otp')
  @HttpCode(HttpStatus.OK)
  @UseGuards(
    JwtAuthGuard,
    RolesGuard,
    RejectPinFieldsGuard,
    PaymentChargeThrottlerGuard,
  )
  @UseInterceptors(IdempotencyInterceptor)
  @Roles(Role.CUSTOMER)
  @Header('Cache-Control', 'private, no-store')
  @ApiBearerAuth()
  @ApiHeader(IDEMPOTENCY_KEY_HEADER)
  @ApiOperation({ summary: 'Submit the one-time code for a pending charge' })
  async submitChargeOtp(
    @Req() req: AuthenticatedRequest,
    @Param('reference') reference: string,
    @Body() dto: SubmitChargeOtpDto,
  ) {
    return {
      message: 'Code submitted',
      data: await this.savedCharges.submitOtp(req.user.id, reference, dto.otp),
    };
  }

  @Get('charges/:reference/status')
  @UseGuards(JwtAuthGuard, RolesGuard, PaymentChargeStatusThrottlerGuard)
  @Roles(Role.CUSTOMER)
  @Header('Cache-Control', 'private, no-store')
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'The state of a saved-method charge (pending, needs_otp, succeeded, failed)',
  })
  async chargeStatus(
    @Req() req: AuthenticatedRequest,
    @Param('reference') reference: string,
  ) {
    return {
      message: 'Payment status retrieved',
      data: await this.savedCharges.status(req.user.id, reference),
    };
  }

  /**
   * The job's payment state for the pay and job pages: whether it is paid,
   * the active attempt to resume (checked with Paystack when due), and any
   * duplicate payment refunded for it. 404 unless the caller is the job's
   * customer.
   */
  @Get('jobs/:jobId/attempt')
  @UseGuards(JwtAuthGuard, RolesGuard, PaymentChargeStatusThrottlerGuard)
  @Roles(Role.CUSTOMER)
  @Header('Cache-Control', 'private, no-store')
  @ApiBearerAuth()
  @ApiOperation({
    summary: "My job's payment state and active payment attempt",
  })
  async jobPaymentState(
    @Req() req: AuthenticatedRequest,
    @Param('jobId', ParseIntPipe) jobId: number,
  ) {
    return {
      message: 'Payment state retrieved',
      data: await this.paymentsService.getJobPaymentState(req.user.id, jobId),
    };
  }

  /**
   * B3: with no query parameters, today's unpaginated list (unthrottled, used
   * by the job and pay pages). With any parameter, the Spending page's
   * filtered, paginated history (`meta.pagination`).
   */
  @Get('history')
  @UseGuards(JwtAuthGuard, RolesGuard, PaymentHistoryThrottlerGuard)
  @Roles(Role.CUSTOMER)
  @Header('Cache-Control', 'private, no-store')
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'My payment history: unpaginated with no parameters, paginated and filtered with any',
  })
  getHistory(
    @Req() req: AuthenticatedRequest,
    @Query() query: PaymentHistoryQueryDto,
  ) {
    if (Object.keys(req.query ?? {}).length === 0) {
      return this.history.getLegacyHistory(req.user.id);
    }
    return this.history.getHistoryPage(req.user.id, query);
  }

  /** B3f: the services and artisans the caller has paid, for the filters. */
  @Get('history/filters')
  @UseGuards(JwtAuthGuard, RolesGuard, CustomerAnalyticsThrottlerGuard)
  @Roles(Role.CUSTOMER)
  @Header('Cache-Control', 'private, no-store')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Services and artisans in my payment history (filter options)',
  })
  getHistoryFilters(
    @Req() req: AuthenticatedRequest,
    @Query() _query: EmptyQueryDto,
  ) {
    return this.history.getFilterOptions(req.user.id);
  }

  /**
   * B10: the filtered history as a CSV download, streamed in batches. Limits
   * (24 months, 10,000 rows) answer 400 with `meta.error` before streaming.
   */
  @Get('history/export.csv')
  @UseGuards(JwtAuthGuard, RolesGuard, CustomerExportThrottlerGuard)
  @Roles(Role.CUSTOMER)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Download my payment history as CSV' })
  async exportHistory(
    @Req() req: AuthenticatedRequest,
    @Query() query: PaymentHistoryExportQueryDto,
    @Res() res: Response,
  ): Promise<void> {
    await this.history.streamExport(
      req.user.id,
      query,
      res,
      securityContextFrom(req as unknown as Request),
    );
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

  /**
   * Safety net for checkouts started while PAYSTACK_CALLBACK_URL pointed here.
   * Paystack sends the browser to `/payments/callback?trxref=…&reference=…`;
   * this forwards it to the job's pay page on the frontend, which confirms
   * the payment for the signed-in owner. New checkouts go straight there
   * (`PaymentsService.paymentCallbackUrl`). Public by necessity (it is a
   * browser redirect from Paystack) and changes nothing: the money state only
   * moves on the signed webhook or an owner's verify call.
   */
  @Get('callback')
  @ApiOperation({
    summary:
      'Paystack return URL safety net: redirects the browser to the job pay page',
  })
  async callback(
    @Query('reference') reference: string | undefined,
    @Query('trxref') trxref: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const url = await this.paymentsService.callbackRedirectUrl(
      reference ?? trxref,
    );
    res.setHeader('Cache-Control', 'private, no-store');
    res.redirect(302, url);
  }

  // ─── Artisan routes ───────────────────────────────────────────────────────────

  /**
   * Payout account lookup: the name on a mobile money number or bank
   * account, shown to the artisan to confirm before saving. POST so the
   * number stays out of URLs and access logs. 422 when Paystack can't find
   * the account, 503 when the lookup is unavailable (type the name instead).
   */
  @Post('payout-method/resolve')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard, RolesGuard, PayoutAccountLookupThrottlerGuard)
  @Roles(Role.ARTISAN)
  @Header('Cache-Control', 'private, no-store')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Look up the name on a payout account' })
  async resolvePayoutAccount(@Body() dto: ResolvePayoutAccountDto) {
    return {
      message: 'Account name found',
      data: await this.payoutAccounts.resolve(dto),
    };
  }

  @Post('payout-method')
  @UseGuards(JwtAuthGuard, RolesGuard, PayoutAccountLookupThrottlerGuard)
  @Roles(Role.ARTISAN)
  @Header('Cache-Control', 'private, no-store')
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Register or update mobile money / bank account for payouts (the account name is looked up on the server)',
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

  /**
   * Artisan fixes (B2): the earnings statement — period totals, balances,
   * monthly totals and a paginated list with gross, fee and payout per job.
   */
  @Get('my-earnings/statement')
  @UseGuards(JwtAuthGuard, RolesGuard, ArtisanInsightsThrottlerGuard)
  @Roles(Role.ARTISAN)
  @Header('Cache-Control', 'private, no-store')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'My earnings statement (paginated)' })
  getMyEarningsStatement(
    @Req() req: AuthenticatedRequest,
    @Query() query: ArtisanStatementQueryDto,
  ) {
    return this.earnings.getStatement(req.user.id, query);
  }

  /** Artisan fixes (B2): the statement as a capped, formula-safe CSV. */
  @Get('my-earnings/export.csv')
  @UseGuards(JwtAuthGuard, RolesGuard, ArtisanExportThrottlerGuard)
  @Roles(Role.ARTISAN)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Download my earnings statement as CSV' })
  async exportMyEarnings(
    @Req() req: AuthenticatedRequest,
    @Query() query: ArtisanStatementExportQueryDto,
    @Res() res: Response,
  ): Promise<void> {
    await this.earnings.streamExport(
      req.user.id,
      query,
      res,
      securityContextFrom(req as unknown as Request),
    );
  }

  /** Artisan fixes (B6): Ghana banks for the payout bank picker. */
  @Get('banks')
  @UseGuards(JwtAuthGuard, RolesGuard, ArtisanInsightsThrottlerGuard)
  @Roles(Role.ARTISAN)
  @Header('Cache-Control', 'private, max-age=3600')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Ghana banks for payouts (cached)' })
  async listBanks(@Query() _query: EmptyQueryDto) {
    return { message: 'Banks retrieved', data: await this.banks.list() };
  }

  // ─── Admin routes (also in admin.controller for admin prefix) ─────────────────

  @Get('admin/all')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'Admin: full payment log with pagination, searchable by reference, customer, job title or job id, and filterable by status',
  })
  @ApiQuery({ name: 'search', required: false })
  @ApiQuery({ name: 'status', required: false, enum: PaymentStatus })
  adminList(
    @Query('page', new ParseIntPipe({ optional: true })) page?: number,
    @Query('limit', new ParseIntPipe({ optional: true })) limit?: number,
    @Query('search') search?: string,
    @Query('status', new ParseEnumPipe(PaymentStatus, { optional: true }))
    status?: PaymentStatus,
  ) {
    return this.paymentsService.getAllPayments(page, limit, {
      search: search?.slice(0, 100),
      status,
    });
  }

  @Get('admin/summary')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Admin: whole-ledger totals for the Transactions page',
  })
  adminSummary() {
    return this.paymentsService.getAdminSummary();
  }

  @Post('admin/refund/:paymentId')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Admin: issue a (partial) refund on any HELD payment',
  })
  adminRefund(
    @Req() req: AuthenticatedRequest,
    @Param('paymentId', ParseIntPipe) paymentId: number,
    @Body() dto: AdminRefundDto,
  ) {
    // AT5: the acting admin is threaded through so the refund writes an audit
    // row. It previously recorded no actor at all.
    return this.paymentsService.adminRefund(paymentId, dto.amountGhs, req.user);
  }

  // ─── AT7: fraud flagging ──────────────────────────────────────────────────────

  @Post('admin/:paymentId/fraud-flag')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Admin: flag a transaction for fraud review, with a reason',
    description:
      'AT7: marking, visibility and auditing only — the flag has no enforcement effect ' +
      'on payouts, refunds or the account. Kept entirely separate from `status`, so a ' +
      'payment can be both RELEASED and flagged and the settled payment-status ' +
      'vocabulary is never forked.',
  })
  flagPaymentForFraud(
    @Req() req: AuthenticatedRequest,
    @Param('paymentId', ParseIntPipe) paymentId: number,
    @Body() dto: FraudFlagDto,
  ) {
    return this.paymentsService.setFraudFlag(req.user, paymentId, dto.reason);
  }

  @Post('admin/:paymentId/fraud-flag/clear')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ADMIN)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Admin: clear a fraud-review flag, with a reason',
  })
  clearPaymentFraudFlag(
    @Req() req: AuthenticatedRequest,
    @Param('paymentId', ParseIntPipe) paymentId: number,
    @Body() dto: FraudFlagDto,
  ) {
    return this.paymentsService.clearFraudFlag(req.user, paymentId, dto.reason);
  }
}

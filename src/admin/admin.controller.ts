import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { AdminService } from './admin.service';
import {
  AdminJobsQueryDto,
  AdminUsersQueryDto,
  AdminBookingsQueryDto,
} from './dto/admin-query.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '@common/decorators/roles.decorator';
import { Role } from '@common/types/enums';
import { VerificationService } from '../verification/verification.service';
import {
  ApproveVerificationDto,
  RejectVerificationDto,
} from '../verification/dto/review-verification.dto';
import { GetVerificationsQueryDto } from '../verification/dto/get-verifications-query.dto';
import { DisputesService } from '../disputes/disputes.service';
import { GetDisputesQueryDto } from '../disputes/dto/get-disputes-query.dto';
import {
  ResolveDisputeDto,
  CloseDisputeDto,
} from '../disputes/dto/resolve-dispute.dto';
import { PortfolioService } from '../portfolio/portfolio.service';
import { RejectPortfolioItemDto } from '../portfolio/dto/reject-portfolio-item.dto';
import type { AuthenticatedRequest } from '@common/types/authenticated-request.type';

@ApiTags('Admin')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.ADMIN)
@Controller('admin')
export class AdminController {
  constructor(
    private readonly adminService: AdminService,
    private readonly verificationService: VerificationService,
    private readonly disputesService: DisputesService,
    private readonly portfolioService: PortfolioService,
  ) {}

  // ─── Stats ────────────────────────────────────────────────────────────────────

  @Get('stats')
  @ApiOperation({ summary: 'Platform statistics overview' })
  getStats() {
    return this.adminService.getStats();
  }

  // ─── Users ────────────────────────────────────────────────────────────────────

  @Get('users')
  @ApiOperation({ summary: 'List all users with optional role/ban filters' })
  listUsers(@Query() query: AdminUsersQueryDto) {
    return this.adminService.listUsers(query);
  }

  @Get('users/:id')
  @ApiOperation({ summary: 'Get a single user by ID' })
  @ApiParam({ name: 'id', type: Number })
  getUser(@Param('id', ParseIntPipe) id: number) {
    return this.adminService.getUser(id);
  }

  @Patch('users/:id/ban')
  @ApiOperation({ summary: 'Ban a user — blocks all future logins' })
  @ApiParam({ name: 'id', type: Number })
  banUser(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.adminService.banUser(req.user.id, id);
  }

  @Patch('users/:id/unban')
  @ApiOperation({ summary: 'Unban a previously banned user' })
  @ApiParam({ name: 'id', type: Number })
  unbanUser(@Param('id', ParseIntPipe) id: number) {
    return this.adminService.unbanUser(id);
  }

  // ─── Jobs ────────────────────────────────────────────────────────────────────

  @Get('jobs')
  @ApiOperation({ summary: 'List all jobs across all customers' })
  listJobs(@Query() query: AdminJobsQueryDto) {
    return this.adminService.listJobs(query);
  }

  @Patch('jobs/:id/expire')
  @ApiOperation({ summary: 'Force-expire an OPEN job posting' })
  @ApiParam({ name: 'id', type: Number })
  forceExpireJob(@Param('id', ParseIntPipe) id: number) {
    return this.adminService.forceExpireJob(id);
  }

  // ─── Bookings (A6: minimal admin read path) ────────────────────────────────────

  @Get('bookings')
  @ApiOperation({
    summary:
      'A6: list all bookings, filterable by status/artisan/customer (includes no-show flags)',
  })
  listBookings(@Query() query: AdminBookingsQueryDto) {
    return this.adminService.listBookings(query);
  }

  @Get('bookings/:id')
  @ApiOperation({ summary: 'A6: get a single booking with full detail' })
  @ApiParam({ name: 'id', type: Number })
  getBooking(@Param('id', ParseIntPipe) id: number) {
    return this.adminService.getBooking(id);
  }

  // ─── Artisans ─────────────────────────────────────────────────────────────────

  @Get('artisans')
  @ApiOperation({ summary: 'List all artisan profiles' })
  listArtisans(
    @Query('page', new ParseIntPipe({ optional: true })) page?: number,
    @Query('limit', new ParseIntPipe({ optional: true })) limit?: number,
  ) {
    return this.adminService.listArtisans(page, limit);
  }

  // ─── Verifications ────────────────────────────────────────────────────────────

  @Get('verifications')
  @ApiOperation({
    summary: 'List all verification submissions with optional status filter',
  })
  listVerifications(@Query() query: GetVerificationsQueryDto) {
    return this.verificationService.findAll(query);
  }

  @Get('verifications/:id')
  @ApiOperation({
    summary: 'Get a single verification record with full artisan details',
  })
  @ApiParam({ name: 'id', type: Number })
  getVerification(@Param('id', ParseIntPipe) id: number) {
    return this.verificationService.findOne(id);
  }

  @Patch('verifications/:id/start-review')
  @ApiOperation({ summary: 'Move a verification submission to UNDER_REVIEW' })
  @ApiParam({ name: 'id', type: Number })
  startVerificationReview(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.verificationService.startReview(req.user.id, id);
  }

  @Patch('verifications/:id/approve')
  @ApiOperation({
    summary: 'Approve a verification — marks artisan profile as verified',
  })
  @ApiParam({ name: 'id', type: Number })
  approveVerification(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ApproveVerificationDto,
  ) {
    return this.verificationService.approve(req.user.id, id, dto);
  }

  @Patch('verifications/:id/reject')
  @ApiOperation({ summary: 'Reject a verification with a mandatory reason' })
  @ApiParam({ name: 'id', type: Number })
  rejectVerification(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: RejectVerificationDto,
  ) {
    return this.verificationService.reject(req.user.id, id, dto);
  }

  // ─── Disputes ─────────────────────────────────────────────────────────────────

  @Get('disputes')
  @ApiOperation({ summary: 'List all disputes with optional status filter' })
  listDisputes(@Query() query: GetDisputesQueryDto) {
    return this.disputesService.findAll(query);
  }

  @Get('disputes/:id')
  @ApiOperation({
    summary: 'Get a single dispute with full booking and participant details',
  })
  @ApiParam({ name: 'id', type: Number })
  getDispute(@Param('id', ParseIntPipe) id: number) {
    return this.disputesService.findOne(id);
  }

  @Patch('disputes/:id/start-review')
  @ApiOperation({ summary: 'Move a dispute to UNDER_REVIEW' })
  @ApiParam({ name: 'id', type: Number })
  startDisputeReview(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.disputesService.startReview(req.user.id, id);
  }

  @Patch('disputes/:id/resolve')
  @ApiOperation({ summary: 'Resolve a dispute with a resolution statement' })
  @ApiParam({ name: 'id', type: Number })
  resolveDispute(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ResolveDisputeDto,
  ) {
    return this.disputesService.resolve(req.user.id, id, dto);
  }

  @Patch('disputes/:id/close')
  @ApiOperation({ summary: 'Close a dispute (e.g. parties settled privately)' })
  @ApiParam({ name: 'id', type: Number })
  closeDispute(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CloseDisputeDto,
  ) {
    return this.disputesService.close(req.user.id, id, dto);
  }

  // ─── Portfolio moderation (PF4) ────────────────────────────────────────────────

  @Get('portfolio/queue')
  @ApiOperation({
    summary: 'List all PENDING portfolio items awaiting moderation',
  })
  getPortfolioQueue() {
    return this.portfolioService.getQueue();
  }

  @Patch('portfolio/:id/approve')
  @ApiOperation({
    summary:
      "Approve a portfolio item — makes it visible in the artisan's public gallery",
  })
  @ApiParam({ name: 'id', type: Number })
  approvePortfolioItem(@Param('id', ParseIntPipe) id: number) {
    return this.portfolioService.approve(id);
  }

  @Patch('portfolio/:id/reject')
  @ApiOperation({ summary: 'Reject a portfolio item with a mandatory reason' })
  @ApiParam({ name: 'id', type: Number })
  rejectPortfolioItem(
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: RejectPortfolioItemDto,
  ) {
    return this.portfolioService.reject(id, dto);
  }
}

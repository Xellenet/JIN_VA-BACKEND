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
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { AdminService } from './admin.service';
import {
  AdminJobsQueryDto,
  AdminUsersQueryDto,
  AdminBookingsQueryDto,
  AdminSearchQueryDto,
  BanUserDto,
  SuspendUserDto,
} from './dto/admin-query.dto';
import { AdminAuditService } from '../admin-audit/admin-audit.service';
import { GetAdminActionsQueryDto } from '../admin-audit/dto/get-admin-actions-query.dto';
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
import { ReviewsService } from '../reviews/reviews.service';
import {
  AdminReviewsQueryDto,
  ModerationLogQueryDto,
} from '../reviews/dto/admin-reviews-query.dto';
import { RemoveReviewDto } from '../reviews/dto/remove-review.dto';
import { DisputeConversationResponseDto } from '@messages/dto/dispute-conversation-response.dto';
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
    private readonly reviewsService: ReviewsService,
    private readonly auditService: AdminAuditService,
  ) {}

  // ─── Stats ────────────────────────────────────────────────────────────────────

  @Get('stats')
  @ApiOperation({ summary: 'Platform statistics overview' })
  getStats() {
    return this.adminService.getStats();
  }

  /**
   * AT9: the platform fee percentage the backend actually applies, so the
   * Settings screen can stop showing a value that disagrees with production.
   */
  @Get('platform-config')
  @ApiOperation({
    summary: 'AT9: the platform fee percentage the backend actually applies',
    description:
      'Read-only. Runtime configuration of the fee is deliberately out of scope — this ' +
      'endpoint exists so the displayed value stops contradicting the value used to ' +
      'compute every payment split.',
  })
  getPlatformConfig() {
    return this.adminService.getPlatformConfig();
  }

  // ─── AT6: cross-entity search ─────────────────────────────────────────────────

  /**
   * AT6: one admin-only lookup across users, jobs and disputes.
   *
   * This deliberately crosses user boundaries, which is why it is admin-only
   * and enforced here by the controller-level `RolesGuard` — a non-admin
   * hitting this route directly gets a 403, not an empty result set.
   */
  @Get('search')
  @ApiOperation({
    summary: 'AT6: find users, jobs and disputes by name, email or id',
    description:
      'Not a general full-text search — scoped to the three entity types an admin needs ' +
      'to navigate to. Each type is capped independently by `limit`.',
  })
  @ApiForbiddenResponse({ description: 'Caller is not an admin' })
  search(@Query() query: AdminSearchQueryDto) {
    return this.adminService.search(query);
  }

  // ─── AT5: admin action audit log ──────────────────────────────────────────────

  /**
   * AT5: paginated, newest-first, filterable by action type and acting admin.
   *
   * Separate from `GET /admin/reviews/moderation-log`, which the reviews round
   * built and which stays exactly as it is — this log neither replaces nor
   * absorbs it.
   */
  @Get('actions')
  @ApiOperation({
    summary:
      'AT5: append-only log of every consequential admin action — bans, suspensions, ' +
      'verification and portfolio decisions, dispute rulings (with verdict and money ' +
      'action), refunds and fraud flags',
    description:
      'Rows have no foreign keys and snapshot the actor and target, so they survive ' +
      'deletion of whatever they describe. Retention is indefinite.',
  })
  getAdminActions(@Query() query: GetAdminActionsQueryDto) {
    return this.auditService.findAll(query);
  }

  // ─── Users ────────────────────────────────────────────────────────────────────

  @Get('users')
  @ApiOperation({
    summary:
      'List all users, filterable by role, account status (AT3) and join date',
    description:
      '`status` distinguishes ACTIVE / SUSPENDED / BANNED and takes precedence over the ' +
      'older boolean `isBanned` filter, which still works. `joinedFrom`/`joinedTo` are ' +
      'inclusive; a bare `YYYY-MM-DD` in `joinedTo` covers the whole day.',
  })
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
  @ApiOperation({
    summary: 'Ban a user permanently — blocks all future logins',
    description:
      'AT2: the acting admin is now recorded on the user row and in the audit log. ' +
      'Self-ban is rejected.',
  })
  @ApiParam({ name: 'id', type: Number })
  banUser(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: BanUserDto,
  ) {
    return this.adminService.banUser(req.user, id, dto);
  }

  @Patch('users/:id/unban')
  @ApiOperation({ summary: 'Unban a previously banned user' })
  @ApiParam({ name: 'id', type: Number })
  unbanUser(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.adminService.unbanUser(req.user, id);
  }

  /**
   * AT3: reversible suspension, distinct from the permanent ban.
   *
   * A suspended user can still sign in, but cannot transact (bookings, jobs,
   * applications, messages) and is excluded from public artisan search.
   * Indefinite until reactivated. Self-suspension is rejected, matching the
   * existing self-ban guard.
   */
  @Patch('users/:id/suspend')
  @ApiOperation({
    summary:
      'AT3: suspend an account (reversible) — can still sign in, cannot transact or be found in search',
  })
  @ApiParam({ name: 'id', type: Number })
  @ApiBadRequestResponse({
    description:
      'Already suspended, already permanently banned, or the admin tried to suspend themselves',
  })
  suspendUser(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: SuspendUserDto,
  ) {
    return this.adminService.suspendUser(req.user, id, dto);
  }

  @Patch('users/:id/activate')
  @ApiOperation({
    summary: 'AT3: reactivate a suspended account — fully restores it',
  })
  @ApiParam({ name: 'id', type: Number })
  activateUser(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.adminService.activateUser(req.user, id);
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
    return this.verificationService.approve(req.user, id, dto);
  }

  @Patch('verifications/:id/reject')
  @ApiOperation({ summary: 'Reject a verification with a mandatory reason' })
  @ApiParam({ name: 'id', type: Number })
  rejectVerification(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: RejectVerificationDto,
  ) {
    return this.verificationService.reject(req.user, id, dto);
  }

  // ─── Disputes ─────────────────────────────────────────────────────────────────

  @Get('disputes')
  @ApiOperation({
    summary:
      'DQ1: list disputes with server-side status, category and free-text filtering',
    description:
      '`q` searches the whole dispute set (not just the loaded page) across dispute id, ' +
      "booking id, and the raiser's name and email. Paginated; `limit` is capped at 100.",
  })
  listDisputes(@Query() query: GetDisputesQueryDto) {
    return this.disputesService.findAll(query);
  }

  /**
   * DQ2: whole-set aggregate counts for the queue's four counter cards, plus
   * DR6's SLA figures.
   *
   * Declared **before** `disputes/:id` on purpose — route matching is
   * declaration-ordered, and `ParseIntPipe` on `:id` would otherwise reject
   * "summary" with a 400.
   */
  @Get('disputes/summary')
  @ApiOperation({
    summary:
      'DQ2/DR6: whole-set dispute counts by status, plus average resolution time and the count open past 48h',
    description:
      'Counts honour the `category` and `q` filters so the cards describe the active ' +
      'filter, and deliberately ignore `status` (a per-status breakdown filtered to one ' +
      'status is just that status). Replaces the page-local arithmetic that went quietly ' +
      'wrong past row 100.',
  })
  getDisputeSummary(@Query() query: GetDisputesQueryDto) {
    return this.disputesService.getQueueSummary(query);
  }

  @Get('disputes/:id')
  @ApiOperation({
    summary:
      'Get a single dispute with participants, job/booking detail (DQ3), the linked payment, sibling disputes and the money actions actually available',
  })
  @ApiParam({ name: 'id', type: Number })
  getDispute(@Param('id', ParseIntPipe) id: number) {
    return this.disputesService.findOne(id);
  }

  /**
   * AD1/AD2: the *only* way an admin can read a conversation they are not a
   * participant of.
   *
   * The scope boundary is enforced server-side, not by omitting a general
   * endpoint from the UI:
   *  - admin-only (the controller-level `@Roles(Role.ADMIN)`);
   *  - the two participants are derived from this dispute's booking — the
   *    request accepts no user id or conversation id, so there is nothing an
   *    admin could substitute to reach an unrelated thread;
   *  - refused with 403 once the dispute is no longer open work
   *    (RESOLVED/CLOSED), so a settled dispute doesn't become a permanent
   *    read tap on two users' private messages.
   *
   * Read-only by construction: no admin write path into a customer↔artisan
   * thread exists anywhere in this API.
   */
  @Get('disputes/:id/conversation')
  @ApiOperation({
    summary:
      "AD1: read-only view of the conversation between a dispute's two parties",
    description:
      "Resolves the dispute's booking to its customer/artisan pair and returns their " +
      'message thread (most recent 200 messages, oldest-first), for evidence during ' +
      'dispute resolution. Returns `data: null` with an explanatory message when the ' +
      'two parties have never messaged — an expected case, not an error. ' +
      'Scoped strictly to disputes that are still OPEN or UNDER_REVIEW.',
  })
  @ApiParam({ name: 'id', type: Number })
  @ApiOkResponse({
    description:
      'Conversation retrieved, or `data: null` when no conversation exists between the parties',
    type: DisputeConversationResponseDto,
  })
  @ApiForbiddenResponse({
    description:
      'Caller is not an admin, or the dispute is already RESOLVED/CLOSED so conversation access is out of scope',
  })
  @ApiNotFoundResponse({
    description:
      "Dispute not found, or its booking's participants could not be resolved",
  })
  getDisputeConversation(@Param('id', ParseIntPipe) id: number) {
    return this.disputesService.getConversationForDispute(id);
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

  /**
   * DR1 + DR2: resolving records a **verdict** and carries out the money
   * action that verdict implies.
   *
   * `outcome` is mandatory. `REFUND_CLIENT` refunds the linked payment (full
   * by default, or the partial `refundAmountGhs`); `RELEASE_ARTISAN` releases
   * a withheld payment to the artisan; `MUTUAL` records the ruling and moves
   * no money.
   *
   * If the money action fails, the dispute is **not** resolved — the ruling is
   * rolled back, the provider's specific error is surfaced, and the dispute
   * stays actionable. If the action is impossible (no linked payment, already
   * refunded/released, a sibling dispute already moved money on the same
   * payment) the verdict is still recorded, `moneyAction` is `NONE`, and
   * `moneySkippedReason` states why — no clawback is attempted.
   */
  @Patch('disputes/:id/resolve')
  @ApiOperation({
    summary:
      'DR1/DR2: resolve a dispute with one of the three verdicts, carrying out the money action it implies',
  })
  @ApiParam({ name: 'id', type: Number })
  @ApiBadRequestResponse({
    description:
      'Already resolved/closed (including losing a concurrent race), an invalid refund amount, ' +
      'or the money action failed — in which case the dispute is left unresolved and actionable',
  })
  resolveDispute(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ResolveDisputeDto,
  ) {
    return this.disputesService.resolve(req.user, id, dto);
  }

  @Patch('disputes/:id/close')
  @ApiOperation({ summary: 'Close a dispute (e.g. parties settled privately)' })
  @ApiParam({ name: 'id', type: Number })
  closeDispute(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CloseDisputeDto,
  ) {
    return this.disputesService.close(req.user, id, dto);
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
  approvePortfolioItem(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseIntPipe) id: number,
  ) {
    // AT2/AT5: portfolio moderation previously received no admin id at all, so
    // an approval was entirely unattributable.
    return this.portfolioService.approve(req.user, id);
  }

  @Patch('portfolio/:id/reject')
  @ApiOperation({ summary: 'Reject a portfolio item with a mandatory reason' })
  @ApiParam({ name: 'id', type: Number })
  rejectPortfolioItem(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: RejectPortfolioItemDto,
  ) {
    return this.portfolioService.reject(req.user, id, dto);
  }

  // ─── Review moderation (AM2–AM5) ────────────────────────────────────────────────

  @Get('reviews/moderation-log')
  @ApiOperation({
    summary:
      'AM5: paginated, append-only log of every flag/remove/restore action — ' +
      'the only surviving record for reviews that have since been permanently removed',
  })
  getReviewModerationLog(@Query() query: ModerationLogQueryDto) {
    return this.reviewsService.getModerationLog(query);
  }

  @Get('reviews')
  @ApiOperation({
    summary:
      'AM2: list all reviews for moderation, optionally filtered by status',
  })
  listReviews(@Query() query: AdminReviewsQueryDto) {
    return this.reviewsService.adminFindAll(query);
  }

  @Patch('reviews/:id/remove')
  @ApiOperation({
    summary:
      'AM3: permanently delete a review with a mandatory logged reason (hard delete — ' +
      'not reversible). The reason/actor/snapshot survive in the moderation log (AM5).',
  })
  @ApiParam({ name: 'id', type: Number })
  removeReview(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: RemoveReviewDto,
  ) {
    return this.reviewsService.adminRemove(req.user, id, dto);
  }

  @Patch('reviews/:id/restore')
  @ApiOperation({
    summary:
      'AM4: restore a FLAGGED review back to ACTIVE (no-op reason required; ' +
      'a REMOVED review cannot be restored — it no longer exists)',
  })
  @ApiParam({ name: 'id', type: Number })
  restoreReview(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.reviewsService.adminRestore(req.user, id);
  }
}

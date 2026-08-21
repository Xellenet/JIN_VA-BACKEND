import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { OptionalJwtAuthGuard } from '../auth/guards/optional-jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '@common/decorators/roles.decorator';
import { Role } from '@common/types/enums';
import { ReviewsService } from './reviews.service';
import { CreateReviewDto } from './dto/create-review.dto';
import { UpdateReviewDto } from './dto/update-review.dto';
import { CreateReviewReplyDto } from './dto/create-review-reply.dto';
import { FlagReviewDto } from './dto/flag-review.dto';
import { GetReviewsQueryDto } from './dto/get-reviews-query.dto';
import { ReviewResponseDto } from './dto/review-response.dto';
import type { AuthenticatedRequest } from '@common/types/authenticated-request.type';

/**
 * Manages reviews left by customers after a job is completed.
 *
 * `POST /reviews` is restricted to authenticated customers and enforces that the
 * referenced job is in COMPLETED status before accepting a review.
 * Read endpoints are public (optionally authenticated — see FL1's visibility
 * exception for the original reviewer) and support pagination via `page`
 * and `limit` query params.
 */
@ApiTags('Reviews')
@Controller('reviews')
export class ReviewsController {
  constructor(private readonly reviewsService: ReviewsService) {}

  /**
   * Submits a review for the artisan on a completed job.
   * The job must be in COMPLETED status and the caller must be the customer
   * who originally posted it. Only one review is accepted per job.
   *
   * @param req - Express request; `req.user.id` is injected by `JwtAuthGuard`.
   * @param createReviewDto - `jobId`, `rating` (1–5), optional `review` text
   *   (20–2000 chars), and optional `photoUrls` (RP1, max 3, pre-uploaded
   *   via `POST /uploads/review-photo`).
   * @returns The persisted review, `{ message, data: ReviewResponseDto }`.
   */
  @Post()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.CUSTOMER)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Submit a review for a completed job (customer only)',
  })
  @ApiCreatedResponse({
    description: 'Review submitted successfully.',
    type: ReviewResponseDto,
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT token' })
  @ApiForbiddenResponse({
    description: 'Caller does not have the CUSTOMER role',
  })
  create(
    @Req() req: AuthenticatedRequest,
    @Body() createReviewDto: CreateReviewDto,
  ) {
    return this.reviewsService.create(req.user.id, createReviewDto);
  }

  /**
   * Returns a paginated list of all reviews.
   * Supports `page`, `limit`, and `minRating` query params. `FLAGGED`
   * reviews are excluded unless the caller is the original reviewer (FL1).
   *
   * @param query - Pagination and filter options.
   * @returns Paginated array of {@link ReviewResponseDto}.
   */
  @Get()
  @UseGuards(OptionalJwtAuthGuard)
  @ApiOperation({ summary: 'Get all reviews (paginated)' })
  @ApiOkResponse({
    description: 'Returns paginated reviews.',
    type: [ReviewResponseDto],
  })
  findAll(
    @Req() req: AuthenticatedRequest,
    @Query() query: GetReviewsQueryDto,
  ) {
    return this.reviewsService.findAll(query, req.user?.id);
  }

  /**
   * Returns a paginated list of reviews for a specific artisan profile.
   *
   * @param artisanProfileId - The artisan profile ID to filter by.
   * @param query - Pagination and filter options.
   * @returns Paginated array of {@link ReviewResponseDto} for that artisan.
   */
  @Get('artisan-profile/:artisanProfileId')
  @UseGuards(OptionalJwtAuthGuard)
  @ApiOperation({ summary: 'Get paginated reviews for an artisan profile' })
  @ApiOkResponse({
    description: 'Returns reviews for one artisan profile.',
    type: [ReviewResponseDto],
  })
  findByArtisanProfile(
    @Req() req: AuthenticatedRequest,
    @Param('artisanProfileId', ParseIntPipe) artisanProfileId: number,
    @Query() query: GetReviewsQueryDto,
  ) {
    return this.reviewsService.findByArtisanProfileId(
      artisanProfileId,
      query,
      req.user?.id,
    );
  }

  /**
   * Returns a paginated list of reviews written about a specific user.
   *
   * @param reviewedUserId - The user ID who received the reviews.
   * @param query - Pagination and filter options.
   * @returns Paginated array of {@link ReviewResponseDto} for that user.
   */
  @Get('users/:reviewedUserId')
  @UseGuards(OptionalJwtAuthGuard)
  @ApiOperation({ summary: 'Get paginated reviews received by a user' })
  @ApiOkResponse({
    description: 'Returns reviews for one user receiving reviews.',
    type: [ReviewResponseDto],
  })
  findByReviewedUser(
    @Req() req: AuthenticatedRequest,
    @Param('reviewedUserId', ParseIntPipe) reviewedUserId: number,
    @Query() query: GetReviewsQueryDto,
  ) {
    return this.reviewsService.findByReviewedUserId(
      reviewedUserId,
      query,
      req.user?.id,
    );
  }

  /**
   * Returns a single review by its ID. Resolves 404 for a `FLAGGED` review
   * unless the caller is the original reviewer (FL1).
   *
   * @param id - The review ID to look up.
   * @returns The {@link ReviewResponseDto}.
   */
  @Get(':id')
  @UseGuards(OptionalJwtAuthGuard)
  @ApiOperation({ summary: 'Get a single review by ID' })
  @ApiOkResponse({
    description: 'Returns a single review.',
    type: ReviewResponseDto,
  })
  @ApiNotFoundResponse({
    description:
      'Review not found, or is FLAGGED and the caller is not the original reviewer',
  })
  findOne(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.reviewsService.findOne(id, req.user?.id);
  }

  /**
   * RE1: edits the caller's own review within the 48-hour edit window.
   * Allowed even when the review is currently `FLAGGED`.
   *
   * @param req - `req.user.id` identifies the caller; must be the original reviewer.
   * @param id - The review ID to edit.
   * @param dto - At least one of `rating`/`review` must be provided.
   */
  @Patch(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.CUSTOMER)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'RE1: edit your own review within 48h of submitting it',
  })
  @ApiOkResponse({ description: 'Review updated.', type: ReviewResponseDto })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT token' })
  @ApiForbiddenResponse({
    description:
      'Not the original reviewer, or the 48-hour edit window has passed',
  })
  @ApiNotFoundResponse({ description: 'Review not found' })
  update(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateReviewDto,
  ) {
    return this.reviewsService.update(req.user.id, id, dto);
  }

  /**
   * AR1: the reviewed artisan's one-time public reply — a dedicated
   * sub-resource, not a `PATCH` on the review itself.
   *
   * @param req - `req.user.id` must match the review's `reviewedUser`.
   * @param id - The review ID being replied to.
   */
  @Post(':id/replies')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.ARTISAN)
  @ApiBearerAuth()
  @ApiOperation({
    summary:
      'AR1: post a one-time public reply to a review about you (artisan only)',
  })
  @ApiCreatedResponse({ description: 'Reply posted.', type: ReviewResponseDto })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT token' })
  @ApiForbiddenResponse({
    description: 'Caller is not the artisan the review is about',
  })
  @ApiNotFoundResponse({ description: 'Review not found' })
  @ApiConflictResponse({ description: 'This review already has a reply' })
  addReply(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: CreateReviewReplyDto,
  ) {
    return this.reviewsService.addReply(req.user.id, id, dto);
  }

  /**
   * FL1: flags a review for admin review. Any authenticated user. Hides the
   * review from public view immediately (except to the original reviewer).
   *
   * @param req - `req.user` identifies the flagging user (actor of the log entry).
   * @param id - The review ID being flagged.
   */
  @Post(':id/flag')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'FL1: flag a review with a reason (any authenticated user)',
  })
  @ApiOkResponse({
    description: 'Review flagged and hidden pending admin review.',
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT token' })
  @ApiNotFoundResponse({ description: 'Review not found' })
  @ApiConflictResponse({ description: 'You have already flagged this review' })
  flag(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: FlagReviewDto,
  ) {
    return this.reviewsService.flag(req.user, id, dto);
  }
}

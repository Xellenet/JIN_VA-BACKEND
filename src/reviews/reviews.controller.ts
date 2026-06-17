import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '@common/decorators/roles.decorator';
import { Role } from '@common/types/enums';
import { Review } from './entities/review.entity';
import { ReviewsService } from './reviews.service';
import { CreateReviewDto } from './dto/create-review.dto';
import { GetReviewsQueryDto } from './dto/get-reviews-query.dto';

/**
 * Manages reviews left by customers after a job is completed.
 *
 * `POST /reviews` is restricted to authenticated customers and enforces that the
 * referenced job is in COMPLETED status before accepting a review.
 * Read endpoints are public and support pagination via `page` and `limit` query params.
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
   * @param createReviewDto - `jobId`, `rating` (1–5), and optional `review` text (20–2000 chars).
   * @returns The persisted {@link Review} with all relations populated.
   */
  @Post()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.CUSTOMER)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Submit a review for a completed job (customer only)' })
  @ApiCreatedResponse({ description: 'Review submitted successfully.', type: Review })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT token' })
  @ApiForbiddenResponse({ description: 'Caller does not have the CUSTOMER role' })
  create(@Req() req: any, @Body() createReviewDto: CreateReviewDto) {
    return this.reviewsService.create(req.user.id, createReviewDto);
  }

  /**
   * Returns a paginated list of all reviews.
   * Supports `page`, `limit`, and `minRating` query params.
   *
   * @param query - Pagination and filter options.
   * @returns Paginated array of {@link Review}.
   */
  @Get()
  @ApiOperation({ summary: 'Get all reviews (paginated)' })
  @ApiOkResponse({ description: 'Returns paginated reviews.', type: [Review] })
  findAll(@Query() query: GetReviewsQueryDto) {
    return this.reviewsService.findAll(query);
  }

  /**
   * Returns a paginated list of reviews for a specific artisan profile.
   *
   * @param artisanProfileId - The artisan profile ID to filter by.
   * @param query - Pagination and filter options.
   * @returns Paginated array of {@link Review} for that artisan.
   */
  @Get('artisan-profile/:artisanProfileId')
  @ApiOperation({ summary: 'Get paginated reviews for an artisan profile' })
  @ApiOkResponse({ description: 'Returns reviews for one artisan profile.', type: [Review] })
  findByArtisanProfile(
    @Param('artisanProfileId', ParseIntPipe) artisanProfileId: number,
    @Query() query: GetReviewsQueryDto,
  ) {
    return this.reviewsService.findByArtisanProfileId(artisanProfileId, query);
  }

  /**
   * Returns a paginated list of reviews written about a specific user.
   *
   * @param reviewedUserId - The user ID who received the reviews.
   * @param query - Pagination and filter options.
   * @returns Paginated array of {@link Review} for that user.
   */
  @Get('users/:reviewedUserId')
  @ApiOperation({ summary: 'Get paginated reviews received by a user' })
  @ApiOkResponse({ description: 'Returns reviews for one user receiving reviews.', type: [Review] })
  findByReviewedUser(
    @Param('reviewedUserId', ParseIntPipe) reviewedUserId: number,
    @Query() query: GetReviewsQueryDto,
  ) {
    return this.reviewsService.findByReviewedUserId(reviewedUserId, query);
  }

  /**
   * Returns a single review by its ID.
   *
   * @param id - The review ID to look up.
   * @returns The {@link Review} with all relations populated.
   */
  @Get(':id')
  @ApiOperation({ summary: 'Get a single review by ID' })
  @ApiOkResponse({ description: 'Returns a single review.', type: Review })
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.reviewsService.findOne(id);
  }
}

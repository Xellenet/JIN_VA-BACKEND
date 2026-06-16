import { Body, Controller, Get, Param, ParseIntPipe, Post } from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Review } from './entities/review.entity';
import { ReviewsService } from './reviews.service';
import { CreateReviewDto } from './dto/create-review.dto';


/**
 * Reviews Controller
 */
@ApiTags('Reviews')
@Controller('reviews')
export class ReviewsController {
  constructor(private readonly reviewsService: ReviewsService) {}

  @Post()
  @ApiCreatedResponse({ description: 'Review created successfully.', type: Review })
  create(@Body() createReviewDto: CreateReviewDto) {
    return this.reviewsService.create(createReviewDto);
  }

  @Get()
  @ApiOkResponse({ description: 'Returns all reviews.', type: [Review] })
  findAll() {
    return this.reviewsService.findAll();
  }

  @Get('artisan-profile/:artisanProfileId')
  @ApiOkResponse({ description: 'Returns reviews for one artisan profile.', type: [Review] })
  findByArtisanProfile(@Param('artisanProfileId', ParseIntPipe) artisanProfileId: number) {
    return this.reviewsService.findByArtisanProfileId(artisanProfileId);
  }

  @Get('users/:reviewedUserId')
  @ApiOkResponse({ description: 'Returns reviews for one user receiving reviews.', type: [Review] })
  findByReviewedUser(@Param('reviewedUserId', ParseIntPipe) reviewedUserId: number) {
    return this.reviewsService.findByReviewedUserId(reviewedUserId);
  }

  @Get(':id')
  @ApiOkResponse({ description: 'Returns a single review.', type: Review })
  findOne(@Param('id', ParseIntPipe) id: number) {
    return this.reviewsService.findOne(id);
  }
}

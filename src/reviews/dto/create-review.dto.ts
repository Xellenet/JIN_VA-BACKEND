import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export class CreateReviewDto {
  @ApiProperty({ example: 4, description: 'ArtisanProfile id this review belongs to' })
  @IsInt()
  artisanProfileId: number;

  @ApiPropertyOptional({
    example: 12,
    description: 'User id receiving the review. If not provided, artisan user will be used.',
  })
  @IsOptional()
  @IsInt()
  reviewedUserId?: number;

  @ApiPropertyOptional({ example: 3, description: 'Existing user id of reviewer' })
  @IsOptional()
  @IsInt()
  reviewerUserId?: number;

  @ApiProperty({ example: 4.5, minimum: 1, maximum: 5 })
  @Min(1)
  @Max(5)
  rating: number;

  @ApiPropertyOptional({ example: 'Fast response and excellent work quality.' })
  @IsOptional()
  @IsString()
  review?: string;

  @ApiPropertyOptional({ example: 'Ama Mensah' })
  @IsOptional()
  @IsString()
  reviewerName?: string;
}

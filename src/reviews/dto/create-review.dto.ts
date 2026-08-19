import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsNumber, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';

export class CreateReviewDto {
  @ApiProperty({ example: 3, description: 'ID of the completed job being reviewed' })
  @IsInt()
  jobId: number;

  @ApiProperty({ example: 4.5, minimum: 1, maximum: 5, description: 'Rating between 1 and 5' })
  @IsNumber()
  @Min(1)
  @Max(5)
  rating: number;

  @ApiPropertyOptional({
    example: 'Fast response and excellent work quality. Would highly recommend.',
    description: 'Optional review text (20–2000 characters)',
    minLength: 20,
    maxLength: 2000,
  })
  @IsOptional()
  @IsString()
  @MinLength(20)
  @MaxLength(2000)
  review?: string;
}

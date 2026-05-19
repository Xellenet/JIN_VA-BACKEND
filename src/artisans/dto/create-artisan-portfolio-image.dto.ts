import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, IsUrl, Min } from 'class-validator';

export class CreateArtisanPortfolioImageDto {
  @ApiProperty({ example: 'https://cdn.example.com/artisan/work-2.jpg' })
  @IsUrl()
  imageUrl: string;

  @ApiPropertyOptional({ example: 'Barbering station setup' })
  @IsOptional()
  @IsString()
  caption?: string;

  @ApiPropertyOptional({ example: 2 })
  @IsOptional()
  @IsInt()
  @Min(0)
  displayOrder?: number;
}

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsEmail,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { CreateArtisanPortfolioImageDto } from './create-artisan-portfolio-image.dto';

export class CreateArtisanDto {
  @ApiProperty({ example: 12, description: 'Existing user id for this artisan profile' })
  @IsInt()
  userId: number;

  @ApiPropertyOptional({
    example: [1, 2],
    description: 'Service IDs to map to artisan profile',
    type: [Number],
  })
  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  serviceIds?: number[];

  @ApiPropertyOptional({ example: '+233245001122' })
  @IsOptional()
  @IsString()
  contactPhone?: string;

  @ApiPropertyOptional({ example: 'artisan@example.com' })
  @IsOptional()
  @IsEmail()
  contactEmail?: string;

  @ApiPropertyOptional({ example: 5, description: 'Address id from addresses table' })
  @IsOptional()
  @IsInt()
  locationAddressId?: number;

  @ApiPropertyOptional({ example: 'Experienced artisan focused on high-quality home services.' })
  @IsOptional()
  @IsString()
  bio?: string;

  @ApiPropertyOptional({ example: 8 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(80)
  yearsOfExperience?: number;

  @ApiPropertyOptional({ example: ['NVTI Level 2', 'Safety Certified'] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  certifications?: string[];

  @ApiPropertyOptional({ example: 'LIC-77821' })
  @IsOptional()
  @IsString()
  licenseNumber?: string;

  @ApiPropertyOptional({ example: ['Pipe repairs', 'Drain cleaning'] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  specializations?: string[];

  @ApiPropertyOptional({ type: [CreateArtisanPortfolioImageDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateArtisanPortfolioImageDto)
  portfolioImages?: CreateArtisanPortfolioImageDto[];
}

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Expose, Type } from 'class-transformer';
import { ServiceResponseDto } from '@services/dto/service-response.dto';

/**
 * Minimal user snapshot exposed on a public artisan profile.
 * Does NOT include email, phone number, or other sensitive fields.
 */
export class ArtisanPublicUserDto {
  @ApiProperty({ example: 1 })
  @Expose()
  id: number;

  @ApiProperty({ example: 'Kofi' })
  @Expose()
  firstname: string;

  @ApiProperty({ example: 'Mensah' })
  @Expose()
  lastname: string;

  @ApiPropertyOptional({ example: '/uploads/avatars/avatar-123.jpg' })
  @Expose()
  profilePicture?: string;
}

/**
 * Public-facing artisan profile returned by `GET /artisans` and `GET /artisans/:id`.
 * Excludes sensitive user fields (email, phone). Use `ArtisanProfileResponseDto`
 * for authenticated self-view endpoints.
 */
export class ArtisanPublicResponseDto {
  @ApiProperty({ example: 1 })
  @Expose()
  id: number;

  @ApiPropertyOptional({ example: 'Experienced master plumber with 8 years in residential work.' })
  @Expose()
  bio?: string;

  @ApiPropertyOptional({ example: 8 })
  @Expose()
  experienceYears?: number;

  @ApiPropertyOptional({ example: 45.5 })
  @Expose()
  hourlyRate?: number;

  @ApiProperty({ example: 'GHS', description: 'ISO 4217 currency code for the hourly rate' })
  @Expose()
  currency!: string;

  @ApiPropertyOptional({ example: 'Kofi Home Services' })
  @Expose()
  businessName?: string;

  @ApiProperty({ example: 4.5 })
  @Expose()
  averageRating: number;

  @ApiProperty({ example: 12 })
  @Expose()
  totalReviews: number;

  @ApiProperty({ example: 'AVAILABLE', description: 'AVAILABLE | BUSY | OFFLINE' })
  @Expose()
  availabilityStatus: string;

  @ApiProperty({ example: false, description: 'Platform-verified artisan badge' })
  @Expose()
  isVerified: boolean;

  @ApiPropertyOptional({ example: 'Accra, Ghana' })
  @Expose()
  location?: string;

  @ApiProperty({ type: [ServiceResponseDto] })
  @Expose()
  @Type(() => ServiceResponseDto)
  services: ServiceResponseDto[];

  @ApiProperty({ type: ArtisanPublicUserDto })
  @Expose()
  @Type(() => ArtisanPublicUserDto)
  user: ArtisanPublicUserDto;

  @ApiProperty()
  @Expose()
  createdAt: Date;

  @ApiProperty()
  @Expose()
  updatedAt: Date;
}

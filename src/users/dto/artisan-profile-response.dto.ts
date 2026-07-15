import { ApiProperty } from '@nestjs/swagger';
import { Expose, Type } from 'class-transformer';
import { UserResponseDto } from './user-response.dto';
import { ServiceResponseDto } from '@services/dto/service-response.dto';

export class ArtisanProfileResponseDto {
  @ApiProperty({ example: 1 })
  @Expose()
  id: number;

  @ApiProperty({ required: false })
  @Expose()
  bio?: string;

  @ApiProperty({ example: 5, required: false })
  @Expose()
  experienceYears?: number;

  @ApiProperty({ example: 35.5, required: false })
  @Expose()
  hourlyRate?: number;

  @ApiProperty({ example: 'GHS', description: 'ISO 4217 currency code for the hourly rate' })
  @Expose()
  currency!: string;

  @ApiProperty({ example: 'XelleNet Pros', required: false })
  @Expose()
  businessName?: string;

  @ApiProperty({ example: 4.5 })
  @Expose()
  averageRating: number;

  @ApiProperty({ example: 12 })
  @Expose()
  totalReviews: number;

  @ApiProperty({ example: 'AVAILABLE' })
  @Expose()
  availabilityStatus: string;

  @ApiProperty({ example: false, description: 'Whether the artisan has been verified by an admin' })
  @Expose()
  isVerified: boolean;

  @ApiProperty({ example: 'Accra, Ghana', required: false })
  @Expose()
  location?: string;

  @ApiProperty({ type: [ServiceResponseDto], required: false })
  @Expose()
  @Type(() => ServiceResponseDto)
  services?: ServiceResponseDto[];

  @ApiProperty({ type: UserResponseDto })
  @Expose()
  @Type(() => UserResponseDto)
  user: UserResponseDto;

  @ApiProperty()
  @Expose()
  createdAt: Date;

  @ApiProperty()
  @Expose()
  updatedAt: Date;
}

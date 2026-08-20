import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Expose } from 'class-transformer';
import { PortfolioStatus } from '@common/types/enums';

export class PortfolioItemResponseDto {
  @ApiProperty({ example: 1 })
  @Expose()
  id!: number;

  @ApiProperty({
    example: 12,
    description: 'The ArtisanProfile ID this item belongs to.',
  })
  @Expose()
  artisanId!: number;

  @ApiProperty({ example: '/uploads/portfolio/uuid.jpg' })
  @Expose()
  fileUrl!: string;

  @ApiProperty({ example: 'image/jpeg' })
  @Expose()
  fileType!: string;

  @ApiPropertyOptional({ example: 'Full bathroom pipe replacement.' })
  @Expose()
  caption?: string;

  @ApiPropertyOptional({ example: 'Plumbing' })
  @Expose()
  tag?: string;

  @ApiProperty({ enum: PortfolioStatus, example: PortfolioStatus.PENDING })
  @Expose()
  status!: PortfolioStatus;

  @ApiPropertyOptional({
    example: 'Image is too blurry to evaluate the work quality.',
    description:
      'Only present while status is REJECTED — cleared on resubmission.',
  })
  @Expose()
  rejectionReason?: string;

  @ApiProperty({ example: 0 })
  @Expose()
  sortOrder!: number;

  @ApiProperty()
  @Expose()
  createdAt!: Date;
}

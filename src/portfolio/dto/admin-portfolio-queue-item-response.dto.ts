import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Expose, Transform } from 'class-transformer';
import { PortfolioItem } from '../entities/portfolio-item.entity';

/** PF4: shape returned by `GET /admin/portfolio/queue` for the moderation UI. */
export class AdminPortfolioQueueItemResponseDto {
  @ApiProperty({ example: 1 })
  @Expose()
  id!: number;

  @ApiProperty({ example: 12 })
  @Expose()
  artisanId!: number;

  @ApiProperty({ example: 'Kofi Mensah' })
  @Expose()
  @Transform(({ obj }: { obj: PortfolioItem }) => {
    const user = obj.artisanProfile?.user;
    return user ? `${user.firstname} ${user.lastname}` : undefined;
  })
  artisanName!: string;

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

  @ApiProperty({ description: 'When the artisan submitted this item.' })
  @Expose()
  createdAt!: Date;
}

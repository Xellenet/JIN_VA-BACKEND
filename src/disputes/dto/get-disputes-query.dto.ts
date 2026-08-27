import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { DisputeCategory, DisputeStatus } from '@common/types/enums';

export class GetDisputesQueryDto {
  @ApiPropertyOptional({ enum: DisputeStatus })
  @IsOptional()
  @IsEnum(DisputeStatus)
  status?: DisputeStatus;

  /** DR5/DQ1: server-side category filter, alongside the status filter. */
  @ApiPropertyOptional({ enum: DisputeCategory })
  @IsOptional()
  @IsEnum(DisputeCategory)
  category?: DisputeCategory;

  /**
   * DQ1: server-side search across the *whole* dispute set. Matches on
   * dispute id (exact, when `q` is numeric), the raiser's first/last name,
   * their email, and the booking id.
   */
  @ApiPropertyOptional({
    example: 'Ama',
    description:
      "Server-side search across dispute id, booking id, and the raiser's name/email.",
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  @ApiPropertyOptional({ example: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ example: 20, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;
}

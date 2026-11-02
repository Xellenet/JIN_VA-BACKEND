import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';

/**
 * Artisan fixes (B5): `GET /disputes/my`. `responseDue=true` keeps only the
 * disputes waiting on the caller's response. Any other parameter is rejected
 * by the global pipe.
 */
export class MyDisputesQueryDto {
  @ApiPropertyOptional({ enum: ['true'] })
  @IsOptional()
  @IsIn(['true'], { message: 'responseDue must be true when given' })
  responseDue?: 'true';
}

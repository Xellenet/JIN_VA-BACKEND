import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsNumber, IsOptional, IsPositive } from 'class-validator';

export class AdminRefundDto {
  @ApiPropertyOptional({ description: 'Partial refund amount in GHS. Omit to refund the full amount.' })
  @IsOptional()
  @IsNumber()
  @IsPositive()
  amountGhs?: number;
}

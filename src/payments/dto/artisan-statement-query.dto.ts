import { ApiPropertyOptional, OmitType } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  Max,
  Min,
} from 'class-validator';
import { splitCommaList } from '../../jobs/dto/get-my-jobs-query.dto';
import { CUSTOMER_SPEND_RANGES } from '../../customer-insights/customer-range';
import type { CustomerSpendRange } from '../../customer-insights/customer-range';
import { EARNING_STAGES } from '../../artisan-insights/earnings.util';
import type { EarningStage } from '../../artisan-insights/earnings.util';

/**
 * Artisan fixes (B2): `GET /payments/my-earnings/statement`. The owner is the
 * JWT subject; unknown fields (including any artisan or user id) are
 * rejected by the global pipe.
 */
export class ArtisanStatementQueryDto {
  @ApiPropertyOptional({ enum: CUSTOMER_SPEND_RANGES, default: '12m' })
  @IsOptional()
  @IsIn(CUSTOMER_SPEND_RANGES as unknown as string[])
  period?: CustomerSpendRange;

  @ApiPropertyOptional({
    example: 'held,needs_action',
    description: `Comma list of statement stages (1–7): ${EARNING_STAGES.join(', ')}`,
  })
  @IsOptional()
  @Transform(({ value }) => splitCommaList(value))
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(EARNING_STAGES.length)
  @IsIn(EARNING_STAGES as unknown as string[], { each: true })
  stage?: EarningStage[];

  @ApiPropertyOptional({ minimum: 1, maximum: 1000, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  page?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

/** B2 CSV: the same filters, without `page` and `limit`. */
export class ArtisanStatementExportQueryDto extends OmitType(
  ArtisanStatementQueryDto,
  ['page', 'limit'] as const,
) {}

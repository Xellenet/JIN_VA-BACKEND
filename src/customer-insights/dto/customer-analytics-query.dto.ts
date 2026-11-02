import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import {
  CUSTOMER_SPEND_RANGES,
  DEFAULT_CUSTOMER_SPEND_RANGE,
} from '../customer-range';
import type { CustomerSpendRange } from '../customer-range';

/**
 * Customer experience v2 (B2): `GET /analytics/customer?range=`. Uses the
 * local `CustomerSpendRange`; the artisan and admin range DTOs are untouched.
 * Any other parameter (e.g. `customerId`) is rejected by the global pipe.
 */
export class CustomerAnalyticsQueryDto {
  @ApiPropertyOptional({
    enum: CUSTOMER_SPEND_RANGES,
    default: DEFAULT_CUSTOMER_SPEND_RANGE,
    description: '30d | 90d | 12m | all (default 12m)',
  })
  @IsOptional()
  @IsIn(CUSTOMER_SPEND_RANGES as unknown as string[])
  range?: CustomerSpendRange;
}

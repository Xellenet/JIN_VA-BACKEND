import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * Body sent by an artisan when applying to a job.
 * Both fields are optional — artisans may apply without a quote or a message,
 * though including a quote is recommended for customer review.
 */
export class CreateApplicationDto {
  @ApiPropertyOptional({
    example: 250,
    description:
      'Proposed price for the job in GHS (> 0, up to 2 decimals). It becomes the payment amount if the customer accepts.',
  })
  @IsOptional()
  @IsNumber(
    { maxDecimalPlaces: 2 },
    { message: 'quotePrice must have at most 2 decimal places' },
  )
  // QA JOB-08: a GH₵ 0 quote became a GH₵ 0 payment that Paystack rejects.
  @Min(0.01, { message: 'quotePrice must be greater than 0' })
  @Type(() => Number)
  quotePrice?: number;

  @ApiPropertyOptional({
    example: 'I have 5 years of plumbing experience and can start tomorrow.',
    description: 'Cover message to the customer (max 1000 chars).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  message?: string;
}

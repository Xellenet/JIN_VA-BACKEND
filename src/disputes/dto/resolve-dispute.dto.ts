import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { DisputeOutcome } from '@common/types/enums';

export class ResolveDisputeDto {
  /**
   * DR1: mandatory. A resolution records *which way the admin ruled*, not
   * just prose — the three values are PRD §5.13's three outcomes and the
   * first two carry a money consequence (DR2).
   */
  @ApiProperty({
    enum: DisputeOutcome,
    description:
      'The verdict. REFUND_CLIENT refunds the linked payment (full by default, or the partial `refundAmountGhs`); ' +
      'RELEASE_ARTISAN releases a withheld payment to the artisan; MUTUAL records the ruling and moves no money.',
  })
  @IsEnum(DisputeOutcome)
  outcome!: DisputeOutcome;

  @ApiProperty({
    example:
      'After reviewing both parties, the customer is entitled to a partial refund.',
  })
  @IsString()
  @MinLength(10, { message: 'Resolution must be at least 10 characters.' })
  @MaxLength(2000)
  resolution!: string;

  /**
   * DR2: only meaningful with `outcome = REFUND_CLIENT`. Omit for a full
   * refund of the remaining refundable balance. The amount is validated
   * against that remaining balance server-side by `PaymentsService.adminRefund`
   * — this bound is only a first-pass sanity check.
   */
  @ApiPropertyOptional({
    description:
      'Partial refund amount in GHS, for REFUND_CLIENT only. Omit to refund the full remaining balance.',
    example: 250.5,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  @Min(0.01)
  refundAmountGhs?: number;

  @ApiPropertyOptional({
    example:
      'Customer provided photo evidence. Artisan acknowledged incomplete work.',
    description: 'Admin-internal. Never returned on a party-facing read.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  adminNotes?: string;
}

export class CloseDisputeDto {
  @ApiPropertyOptional({ example: 'Both parties reached a private agreement.' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  adminNotes?: string;
}

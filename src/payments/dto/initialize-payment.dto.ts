import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsOptional, IsPositive } from 'class-validator';

export class InitializePaymentDto {
  @ApiProperty({ description: 'ID of the job to pay for' })
  @IsInt()
  @IsPositive()
  jobId!: number;

  @ApiPropertyOptional({
    description:
      'Saved payment methods: the customer ticked "Save this card for next time". ' +
      'Only a reusable card from this payment is saved, never card details.',
  })
  @IsOptional()
  @IsBoolean()
  saveCard?: boolean;
}

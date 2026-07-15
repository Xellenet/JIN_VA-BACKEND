import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsPositive } from 'class-validator';

export class InitializePaymentDto {
  @ApiProperty({ description: 'ID of the job to pay for' })
  @IsInt()
  @IsPositive()
  jobId!: number;
}

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class ResolveDisputeDto {
  @ApiProperty({ example: 'After reviewing both parties, the customer is entitled to a partial refund.' })
  @IsString()
  @MinLength(10, { message: 'Resolution must be at least 10 characters.' })
  @MaxLength(2000)
  resolution!: string;

  @ApiPropertyOptional({ example: 'Customer provided photo evidence. Artisan acknowledged incomplete work.' })
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

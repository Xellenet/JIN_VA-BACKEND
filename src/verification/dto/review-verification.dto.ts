import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class ApproveVerificationDto {
  @ApiPropertyOptional({ example: 'Documents look authentic and match the profile.' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}

export class RejectVerificationDto {
  @ApiProperty({ example: 'Document image is blurry and unreadable.' })
  @IsString()
  @MinLength(10)
  @MaxLength(1000)
  reason!: string;

  @ApiPropertyOptional({ example: 'Please resubmit with a clearer photo.' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}

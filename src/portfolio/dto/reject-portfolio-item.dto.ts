import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength, MaxLength } from 'class-validator';

export class RejectPortfolioItemDto {
  @ApiProperty({ example: 'Image is too blurry to evaluate the work quality.' })
  @IsString()
  @MinLength(10)
  @MaxLength(1000)
  rejectionReason!: string;
}

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export class CreatePortfolioItemDto {
  @ApiProperty({
    example: 'Plumbing',
    description: 'Service category this piece of work belongs to.',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  tag!: string;

  @ApiPropertyOptional({
    example: 'Full bathroom pipe replacement, completed in one day.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  caption?: string;
}

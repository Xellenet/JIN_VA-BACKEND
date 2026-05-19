import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class CreateServiceDto {
  @ApiProperty({ example: 'Plumbing' })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiPropertyOptional({ example: 'Pipe repairs, drain cleaning, bathroom fittings.' })
  @IsOptional()
  @IsString()
  description?: string;
}

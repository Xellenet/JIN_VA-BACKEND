import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { Status } from '@common/types/enums';

/**
 * Query parameters accepted by `GET /jobs` and `GET /jobs/mine`.
 * All fields are optional; defaults are applied in the service layer.
 */
export class GetJobsQueryDto {
  @ApiPropertyOptional({ enum: Status, example: Status.OPEN, description: 'Filter by job status' })
  @IsOptional()
  @IsEnum(Status)
  status?: Status;

  @ApiPropertyOptional({ example: 1, description: 'Filter by service category ID' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  serviceId?: number;

  @ApiPropertyOptional({ example: 'Accra', description: 'Partial, case-insensitive location search' })
  @IsOptional()
  @IsString()
  location?: string;

  @ApiPropertyOptional({ example: 1, default: 1, description: 'Page number (1-based)' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  page?: number;

  @ApiPropertyOptional({ example: 10, default: 10, description: 'Number of results per page (max 50)' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50)
  @Type(() => Number)
  limit?: number;
}

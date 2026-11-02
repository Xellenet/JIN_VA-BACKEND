import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { Status } from '@common/types/enums';

/**
 * Splits a comma list (`PENDING,IN_PROGRESS`) into trimmed, de-duplicated
 * values. Repeated parameters (`status=A&status=B`) are accepted the same way.
 * Empty items are kept as `''` on purpose, so `status=,` fails `IsEnum`
 * instead of silently meaning "no filter". Exported for the payment-history
 * DTO, which takes its `status` list by the same rule.
 */
export function splitCommaList(value: unknown): unknown {
  if (value === undefined || value === null) return value;
  const items: unknown[] = Array.isArray(value) ? value : [value];
  const parts = items.flatMap((v): unknown[] =>
    typeof v === 'string' ? v.split(',') : [v],
  );
  const trimmed = parts.map((p): unknown =>
    typeof p === 'string' ? p.trim() : p,
  );
  return [...new Set(trimmed)];
}

/**
 * Customer experience v2 (B7b): query for `GET /jobs/mine` only. `GET /jobs`
 * keeps `GetJobsQueryDto` unchanged.
 *
 * The one difference is `status`, which takes a comma list of 1–6 statuses so
 * an Overview stage ("In progress" = `PENDING,IN_PROGRESS`) is one paginated
 * query. A single status or none behaves exactly as before.
 */
export class GetMyJobsQueryDto {
  @ApiPropertyOptional({
    example: 'PENDING,IN_PROGRESS',
    description:
      'Comma list of job statuses (1–6, upper case). Empty or unknown values give 400.',
  })
  @IsOptional()
  @Transform(({ value }) => splitCommaList(value))
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(6)
  @IsEnum(Status, { each: true })
  status?: Status[];

  @ApiPropertyOptional({
    example: 1,
    description: 'Filter by service category ID',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  serviceId?: number;

  @ApiPropertyOptional({
    example: 'Accra',
    description: 'Partial, case-insensitive location search',
  })
  @IsOptional()
  @IsString()
  location?: string;

  @ApiPropertyOptional({ example: 1, default: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  page?: number;

  @ApiPropertyOptional({ example: 10, default: 10, maximum: 50 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50)
  @Type(() => Number)
  limit?: number;
}

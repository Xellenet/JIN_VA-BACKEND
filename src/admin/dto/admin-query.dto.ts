import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsPositive,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import {
  AdminUserStatus,
  BookingStatus,
  Role,
  Status,
} from '@common/types/enums';

export class AdminUsersQueryDto {
  @ApiPropertyOptional({ enum: Role })
  @IsOptional()
  @IsEnum(Role)
  role?: Role;

  /**
   * Kept for backward compatibility with existing callers. Prefer `status`,
   * which distinguishes suspended from banned (AT3). When both are supplied,
   * `status` wins.
   */
  @ApiPropertyOptional({
    example: false,
    description:
      'Deprecated — use `status`. Filter by banned status only. `status` takes precedence when both are sent.',
  })
  @IsOptional()
  // Query-string values arrive as strings; coerce the two boolean literals so
  // `?isBanned=true` keeps working as it did before `status` existed.
  @Transform(({ value }): boolean | undefined => {
    if (value === 'true' || value === true) return true;
    if (value === 'false' || value === false) return false;
    return undefined;
  })
  @IsBoolean()
  isBanned?: boolean;

  /**
   * AT3: PRD §5.13 explicitly requires filters on role, status and join date.
   * `ACTIVE` means neither banned nor suspended; `BANNED` wins over
   * `SUSPENDED` when an account is both.
   */
  @ApiPropertyOptional({
    enum: AdminUserStatus,
    description:
      'ACTIVE = neither banned nor suspended. BANNED takes precedence when an account is both.',
  })
  @IsOptional()
  @IsEnum(AdminUserStatus)
  status?: AdminUserStatus;

  /** AT3: join-date filter, inclusive. ISO date or date-time. */
  @ApiPropertyOptional({
    example: '2026-01-01',
    description: 'Only users who joined on or after this date (inclusive).',
  })
  @IsOptional()
  @IsDateString()
  joinedFrom?: string;

  @ApiPropertyOptional({
    example: '2026-08-31',
    description:
      'Only users who joined on or before this date (inclusive — a bare date covers the whole day).',
  })
  @IsOptional()
  @IsDateString()
  joinedTo?: string;

  @ApiPropertyOptional({ example: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ example: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;
}

/** A6: minimal admin read path — bookings are a wholly new-to-production entity. */
export class AdminBookingsQueryDto {
  @ApiPropertyOptional({ enum: BookingStatus })
  @IsOptional()
  @IsEnum(BookingStatus)
  status?: BookingStatus;

  @ApiPropertyOptional({ description: 'Filter by artisan profile ID' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  artisanProfileId?: number;

  @ApiPropertyOptional({ description: 'Filter by customer user ID' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  customerId?: number;

  @ApiPropertyOptional({ example: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ example: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;
}

export class AdminJobsQueryDto {
  @ApiPropertyOptional({ enum: Status })
  @IsOptional()
  @IsEnum(Status)
  status?: Status;

  @ApiPropertyOptional({ example: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ example: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;
}

/**
 * AT6: the one admin-only cross-entity lookup. Deliberately scoped to users,
 * jobs and disputes by the identifiers an admin realistically has (name,
 * email, id) — it is **not** a general full-text search over messages,
 * reviews or payment records.
 */
export class AdminSearchQueryDto {
  @ApiPropertyOptional({
    example: 'ama@example.com',
    description:
      'Name, email or numeric id. At least 2 characters — a 1-character term would return most of the platform.',
  })
  @IsString()
  @MinLength(2, { message: 'Search term must be at least 2 characters.' })
  @MaxLength(100)
  q!: string;

  @ApiPropertyOptional({
    example: 5,
    default: 5,
    description: 'Max results per entity type (users / jobs / disputes).',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(25)
  limit?: number = 5;
}

/** AT3: the mandatory reason captured when an admin suspends an account. */
export class SuspendUserDto {
  @ApiPropertyOptional({
    example: 'Repeated no-shows on confirmed bookings; pending investigation.',
    minLength: 10,
    maxLength: 1000,
  })
  @IsString()
  @MinLength(10, { message: 'A reason of at least 10 characters is required.' })
  @MaxLength(1000)
  reason!: string;
}

/** AT2/AT5: optional reason captured on a ban, so the audit row can carry it. */
export class BanUserDto {
  @ApiPropertyOptional({
    example: 'Fraudulent payment activity confirmed by the payments provider.',
    maxLength: 1000,
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;
}

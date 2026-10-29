import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';
import { AdminActionTarget, AdminActionType } from '@common/types/enums';

/** AT5: filters on the paginated, newest-first admin action log. */
export class GetAdminActionsQueryDto {
  @ApiPropertyOptional({ enum: AdminActionType })
  @IsOptional()
  @IsEnum(AdminActionType)
  action?: AdminActionType;

  @ApiPropertyOptional({ description: 'Filter by the acting admin’s user id' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  actorId?: number;

  @ApiPropertyOptional({
    enum: AdminActionTarget,
    description: 'Scope to one kind of target (used by the entity-scoped view)',
  })
  @IsOptional()
  @IsEnum(AdminActionTarget)
  targetType?: AdminActionTarget;

  @ApiPropertyOptional({
    description: 'Scope to one specific target id (pair with targetType)',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  targetId?: number;

  @ApiPropertyOptional({ example: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ example: 20, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;
}

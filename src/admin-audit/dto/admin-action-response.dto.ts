import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Expose } from 'class-transformer';
import { AdminActionTarget, AdminActionType } from '@common/types/enums';

/** AT5: one row of the append-only admin action log. */
export class AdminActionResponseDto {
  @Expose() @ApiProperty() id!: number;

  @Expose()
  @ApiProperty({ enum: AdminActionType })
  action!: AdminActionType;

  @Expose()
  @ApiProperty({ enum: AdminActionTarget })
  targetType!: AdminActionTarget;

  @Expose() @ApiProperty() targetId!: number;

  @Expose()
  @ApiPropertyOptional({
    description:
      'Snapshot label of what was acted on, captured at action time so the row stays readable after the target is deleted.',
  })
  targetLabel?: string | null;

  @Expose() @ApiPropertyOptional() reason?: string | null;

  @Expose() @ApiProperty() actorId!: number;
  @Expose() @ApiPropertyOptional() actorName?: string | null;
  @Expose() @ApiPropertyOptional() actorEmail?: string | null;

  @Expose()
  @ApiPropertyOptional({
    description: 'Dispute verdict, for DISPUTE_RESOLVE rows only.',
  })
  outcome?: string | null;

  @Expose()
  @ApiPropertyOptional({
    description: 'NONE | REFUND | RELEASE — whether money actually moved.',
  })
  moneyAction?: string | null;

  @Expose()
  @ApiPropertyOptional({ description: 'GHS amount moved, where one moved.' })
  amount?: number | null;

  @Expose() @ApiPropertyOptional() metadata?: Record<string, unknown> | null;

  @Expose() @ApiProperty() createdAt!: Date;
}

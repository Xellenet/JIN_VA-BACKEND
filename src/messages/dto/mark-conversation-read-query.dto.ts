import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

/**
 * M1 `PATCH /messages/:id/read?upToMessageId=`. With the bound, only messages
 * up to that id are marked read, so one that arrives between the menu's poll
 * and this call is not marked read unseen. Without it, behaviour is unchanged.
 */
export class MarkConversationReadQueryDto {
  @ApiPropertyOptional({
    minimum: 1,
    description:
      'Only mark messages with an id up to and including this one as read.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'upToMessageId must be a whole number' })
  @Min(1, { message: 'upToMessageId must be 1 or more' })
  @Max(2147483647, { message: 'upToMessageId is too large' })
  upToMessageId?: number;
}

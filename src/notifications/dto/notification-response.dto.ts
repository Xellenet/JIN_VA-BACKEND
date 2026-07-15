import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Expose } from 'class-transformer';

export class NotificationResponseDto {
  @Expose() @ApiProperty() id!: number;
  @Expose() @ApiProperty() type!: string;
  @Expose() @ApiProperty() title!: string;
  @Expose() @ApiProperty() body!: string;
  @Expose() @ApiProperty() isRead!: boolean;
  @Expose() @ApiPropertyOptional() payload?: Record<string, unknown>;
  @Expose() @ApiProperty() createdAt!: Date;
}

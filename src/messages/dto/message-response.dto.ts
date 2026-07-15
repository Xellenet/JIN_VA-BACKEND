import { ApiProperty } from '@nestjs/swagger';
import { Expose, Type } from 'class-transformer';

export class MessageSenderDto {
  @Expose() @ApiProperty() id!: number;
  @Expose() @ApiProperty() firstname!: string;
  @Expose() @ApiProperty() lastname!: string;
  @Expose() @ApiProperty({ nullable: true }) profilePicture?: string;
}

export class MessageResponseDto {
  @Expose() @ApiProperty() id!: number;
  @Expose() @ApiProperty() content!: string;
  @Expose() @ApiProperty() isRead!: boolean;
  @Expose() @ApiProperty() createdAt!: Date;

  @Expose()
  @Type(() => MessageSenderDto)
  @ApiProperty({ type: MessageSenderDto })
  sender!: MessageSenderDto;
}

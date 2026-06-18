import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Expose, Type } from 'class-transformer';

export class ConversationParticipantDto {
  @Expose() @ApiProperty() id!: number;
  @Expose() @ApiProperty() firstname!: string;
  @Expose() @ApiProperty() lastname!: string;
  @Expose() @ApiPropertyOptional({ nullable: true }) profilePicture?: string;
}

export class ConversationResponseDto {
  @Expose() @ApiProperty() id!: number;

  @Expose()
  @Type(() => ConversationParticipantDto)
  @ApiProperty({ type: ConversationParticipantDto })
  participantA!: ConversationParticipantDto;

  @Expose()
  @Type(() => ConversationParticipantDto)
  @ApiProperty({ type: ConversationParticipantDto })
  participantB!: ConversationParticipantDto;

  @Expose() @ApiPropertyOptional({ nullable: true }) lastMessageAt?: Date;
  @Expose() @ApiProperty() createdAt!: Date;
}

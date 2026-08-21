import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ConversationContactDto,
  ConversationLastMessageDto,
} from './message-response.dto';

export class ConversationParticipantDto {
  @ApiProperty() id!: number;
  @ApiProperty() firstname!: string;
  @ApiProperty() lastname!: string;
  @ApiPropertyOptional({ nullable: true }) profilePicture?: string | null;
}

/**
 * MB3: the canonical, server-paginated conversation row.
 *
 * `contact`, `lastMessage` and `unreadCount` are additions made during the
 * consolidation. They are not new scope — they are the three things the
 * retired `/direct-messages/conversations` computed (unpaginated, by grouping
 * every message client-side) that the conversation list, its unread badges and
 * HB1's header dot all genuinely need. Without them the frontend could not
 * switch off the retired module without regressing.
 *
 * `participantA`/`participantB` are retained unchanged so nothing already
 * reading this shape breaks; `contact` is the field to prefer, since it is
 * already resolved from the caller's point of view and carries the role.
 */
export class ConversationResponseDto {
  @ApiProperty() id!: number;

  @ApiProperty({
    type: ConversationContactDto,
    description:
      'The *other* participant, resolved relative to the authenticated caller. ' +
      'Prefer this over participantA/participantB.',
  })
  contact!: ConversationContactDto;

  @ApiProperty({
    type: ConversationLastMessageDto,
    nullable: true,
    description:
      'Most recent message in the thread, or null for a conversation with no ' +
      'messages yet.',
  })
  lastMessage!: ConversationLastMessageDto | null;

  @ApiProperty({
    example: 3,
    description:
      'Unread messages in this conversation sent by the other participant. ' +
      "Drives the row badge and HB1's header Mail dot (any conversation with " +
      'unreadCount > 0).',
  })
  unreadCount!: number;

  @ApiProperty({ type: ConversationParticipantDto })
  participantA!: ConversationParticipantDto;

  @ApiProperty({ type: ConversationParticipantDto })
  participantB!: ConversationParticipantDto;

  @ApiPropertyOptional({ nullable: true }) lastMessageAt?: Date | null;
  @ApiProperty() createdAt!: Date;
}

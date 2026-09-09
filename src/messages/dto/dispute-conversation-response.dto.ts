import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { MessageResponseDto } from './message-response.dto';

/**
 * AD1: a participant in a dispute-scoped conversation, labelled by role so the
 * admin view can render "Client"/"Artisan" tags instead of guessing which side
 * of the thread is which (the admin is not a participant, so the usual
 * own/other framing doesn't apply).
 */
export class DisputeConversationParticipantDto {
  @ApiPropertyOptional({
    description:
      'C1: absent when this party has deleted their account. `role` is still ' +
      "correct — it comes from the dispute's own sides, not from the user row.",
  })
  id?: number;

  @ApiProperty({
    description: 'C1: `"Deleted"` / `"User"` when this party has deleted.',
  })
  firstname!: string;

  @ApiProperty() lastname!: string;
  @ApiProperty({ nullable: true }) profilePicture!: string | null;
  @ApiProperty({ enum: ['CUSTOMER', 'ARTISAN'] }) role!: string;
}

export class DisputeConversationResponseDto {
  @ApiProperty({ description: 'The conversation whose thread this is.' })
  conversationId!: number;

  @ApiProperty({ description: 'The dispute this lookup was authorized by.' })
  disputeId!: number;

  @ApiProperty({ description: "The dispute's underlying booking." })
  bookingId!: number;

  @ApiProperty({ type: DisputeConversationParticipantDto })
  customer!: DisputeConversationParticipantDto;

  @ApiProperty({ type: DisputeConversationParticipantDto })
  artisan!: DisputeConversationParticipantDto;

  @ApiProperty({
    description:
      'Total messages in the thread, regardless of how many are returned.',
  })
  totalMessages!: number;

  @ApiProperty({
    type: [MessageResponseDto],
    description:
      'The thread, oldest-first. Capped at the most recent 200 messages — ' +
      'compare against `totalMessages` to tell whether the thread was truncated.',
  })
  messages!: MessageResponseDto[];

  @ApiProperty({
    example: true,
    description:
      'Always true. This view is read-only by construction: no admin write ' +
      'path into a customer↔artisan thread exists anywhere in the API.',
  })
  readOnly!: boolean;
}

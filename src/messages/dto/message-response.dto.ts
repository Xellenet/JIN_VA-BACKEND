import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Expose, Type } from 'class-transformer';

export class MessageSenderDto {
  @Expose() @ApiProperty() id!: number;
  @Expose() @ApiProperty() firstname!: string;
  @Expose() @ApiProperty() lastname!: string;
  @Expose() @ApiProperty({ nullable: true }) profilePicture?: string;
}

export class MessageResponseDto {
  @Expose() @ApiProperty() id!: number;

  /**
   * MC4: `null` for an image-only message. Was non-nullable before this
   * round — see api-contract.md, the frontend must handle null here.
   */
  @Expose()
  @ApiProperty({
    nullable: true,
    description: 'Message text, or null for an image-only message.',
  })
  content!: string | null;

  /** MC4: the attached image's URL, or null when the message has no image. */
  @Expose()
  @ApiProperty({
    nullable: true,
    example: '/uploads/messages/uuid.jpg',
    description: 'URL of the attached image, or null.',
  })
  attachmentUrl!: string | null;

  @Expose()
  @ApiProperty({
    nullable: true,
    example: 'image/jpeg',
    description: 'MIME type of the attached image, or null.',
  })
  attachmentType!: string | null;

  /** MC2: the job/booking this message was composed about, if any. */
  @Expose()
  @ApiProperty({
    nullable: true,
    description:
      'MC2: the job this message references, or null for a general inquiry.',
  })
  jobId!: number | null;

  @Expose()
  @ApiProperty({
    nullable: true,
    description:
      'MC2: the booking this message references, or null for a general inquiry.',
  })
  bookingId!: number | null;

  /**
   * MR2: already sufficient for the frontend's read-receipt tick — no
   * additional backend field was needed for it.
   */
  @Expose() @ApiProperty() isRead!: boolean;
  @Expose() @ApiProperty() createdAt!: Date;

  @Expose()
  @Type(() => MessageSenderDto)
  @ApiProperty({ type: MessageSenderDto })
  sender!: MessageSenderDto;
}

/**
 * MB3/HB1: the last-message preview shown on each conversation row. Mirrors
 * the shape `/direct-messages/conversations` used to flatten onto the
 * conversation itself, kept as a nested object so an image-only last message
 * is representable (`content: null`, `attachmentUrl` set).
 */
export class ConversationLastMessageDto {
  @ApiProperty() id!: number;

  @ApiProperty({
    nullable: true,
    description: 'Text of the most recent message, or null if image-only.',
  })
  content!: string | null;

  @ApiProperty({
    nullable: true,
    description: 'Attachment URL of the most recent message, or null.',
  })
  attachmentUrl!: string | null;

  @ApiProperty({
    description:
      'Who sent it — compare against the caller to render a "You: " prefix.',
  })
  senderId!: number;

  @ApiProperty() createdAt!: Date;

  @ApiProperty({
    description:
      'Whether this message has been read. Only meaningful for messages the caller did not send.',
  })
  isRead!: boolean;
}

/** The other participant, from the caller's point of view. */
export class ConversationContactDto {
  @ApiProperty() id!: number;
  @ApiProperty() firstname!: string;
  @ApiProperty() lastname!: string;
  @ApiPropertyOptional({ nullable: true }) profilePicture!: string | null;
  @ApiProperty({
    enum: ['CUSTOMER', 'ARTISAN'],
    description:
      'The contact\'s role. Always the opposite of the caller\'s, since a ' +
      'conversation is always exactly one customer and one artisan.',
  })
  role!: string;
}

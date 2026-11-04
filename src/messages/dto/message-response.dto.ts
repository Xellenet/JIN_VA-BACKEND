import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Expose, Type } from 'class-transformer';

export class MessageSenderDto {
  @Expose() @ApiProperty() id!: number;
  @Expose() @ApiProperty() firstname!: string;
  @Expose() @ApiProperty() lastname!: string;
  @Expose() @ApiProperty({ nullable: true }) profilePicture?: string;
}

/**
 * The message a reply quotes. Built by `MessagesService` from one batched
 * lookup per page, never from the original's full body.
 *
 * When the original has been deleted, `deleted` is true and every other field
 * is null: the reply survives (the FK is ON DELETE SET NULL) but there is
 * nothing left to quote.
 */
export class MessageReplyToDto {
  @Expose()
  @ApiProperty({ nullable: true, example: 5120 })
  id!: number | null;

  @Expose()
  @ApiProperty({ nullable: true, example: 26 })
  senderId!: number | null;

  @Expose()
  @ApiProperty({
    nullable: true,
    example: 'Yaw Osei',
    description:
      '"Deleted User" when the original sender has deleted their account.',
  })
  senderName!: string | null;

  @Expose()
  @ApiProperty({
    nullable: true,
    example: 'Can you come on Thursday morning?',
    description:
      'First 120 characters of the original text (with an ellipsis when cut), ' +
      'or "Photo"/"Attachment" when the original has no text.',
  })
  preview!: string | null;

  @Expose()
  @ApiProperty({ description: 'True when the original has been deleted.' })
  deleted!: boolean;
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

  /**
   * C1: `null` for a message sent by someone who has since deleted their
   * account — the `sender` relation is filtered out by the soft-delete filter.
   * It is never null for the caller's own messages, so a null sender always
   * means "the other party, who has left": render it with the same
   * "Deleted User" placeholder the conversation's `contact` carries.
   */
  @Expose()
  @Type(() => MessageSenderDto)
  @ApiProperty({
    type: MessageSenderDto,
    nullable: true,
    description:
      'C1: null when the sender has deleted their account. Never null for ' +
      "the caller's own messages.",
  })
  sender!: MessageSenderDto | null;

  /** The message this one replies to, or null when it is not a reply. */
  @Expose()
  @Type(() => MessageReplyToDto)
  @ApiProperty({ type: MessageReplyToDto, nullable: true })
  replyTo!: MessageReplyToDto | null;
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

  @ApiProperty({ type: MessageReplyToDto, nullable: true })
  replyTo!: MessageReplyToDto | null;
}

/**
 * The other participant, from the caller's point of view.
 *
 * C1: the contact may have deleted their account while the thread stays live
 * for the caller. In that case `id` and `role` are **absent** (there is no live
 * user to link to or badge) and the names carry the `"Deleted" / "User"`
 * placeholder — the same one the purge writes onto the row itself, so the
 * thread reads identically during the 30-day window and after the purge.
 * Rendering `firstname`/`lastname` is always safe; branch on `id` being absent
 * if you need to disable the "view profile" affordance.
 */
export class ConversationContactDto {
  @ApiPropertyOptional({
    description: 'C1: absent when the contact has deleted their account.',
  })
  id?: number;

  @ApiProperty({
    description: 'C1: `"Deleted"` for a departed contact. Never null.',
  })
  firstname!: string;

  @ApiProperty({
    description: 'C1: `"User"` for a departed contact. Never null.',
  })
  lastname!: string;

  @ApiPropertyOptional({ nullable: true }) profilePicture!: string | null;

  @ApiPropertyOptional({
    enum: ['CUSTOMER', 'ARTISAN'],
    description:
      "The contact's role. Always the opposite of the caller's, since a " +
      'conversation is always exactly one customer and one artisan. C1: ' +
      'absent when the contact has deleted their account.',
  })
  role?: string;

  @ApiPropertyOptional({
    nullable: true,
    example: 14,
    description:
      "The contact's artisan profile id, for linking to " +
      '/dashboard/user/artisan/<id>. Null for a customer (customers have no ' +
      'public profile) and for a departed contact.',
  })
  artisanProfileId?: number | null;
}

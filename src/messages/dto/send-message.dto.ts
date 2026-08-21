import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsInt,
  IsOptional,
  IsPositive,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { IsAttachmentUrl } from '@common/validators/is-attachment-url.decorator';

export class SendMessageDto {
  @ApiProperty({ description: 'The user ID of the recipient', example: 5 })
  @IsInt()
  @IsPositive()
  recipientId!: number;

  /**
   * MC3/MC4: the 1–2000 character bound is carried over unchanged from both
   * pre-consolidation backends. What changed is optionality, not length — a
   * message may now omit text entirely *provided* it carries `attachmentUrl`.
   * `MessagesService.send` rejects a message with neither.
   */
  @ApiPropertyOptional({
    example: 'Hey, are you available this week?',
    minLength: 1,
    maxLength: 2000,
    description:
      'Message text, 1–2000 characters. Optional only when `attachmentUrl` is ' +
      'supplied — a message must carry text, an image, or both.',
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  content?: string;

  @ApiPropertyOptional({
    example: '/uploads/messages/uuid.jpg',
    description:
      'MC4: URL of one image, pre-uploaded via POST /uploads/message-attachment ' +
      '(JPEG/PNG, max 5MB). One image per message — to send several images, ' +
      'send several messages.',
  })
  @IsOptional()
  @IsString()
  @IsAttachmentUrl()
  attachmentUrl?: string;

  @ApiPropertyOptional({
    example: 2481,
    description:
      'MC2: the job this message is about, when composing from a job detail page. ' +
      'Metadata only — it does not scope or archive the thread. Must be a job the ' +
      'sender is a participant of. Mutually exclusive with `bookingId`.',
  })
  @IsOptional()
  @IsInt()
  @IsPositive()
  jobId?: number;

  @ApiPropertyOptional({
    example: 117,
    description:
      'MC2: the booking this message is about, when composing from a booking ' +
      'detail page. Must be a booking the sender is a participant of. ' +
      'Mutually exclusive with `jobId`.',
  })
  @IsOptional()
  @IsInt()
  @IsPositive()
  bookingId?: number;
}

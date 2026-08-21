import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { MessageSendThrottlerGuard } from './guards/message-send-throttler.guard';
import { MessagesService } from './messages.service';
import { SendMessageDto } from './dto/send-message.dto';
import { GetMessagesQueryDto } from './dto/get-messages-query.dto';
import { MessageResponseDto } from './dto/message-response.dto';
import { ConversationResponseDto } from './dto/conversation-response.dto';
import type { AuthenticatedRequest } from '@common/types/authenticated-request.type';

/**
 * MB1: the single canonical direct-messaging backend for the platform.
 *
 * Every conversation must involve exactly one customer and one artisan (MB2),
 * the conversation list is server-paginated (MB3), and every send emits
 * `MESSAGE_RECEIVED` so the recipient is actually notified. A conversation is
 * created automatically on the first message between two users and persists —
 * there is no thread-per-job model and nothing is archived.
 *
 * The former `/direct-messages` module has been retired in favour of this one;
 * see `docs/team/messaging-notifications/api-contract.md` for the response-shape
 * differences the frontend needs to account for.
 */
@ApiTags('Messages')
@Controller('messages')
@UseGuards(JwtAuthGuard)
@ApiBearerAuth()
export class MessagesController {
  constructor(private readonly messagesService: MessagesService) {}

  /**
   * Send a message to another user.
   * Creates a new conversation if this is the first message between the two users;
   * otherwise appends to the existing conversation thread.
   *
   * RL1: rate-limited per authenticated sender. Attaching
   * `MessageSendThrottlerGuard` is all that's needed — the guard applies the
   * single named `message-send` throttler configured in `MessagesModule`, so
   * there is no per-route `@Throttle()` override here (an empty one would
   * imply configuration that isn't happening). The limit is tunable via
   * `MESSAGE_RATE_LIMIT_PER_MINUTE`; exceeding it returns a specific 429 body,
   * never a bare "Too many requests".
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(MessageSendThrottlerGuard)
  @ApiOperation({
    summary: 'Send a message to a user',
    description:
      'Sends a message to the specified recipient. ' +
      'One participant must be a CUSTOMER and the other an ARTISAN — messages between two customers or two artisans are rejected. ' +
      'A conversation is created automatically on first contact; subsequent messages between the same two users append to the existing thread. ' +
      'A message must carry text (1–2000 chars), one image (`attachmentUrl`), or both. ' +
      'Optionally reference the job or booking it is about via `jobId`/`bookingId`. ' +
      'Rate-limited per sender.',
  })
  @ApiCreatedResponse({
    description: 'Message sent successfully',
    type: MessageResponseDto,
  })
  @ApiBadRequestResponse({
    description:
      'Cannot message yourself; same-role recipient; neither text nor image supplied; ' +
      'both jobId and bookingId supplied; or validation failed',
  })
  @ApiForbiddenResponse({
    description:
      'The referenced jobId/bookingId belongs to a job/booking the sender is not a participant of',
  })
  @ApiNotFoundResponse({
    description: 'Recipient user, or referenced job/booking, not found',
  })
  @ApiTooManyRequestsResponse({
    description:
      'RL1: send rate limit exceeded. Body carries `error: "MESSAGE_RATE_LIMIT_EXCEEDED"`, ' +
      'a human-readable `message`, and `retryAfterSeconds`.',
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT token' })
  send(@Req() req: AuthenticatedRequest, @Body() dto: SendMessageDto) {
    return this.messagesService.send(req.user.id, dto);
  }

  /**
   * List all conversations for the authenticated user, ordered by most recent activity.
   */
  @Get()
  @ApiOperation({
    summary: 'List all conversations (paginated)',
    description:
      'Returns a paginated list of all conversations the authenticated user is a part of, ' +
      'sorted by the most recently active conversation first. ' +
      'Each row carries the resolved `contact` (the other participant, with their role), ' +
      'a `lastMessage` preview, and an `unreadCount` — no client-side grouping needed.',
  })
  @ApiOkResponse({
    description: 'Conversations retrieved successfully',
    type: [ConversationResponseDto],
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT token' })
  getConversations(
    @Req() req: AuthenticatedRequest,
    @Query() query: GetMessagesQueryDto,
  ) {
    return this.messagesService.getConversations(req.user.id, query);
  }

  /**
   * Get the paginated message thread for a conversation (oldest-first).
   * Caller must be a participant in the conversation.
   */
  @Get(':id')
  @ApiOperation({
    summary: 'Get messages in a conversation (paginated, oldest-first)',
    description:
      'Returns the full message history for a conversation in chronological order. ' +
      'The caller must be one of the two participants.',
  })
  @ApiOkResponse({
    description: 'Messages retrieved successfully',
    type: [MessageResponseDto],
  })
  @ApiNotFoundResponse({ description: 'Conversation not found' })
  @ApiForbiddenResponse({
    description: 'Caller is not a participant in this conversation',
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT token' })
  getMessages(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseIntPipe) id: number,
    @Query() query: GetMessagesQueryDto,
  ) {
    return this.messagesService.getMessages(req.user.id, id, query);
  }

  /**
   * Mark all messages received from the other participant as read.
   * Only affects messages sent by the OTHER participant (not the caller's own messages).
   */
  @Patch(':id/read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Mark received messages in a conversation as read',
    description:
      'Marks all unread messages sent by the other participant as read. ' +
      'Messages sent by the caller are not affected.',
  })
  @ApiOkResponse({ description: 'Messages marked as read' })
  @ApiNotFoundResponse({ description: 'Conversation not found' })
  @ApiForbiddenResponse({
    description: 'Caller is not a participant in this conversation',
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT token' })
  markRead(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.messagesService.markRead(req.user.id, id);
  }
}

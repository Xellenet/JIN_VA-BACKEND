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
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { MessagesService } from './messages.service';
import { SendMessageDto } from './dto/send-message.dto';
import { GetMessagesQueryDto } from './dto/get-messages-query.dto';
import { MessageResponseDto } from './dto/message-response.dto';
import { ConversationResponseDto } from './dto/conversation-response.dto';

/**
 * Direct messaging between customers and artisans.
 * Every conversation must involve exactly one customer and one artisan.
 * A conversation is automatically created on the first message between the two users.
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
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Send a message to a user',
    description:
      'Sends a message to the specified recipient. ' +
      'One participant must be a CUSTOMER and the other an ARTISAN — messages between two customers or two artisans are rejected. ' +
      'A conversation is created automatically on first contact; subsequent messages between the same two users append to the existing thread.',
  })
  @ApiCreatedResponse({ description: 'Message sent successfully', type: MessageResponseDto })
  @ApiBadRequestResponse({ description: 'Cannot message yourself, or validation failed' })
  @ApiNotFoundResponse({ description: 'Recipient user not found' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT token' })
  send(@Req() req: any, @Body() dto: SendMessageDto) {
    return this.messagesService.send(req.user.id, dto);
  }

  /**
   * List all conversations for the authenticated user, ordered by most recent activity.
   */
  @Get()
  @ApiOperation({
    summary: 'List all conversations',
    description:
      'Returns a paginated list of all conversations the authenticated user is a part of, ' +
      'sorted by the most recently active conversation first.',
  })
  @ApiOkResponse({ description: 'Conversations retrieved successfully', type: [ConversationResponseDto] })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT token' })
  getConversations(@Req() req: any, @Query() query: GetMessagesQueryDto) {
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
  @ApiOkResponse({ description: 'Messages retrieved successfully', type: [MessageResponseDto] })
  @ApiNotFoundResponse({ description: 'Conversation not found' })
  @ApiForbiddenResponse({ description: 'Caller is not a participant in this conversation' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT token' })
  getMessages(
    @Req() req: any,
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
  @ApiForbiddenResponse({ description: 'Caller is not a participant in this conversation' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid JWT token' })
  markRead(@Req() req: any, @Param('id', ParseIntPipe) id: number) {
    return this.messagesService.markRead(req.user.id, id);
  }
}

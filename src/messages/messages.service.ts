import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { plainToInstance } from 'class-transformer';
import { Repository } from 'typeorm';
import { Message } from './entities/message.entity';
import { Conversation } from './entities/conversation.entity';
import { SendMessageDto } from './dto/send-message.dto';
import { GetMessagesQueryDto } from './dto/get-messages-query.dto';
import { MessageResponseDto } from './dto/message-response.dto';
import { ConversationResponseDto } from './dto/conversation-response.dto';
import { User } from '@users/entities/user.entity';
import { Role } from '@common/types/enums';
import { SUCCESS_MESSAGES } from '@common/constants/success-messages.constants';
import { APP_EVENTS } from '@common/events/app.events';
import type { MessageReceivedPayload } from '@common/events/app.events';

type Pagination        = { total: number; page: number; limit: number; totalPages: number };
type MessageItem       = { message: string; data: MessageResponseDto };
type MessageList       = { message: string; data: MessageResponseDto[]; pagination: Pagination };
type ConversationList  = { message: string; data: ConversationResponseDto[]; pagination: Pagination };

@Injectable()
export class MessagesService {
  private readonly logger = new Logger(MessagesService.name);

  constructor(
    @InjectRepository(Message)
    private readonly messagesRepository: Repository<Message>,
    @InjectRepository(Conversation)
    private readonly conversationsRepository: Repository<Conversation>,
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * Sends a message to another user.
   * Creates a conversation between the two users if one does not already exist.
   * Participants are stored in a stable order (lower ID first) to enforce uniqueness.
   *
   * @param senderId - Authenticated user's ID (from JWT).
   * @param dto      - Recipient user ID and message content.
   */
  async send(senderId: number, dto: SendMessageDto): Promise<MessageItem> {
    const { recipientId, content } = dto;

    if (senderId === recipientId) {
      throw new BadRequestException('You cannot send a message to yourself.');
    }

    const [sender, recipient] = await Promise.all([
      this.usersRepository.findOne({ where: { id: senderId } }),
      this.usersRepository.findOne({ where: { id: recipientId } }),
    ]);

    if (!recipient) {
      throw new NotFoundException(`User with id ${recipientId} not found.`);
    }

    const roles = new Set([sender!.role, recipient.role]);
    if (!roles.has(Role.CUSTOMER) || !roles.has(Role.ARTISAN)) {
      throw new BadRequestException(
        'Messages can only be exchanged between a customer and an artisan.',
      );
    }

    // Stable ordering: lower ID is always participantA — enforces uniqueness on the pair
    const [aId, bId] = senderId < recipientId
      ? [senderId, recipientId]
      : [recipientId, senderId];

    let conversation = await this.conversationsRepository.findOne({
      where: { participantA: { id: aId }, participantB: { id: bId } },
    });

    if (!conversation) {
      conversation = await this.conversationsRepository.save(
        this.conversationsRepository.create({
          participantA: { id: aId },
          participantB: { id: bId },
          lastMessageAt: new Date(),
        }),
      );
    } else {
      await this.conversationsRepository.update(conversation.id, { lastMessageAt: new Date() });
    }

    const saved = await this.messagesRepository.save(
      this.messagesRepository.create({
        conversation: { id: conversation.id },
        sender: { id: senderId },
        content,
      }),
    );

    this.eventEmitter.emit(APP_EVENTS.MESSAGE_RECEIVED, {
      recipientId,
      senderName:     `${sender!.firstname} ${sender!.lastname}`,
      preview:        content.length > 100 ? `${content.substring(0, 100)}…` : content,
      conversationId: conversation.id,
    } as MessageReceivedPayload);

    this.logger.log(`Message ${saved.id} sent by user ${senderId} to user ${recipientId}`);

    const populated = await this.messagesRepository.findOne({
      where: { id: saved.id },
      relations: ['sender'],
    });

    return {
      message: SUCCESS_MESSAGES.MESSAGE.SENT,
      data:    plainToInstance(MessageResponseDto, populated, { excludeExtraneousValues: true }),
    };
  }

  /**
   * Returns all conversations for the authenticated user, newest activity first.
   *
   * @param userId - Authenticated user's ID.
   * @param query  - Pagination options.
   */
  async getConversations(userId: number, query: GetMessagesQueryDto): Promise<ConversationList> {
    const page  = query.page  ?? 1;
    const limit = query.limit ?? 20;

    const [conversations, total] = await this.conversationsRepository
      .createQueryBuilder('conv')
      .leftJoinAndSelect('conv.participantA', 'pA')
      .leftJoinAndSelect('conv.participantB', 'pB')
      .where('pA.id = :userId OR pB.id = :userId', { userId })
      .orderBy('conv.lastMessageAt', 'DESC', 'NULLS LAST')
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();

    return {
      message: SUCCESS_MESSAGES.MESSAGE.CONVERSATIONS_RETRIEVED,
      data:    plainToInstance(ConversationResponseDto, conversations, { excludeExtraneousValues: true }),
      pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  /**
   * Returns the paginated message thread for a conversation (oldest-first).
   * Caller must be a participant in the conversation.
   *
   * @param userId         - Authenticated user's ID.
   * @param conversationId - The conversation to retrieve.
   * @param query          - Pagination options.
   */
  async getMessages(userId: number, conversationId: number, query: GetMessagesQueryDto): Promise<MessageList> {
    const conversation = await this.loadConversationOrFail(conversationId);
    this.assertParticipant(conversation, userId);

    const page  = query.page  ?? 1;
    const limit = query.limit ?? 20;

    const [messages, total] = await this.messagesRepository.findAndCount({
      where:     { conversation: { id: conversationId } },
      relations: ['sender'],
      order:     { createdAt: 'ASC' },
      skip:      (page - 1) * limit,
      take:      limit,
    });

    return {
      message: SUCCESS_MESSAGES.MESSAGE.THREAD_RETRIEVED,
      data:    plainToInstance(MessageResponseDto, messages, { excludeExtraneousValues: true }),
      pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  /**
   * Marks all unread messages sent by the other participant as read.
   *
   * @param userId         - Authenticated user's ID.
   * @param conversationId - The conversation to mark as read.
   */
  async markRead(userId: number, conversationId: number): Promise<{ message: string }> {
    const conversation = await this.loadConversationOrFail(conversationId);
    this.assertParticipant(conversation, userId);

    await this.messagesRepository
      .createQueryBuilder()
      .update(Message)
      .set({ isRead: true })
      .where(
        'conversation_id = :conversationId AND sender_id != :userId AND is_read = false',
        { conversationId, userId },
      )
      .execute();

    return { message: SUCCESS_MESSAGES.MESSAGE.MARKED_READ };
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  private async loadConversationOrFail(conversationId: number): Promise<Conversation> {
    const conversation = await this.conversationsRepository.findOne({
      where:     { id: conversationId },
      relations: ['participantA', 'participantB'],
    });
    if (!conversation) throw new NotFoundException('Conversation not found.');
    return conversation;
  }

  private assertParticipant(conversation: Conversation, userId: number): void {
    const isParticipant =
      conversation.participantA.id === userId ||
      conversation.participantB.id === userId;
    if (!isParticipant) {
      throw new ForbiddenException('You are not a participant in this conversation.');
    }
  }
}

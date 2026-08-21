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
import { DisputeConversationResponseDto } from './dto/dispute-conversation-response.dto';
import { User } from '@users/entities/user.entity';
import { Job } from '@jobs/entities/job.entity';
import { Booking } from '../bookings/entities/booking.entity';
import { Role } from '@common/types/enums';
import { SUCCESS_MESSAGES } from '@common/constants/success-messages.constants';
import { APP_EVENTS } from '@common/events/app.events';
import type { MessageReceivedPayload } from '@common/events/app.events';

type Pagination = {
  total: number;
  page: number;
  limit: number;
  totalPages: number;
};
type MessageItem = { message: string; data: MessageResponseDto };
type MessageList = {
  message: string;
  data: MessageResponseDto[];
  pagination: Pagination;
};
type ConversationList = {
  message: string;
  data: ConversationResponseDto[];
  pagination: Pagination;
};

/** MC4: extension → display MIME, mirroring `ReviewsService.guessMimeFromUrl`. */
const ATTACHMENT_MIME_BY_EXT: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
};

/**
 * AD1: hard cap on how much of a thread the admin dispute view returns in one
 * call. An unbounded read of an arbitrarily long thread is both a DoS surface
 * and pointless for the UI, which renders a scrollable sheet. The response
 * carries `totalMessages` so the client can say "showing the most recent N".
 */
const DISPUTE_CONVERSATION_MESSAGE_CAP = 200;

/** Raw shape of the per-conversation last-message lookup. */
type LastMessageRow = {
  conversationId: number;
  id: number;
  content: string | null;
  attachmentUrl: string | null;
  senderId: number;
  createdAt: Date;
  isRead: boolean;
};

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
    @InjectRepository(Job)
    private readonly jobsRepository: Repository<Job>,
    @InjectRepository(Booking)
    private readonly bookingsRepository: Repository<Booking>,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * Sends a message to another user.
   * Creates a conversation between the two users if one does not already exist.
   * Participants are stored in a stable order (lower ID first) to enforce uniqueness.
   *
   * MB1: this is the single canonical send path. It emits `MESSAGE_RECEIVED`,
   * which the notification and push listeners already subscribe to — the
   * retired `/direct-messages` module emitted nothing, which is why sending a
   * message used to notify no one.
   *
   * MB2: role-restricted to exactly one customer and one artisan.
   *
   * @param senderId - Authenticated user's ID (from JWT).
   * @param dto      - Recipient, optional text, optional image, optional job/booking context.
   */
  async send(senderId: number, dto: SendMessageDto): Promise<MessageItem> {
    const { recipientId, content, attachmentUrl } = dto;

    if (senderId === recipientId) {
      throw new BadRequestException('You cannot send a message to yourself.');
    }

    // MC4: a message must say something or show something.
    const text = content?.trim() ? content : null;
    if (!text && !attachmentUrl) {
      throw new BadRequestException(
        'A message must include text, an image, or both.',
      );
    }

    // MC2: the two context fields are alternatives, not a pair — a message is
    // about a job or about a booking, never both.
    if (dto.jobId && dto.bookingId) {
      throw new BadRequestException(
        'Provide either jobId or bookingId, not both.',
      );
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

    // MC2: validate the sender is actually party to the job/booking they claim
    // the message is about. Without this, any user could tag a message with an
    // arbitrary job id — misleading metadata that an admin might later read as
    // dispute evidence.
    if (dto.jobId) await this.assertJobParticipant(senderId, dto.jobId);
    if (dto.bookingId) {
      await this.assertBookingParticipant(senderId, dto.bookingId);
    }

    // Stable ordering: lower ID is always participantA — enforces uniqueness on the pair
    const [aId, bId] =
      senderId < recipientId
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
      await this.conversationsRepository.update(conversation.id, {
        lastMessageAt: new Date(),
      });
    }

    const saved = await this.messagesRepository.save(
      this.messagesRepository.create({
        conversation: { id: conversation.id },
        sender: { id: senderId },
        content: text,
        attachmentUrl: attachmentUrl ?? null,
        attachmentType: attachmentUrl
          ? this.guessMimeFromUrl(attachmentUrl)
          : null,
        jobId: dto.jobId ?? null,
        bookingId: dto.bookingId ?? null,
      }),
    );

    this.eventEmitter.emit(APP_EVENTS.MESSAGE_RECEIVED, {
      recipientId,
      senderName: `${sender!.firstname} ${sender!.lastname}`,
      preview: this.buildPreview(text, attachmentUrl),
      conversationId: conversation.id,
    } as MessageReceivedPayload);

    this.logger.log(
      `Message ${saved.id} sent by user ${senderId} to user ${recipientId}`,
    );

    const populated = await this.messagesRepository.findOne({
      where: { id: saved.id },
      relations: ['sender'],
    });

    return {
      message: SUCCESS_MESSAGES.MESSAGE.SENT,
      data: plainToInstance(MessageResponseDto, populated, {
        excludeExtraneousValues: true,
      }),
    };
  }

  /**
   * MB3: returns the caller's conversations, newest activity first,
   * server-paginated, each row carrying the resolved contact, a last-message
   * preview and an unread count.
   *
   * Deliberately three queries, not N+1: one page of conversations, then two
   * aggregates scoped to just that page's ids. The retired module loaded every
   * message the user had ever exchanged and grouped them in application code.
   *
   * @param userId - Authenticated user's ID.
   * @param query  - Pagination options.
   */
  async getConversations(
    userId: number,
    query: GetMessagesQueryDto,
  ): Promise<ConversationList> {
    const page = query.page ?? 1;
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

    const ids = conversations.map((c) => c.id);
    const [unreadByConversation, lastByConversation] = await Promise.all([
      this.loadUnreadCounts(ids, userId),
      this.loadLastMessages(ids),
    ]);

    const data = conversations.map((conv) => {
      const contact =
        conv.participantA?.id === userId ? conv.participantB : conv.participantA;
      const last = lastByConversation.get(conv.id) ?? null;

      return {
        id: conv.id,
        contact: {
          id: contact?.id,
          firstname: contact?.firstname,
          lastname: contact?.lastname,
          profilePicture: contact?.profilePicture ?? null,
          role: contact?.role,
        },
        lastMessage: last
          ? {
              id: last.id,
              content: last.content,
              attachmentUrl: last.attachmentUrl,
              senderId: last.senderId,
              createdAt: last.createdAt,
              isRead: last.isRead,
            }
          : null,
        unreadCount: unreadByConversation.get(conv.id) ?? 0,
        participantA: this.toParticipant(conv.participantA),
        participantB: this.toParticipant(conv.participantB),
        lastMessageAt: conv.lastMessageAt ?? null,
        createdAt: conv.createdAt,
      } as ConversationResponseDto;
    });

    return {
      message: SUCCESS_MESSAGES.MESSAGE.CONVERSATIONS_RETRIEVED,
      data,
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
  async getMessages(
    userId: number,
    conversationId: number,
    query: GetMessagesQueryDto,
  ): Promise<MessageList> {
    const conversation = await this.loadConversationOrFail(conversationId);
    this.assertParticipant(conversation, userId);

    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const [messages, total] = await this.messagesRepository.findAndCount({
      where: { conversation: { id: conversationId } },
      relations: ['sender'],
      order: { createdAt: 'ASC' },
      skip: (page - 1) * limit,
      take: limit,
    });

    return {
      message: SUCCESS_MESSAGES.MESSAGE.THREAD_RETRIEVED,
      data: plainToInstance(MessageResponseDto, messages, {
        excludeExtraneousValues: true,
      }),
      pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  /**
   * MR1: marks all unread messages sent by the other participant as read.
   * Unchanged by the consolidation — the caller's own messages are never
   * touched, and a concurrent second call is a harmless no-op (last write
   * wins), which is the documented accepted behaviour for two tabs/devices.
   *
   * @param userId         - Authenticated user's ID.
   * @param conversationId - The conversation to mark as read.
   */
  async markRead(
    userId: number,
    conversationId: number,
  ): Promise<{ message: string }> {
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

  // ─── AD1: dispute-scoped, read-only thread lookup ────────────────────────────

  /**
   * AD1: resolves the thread between two specific users, for the admin dispute
   * view. Returns `data: null` when they have never messaged — an expected
   * case, not an error.
   *
   * AD2 — deliberately **not** exposed on any controller. It is `internal` by
   * placement: the only caller is `DisputesService.getConversationForDispute`,
   * which derives both user ids from a dispute's booking and refuses unless
   * that dispute is still open. There is no route anywhere that accepts a pair
   * of user ids or a conversation id from an admin, so this cannot be turned
   * into a general "browse any conversation" capability without adding one.
   *
   * @param customerUserId - Customer side of the dispute's booking.
   * @param artisanUserId  - Artisan side of the dispute's booking.
   * @param context        - The dispute/booking that authorized this lookup.
   */
  async getConversationBetween(
    customerUserId: number,
    artisanUserId: number,
    context: { disputeId: number; bookingId: number },
  ): Promise<{
    message: string;
    data: DisputeConversationResponseDto | null;
  }> {
    const [aId, bId] =
      customerUserId < artisanUserId
        ? [customerUserId, artisanUserId]
        : [artisanUserId, customerUserId];

    const conversation = await this.conversationsRepository.findOne({
      where: { participantA: { id: aId }, participantB: { id: bId } },
      relations: ['participantA', 'participantB'],
    });

    if (!conversation) {
      return {
        message: 'No conversation on file for this dispute.',
        data: null,
      };
    }

    const total = await this.messagesRepository.count({
      where: { conversation: { id: conversation.id } },
    });

    // Take the most recent N, then flip to oldest-first so the admin reads the
    // thread in conversation order rather than backwards.
    const recent = await this.messagesRepository.find({
      where: { conversation: { id: conversation.id } },
      relations: ['sender'],
      order: { createdAt: 'DESC', id: 'DESC' },
      take: DISPUTE_CONVERSATION_MESSAGE_CAP,
    });
    const messages = recent.reverse();

    const customer =
      conversation.participantA.id === customerUserId
        ? conversation.participantA
        : conversation.participantB;
    const artisan =
      conversation.participantA.id === artisanUserId
        ? conversation.participantA
        : conversation.participantB;

    return {
      message: 'Dispute conversation retrieved.',
      data: {
        conversationId: conversation.id,
        disputeId: context.disputeId,
        bookingId: context.bookingId,
        customer: this.toLabelledParticipant(customer, Role.CUSTOMER),
        artisan: this.toLabelledParticipant(artisan, Role.ARTISAN),
        totalMessages: total,
        messages: plainToInstance(MessageResponseDto, messages, {
          excludeExtraneousValues: true,
        }),
        readOnly: true,
      },
    };
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  /** MC4: preview text for the notification/push body of an image-only message. */
  private buildPreview(text: string | null, attachmentUrl?: string): string {
    if (text) {
      return text.length > 100 ? `${text.substring(0, 100)}…` : text;
    }
    return attachmentUrl ? 'Sent a photo' : '';
  }

  /**
   * MC4: infers a display MIME type from an already-uploaded, already
   * MIME-sniffed attachment URL's extension. Not a security control — the real
   * content-type check happened at upload time in
   * `UploadsService.uploadMessageAttachment`. Metadata only, same precedent as
   * `ReviewsService.guessMimeFromUrl`.
   */
  private guessMimeFromUrl(url: string): string {
    const ext = url.slice(url.lastIndexOf('.')).toLowerCase();
    return ATTACHMENT_MIME_BY_EXT[ext] ?? 'image/jpeg';
  }

  /** MC2: the sender must be the job's customer or its accepted artisan. */
  private async assertJobParticipant(
    userId: number,
    jobId: number,
  ): Promise<void> {
    const job = await this.jobsRepository.findOne({
      where: { id: jobId },
      relations: ['customer', 'acceptedArtisan'],
    });
    if (!job) throw new NotFoundException(`Job with id ${jobId} not found.`);

    const isParticipant =
      job.customer?.id === userId || job.acceptedArtisan?.id === userId;
    if (!isParticipant) {
      throw new ForbiddenException(
        'You can only reference a job you are a participant of.',
      );
    }
  }

  /** MC2: the sender must be the booking's customer or its artisan. */
  private async assertBookingParticipant(
    userId: number,
    bookingId: number,
  ): Promise<void> {
    const booking = await this.bookingsRepository.findOne({
      where: { id: bookingId },
      relations: ['customer', 'artisanProfile', 'artisanProfile.user'],
    });
    if (!booking) {
      throw new NotFoundException(`Booking with id ${bookingId} not found.`);
    }

    const isParticipant =
      booking.customer?.id === userId ||
      booking.artisanProfile?.user?.id === userId;
    if (!isParticipant) {
      throw new ForbiddenException(
        'You can only reference a booking you are a participant of.',
      );
    }
  }

  /**
   * MB3: unread counts for one page of conversations, in a single query.
   * "Unread" means sent by the *other* participant and not yet marked read —
   * a user's own messages never count against them.
   */
  private async loadUnreadCounts(
    conversationIds: number[],
    userId: number,
  ): Promise<Map<number, number>> {
    if (conversationIds.length === 0) return new Map();

    const rows = (await this.messagesRepository.query(
      `SELECT m.conversation_id AS "conversationId",
              COUNT(*)          AS "count"
         FROM messages m
        WHERE m.conversation_id = ANY($1)
          AND m.sender_id <> $2
          AND m.is_read = false
        GROUP BY m.conversation_id`,
      [conversationIds, userId],
    )) as { conversationId: number; count: string }[];

    return new Map(rows.map((r) => [Number(r.conversationId), Number(r.count)]));
  }

  /**
   * MB3: the newest message per conversation for one page, in a single query.
   * `DISTINCT ON` is Postgres-specific, which is fine — this application is
   * Postgres-only (see `config/typeorm.config.ts`).
   */
  private async loadLastMessages(
    conversationIds: number[],
  ): Promise<Map<number, LastMessageRow>> {
    if (conversationIds.length === 0) return new Map();

    const rows = await this.messagesRepository.query(
      `SELECT DISTINCT ON (m.conversation_id)
              m.conversation_id AS "conversationId",
              m.id              AS "id",
              m.content         AS "content",
              m.attachment_url  AS "attachmentUrl",
              m.sender_id       AS "senderId",
              m.created_at      AS "createdAt",
              m.is_read         AS "isRead"
         FROM messages m
        WHERE m.conversation_id = ANY($1)
        ORDER BY m.conversation_id, m.created_at DESC, m.id DESC`,
      [conversationIds],
    );

    return new Map(
      (rows as LastMessageRow[]).map((r) => [Number(r.conversationId), r]),
    );
  }

  private toParticipant(user?: User) {
    return {
      id: user?.id,
      firstname: user?.firstname,
      lastname: user?.lastname,
      profilePicture: user?.profilePicture ?? null,
    } as ConversationResponseDto['participantA'];
  }

  /** AD1: labels a participant by role so the admin view can tag each bubble. */
  private toLabelledParticipant(user: User, fallbackRole: Role) {
    return {
      id: user.id,
      firstname: user.firstname,
      lastname: user.lastname,
      profilePicture: user.profilePicture ?? null,
      role: user.role ?? fallbackRole,
    };
  }

  private async loadConversationOrFail(
    conversationId: number,
  ): Promise<Conversation> {
    const conversation = await this.conversationsRepository.findOne({
      where: { id: conversationId },
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
      throw new ForbiddenException(
        'You are not a participant in this conversation.',
      );
    }
  }
}

import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { OnEvent } from '@nestjs/event-emitter';
import { plainToInstance } from 'class-transformer';
import { Repository } from 'typeorm';
import { Notification } from './entities/notification.entity';
import { GetNotificationsQueryDto } from './dto/get-notifications-query.dto';
import { NotificationResponseDto } from './dto/notification-response.dto';
import { NotificationType } from '@common/types/enums';
import { SUCCESS_MESSAGES } from '@common/constants/success-messages.constants';
import { APP_EVENTS } from '@common/events/app.events';
import type {
  JobApplicationAcceptedPayload,
  JobApplicationReceivedPayload,
  JobCancelledPayload,
  JobCompletedPayload,
  JobCompletionRequestedPayload,
  JobStartedPayload,
  MessageReceivedPayload,
  ReviewReceivedPayload,
} from '@common/events/app.events';

type Pagination        = { total: number; page: number; limit: number; totalPages: number };
type NotificationList  = { message: string; data: NotificationResponseDto[]; pagination: Pagination };

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    @InjectRepository(Notification)
    private readonly notificationsRepository: Repository<Notification>,
  ) {}

  // ─── Event listeners ────────────────────────────────────────────────────────

  @OnEvent(APP_EVENTS.JOB_APPLICATION_RECEIVED)
  async handleApplicationReceived(payload: JobApplicationReceivedPayload) {
    await this.persist(
      payload.customerId,
      NotificationType.JOB_APPLICATION_RECEIVED,
      'New Job Application',
      `${payload.artisanName} has applied to your job "${payload.jobTitle}".`,
      { jobId: payload.jobId },
    );
  }

  @OnEvent(APP_EVENTS.JOB_APPLICATION_ACCEPTED)
  async handleApplicationAccepted(payload: JobApplicationAcceptedPayload) {
    await this.persist(
      payload.artisanId,
      NotificationType.JOB_APPLICATION_ACCEPTED,
      'Application Accepted',
      `Your application for "${payload.jobTitle}" was accepted. Get ready to start work.`,
      { jobId: payload.jobId },
    );
  }

  @OnEvent(APP_EVENTS.JOB_STARTED)
  async handleJobStarted(payload: JobStartedPayload) {
    await this.persist(
      payload.customerId,
      NotificationType.JOB_STARTED,
      'Work Has Begun',
      `The artisan has started work on your job "${payload.jobTitle}".`,
      { jobId: payload.jobId },
    );
  }

  @OnEvent(APP_EVENTS.JOB_COMPLETION_REQUESTED)
  async handleCompletionRequested(payload: JobCompletionRequestedPayload) {
    await this.persist(
      payload.customerId,
      NotificationType.JOB_COMPLETION_REQUESTED,
      'Confirm Completion',
      `The artisan has marked "${payload.jobTitle}" as done. Confirm to release payment.`,
      { jobId: payload.jobId },
    );
  }

  @OnEvent(APP_EVENTS.JOB_COMPLETED)
  async handleJobCompleted(payload: JobCompletedPayload) {
    await this.persist(
      payload.artisanId,
      NotificationType.JOB_COMPLETED,
      'Job Confirmed Complete',
      `"${payload.jobTitle}" has been confirmed as complete. Your payment has been released.`,
      { jobId: payload.jobId },
    );
  }

  @OnEvent(APP_EVENTS.JOB_CANCELLED)
  async handleJobCancelled(payload: JobCancelledPayload) {
    await this.persist(
      payload.artisanId,
      NotificationType.JOB_CANCELLED,
      'Job Cancelled',
      `The job "${payload.jobTitle}" has been cancelled by the customer.`,
      { jobId: payload.jobId },
    );
  }

  @OnEvent(APP_EVENTS.MESSAGE_RECEIVED)
  async handleMessageReceived(payload: MessageReceivedPayload) {
    await this.persist(
      payload.recipientId,
      NotificationType.MESSAGE_RECEIVED,
      `New message from ${payload.senderName}`,
      `"${payload.preview}"`,
      { conversationId: payload.conversationId },
    );
  }

  @OnEvent(APP_EVENTS.REVIEW_RECEIVED)
  async handleReviewReceived(payload: ReviewReceivedPayload) {
    await this.persist(
      payload.artisanUserId,
      NotificationType.REVIEW_RECEIVED,
      'New Review Received',
      `${payload.reviewerName} gave you ${payload.rating}★ for "${payload.jobTitle}".`,
      { jobId: payload.jobId, rating: payload.rating },
    );
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  /**
   * Returns the authenticated user's paginated notification feed.
   * Optionally filtered to only read or unread notifications via `query.isRead`.
   */
  async findAll(userId: number, query: GetNotificationsQueryDto): Promise<NotificationList> {
    const page  = query.page  ?? 1;
    const limit = query.limit ?? 20;

    const qb = this.notificationsRepository
      .createQueryBuilder('notif')
      .where('notif.user = :userId', { userId })
      .orderBy('notif.createdAt', 'DESC');

    if (query.isRead !== undefined) {
      qb.andWhere('notif.isRead = :isRead', { isRead: query.isRead });
    }

    const [notifications, total] = await qb
      .skip((page - 1) * limit)
      .take(limit)
      .getManyAndCount();

    return {
      message: SUCCESS_MESSAGES.NOTIFICATION.ALL_RETRIEVED,
      data:    plainToInstance(NotificationResponseDto, notifications, { excludeExtraneousValues: true }),
      pagination: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  /**
   * Returns the count of unread notifications for the authenticated user.
   * Lightweight endpoint suitable for polling a notification badge.
   */
  async getUnreadCount(userId: number): Promise<{ count: number }> {
    const count = await this.notificationsRepository.count({
      where: { user: { id: userId }, isRead: false },
    });
    return { count };
  }

  /**
   * Marks a single notification as read. The notification must belong to the caller.
   *
   * @throws {NotFoundException} When the notification does not exist or belongs to another user.
   */
  async markRead(userId: number, notificationId: number): Promise<{ message: string }> {
    const notification = await this.notificationsRepository.findOne({
      where: { id: notificationId, user: { id: userId } },
    });

    if (!notification) {
      throw new NotFoundException('Notification not found.');
    }

    notification.isRead = true;
    await this.notificationsRepository.save(notification);

    return { message: SUCCESS_MESSAGES.NOTIFICATION.MARKED_READ };
  }

  /**
   * Marks all of the authenticated user's unread notifications as read.
   */
  async markAllRead(userId: number): Promise<{ message: string }> {
    await this.notificationsRepository
      .createQueryBuilder()
      .update(Notification)
      .set({ isRead: true })
      .where('user_id = :userId AND is_read = false', { userId })
      .execute();

    return { message: SUCCESS_MESSAGES.NOTIFICATION.ALL_MARKED_READ };
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  private async persist(
    userId: number,
    type: NotificationType,
    title: string,
    body: string,
    payload?: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.notificationsRepository.save(
        this.notificationsRepository.create({
          user: { id: userId },
          type,
          title,
          body,
          payload,
        }),
      );
    } catch (err) {
      this.logger.error(
        `Failed to persist ${type} notification for user ${userId}: ${(err as Error).message}`,
      );
    }
  }
}

import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { OnEvent } from '@nestjs/event-emitter';
import { plainToInstance } from 'class-transformer';
import { Repository } from 'typeorm';
import { Notification } from './entities/notification.entity';
import { NotificationPreferences } from './entities/notification-preferences.entity';
import { GetNotificationsQueryDto } from './dto/get-notifications-query.dto';
import { NotificationResponseDto } from './dto/notification-response.dto';
import { CustomerNotificationPreferencesResponseDto } from './dto/customer-notification-preferences-response.dto';
import { ArtisanNotificationPreferencesResponseDto } from './dto/artisan-notification-preferences-response.dto';
import { UpdateNotificationPreferencesDto } from './dto/update-notification-preferences.dto';
import { NotificationType, Role } from '@common/types/enums';
import { SUCCESS_MESSAGES } from '@common/constants/success-messages.constants';
import { APP_EVENTS } from '@common/events/app.events';
import type {
  JobApplicationAcceptedPayload,
  JobApplicationReceivedPayload,
  JobApplicationRejectedPayload,
  JobCancelledPayload,
  JobCompletedPayload,
  JobCompletionRequestedPayload,
  JobExpiredPayload,
  JobStartedPayload,
  MessageReceivedPayload,
  ReviewReceivedPayload,
  ArtisanProfileVerifiedPayload,
  SecurityAlertPayload,
} from '@common/events/app.events';

type Pagination       = { total: number; page: number; limit: number; totalPages: number };
type NotificationList = { message: string; data: NotificationResponseDto[]; pagination: Pagination };
type PrefsData        = CustomerNotificationPreferencesResponseDto | ArtisanNotificationPreferencesResponseDto;
type PrefsResponse    = { message: string; data: PrefsData };

// ─── Role-aware preference key maps ──────────────────────────────────────────
// Maps each NotificationType to the flag that gates it for that role.
// If a type has no entry for the recipient's role, it always goes through.

const CUSTOMER_PREF_KEY: Partial<Record<NotificationType, keyof NotificationPreferences>> = {
  [NotificationType.JOB_APPLICATION_RECEIVED]: 'bookingConfirmations',
  [NotificationType.JOB_STARTED]:              'jobStatusUpdates',
  [NotificationType.JOB_COMPLETION_REQUESTED]: 'jobStatusUpdates',
  [NotificationType.JOB_EXPIRED]:              'jobExpired',
  [NotificationType.MESSAGE_RECEIVED]:          'messageReceived',
};

const ARTISAN_PREF_KEY: Partial<Record<NotificationType, keyof NotificationPreferences>> = {
  [NotificationType.JOB_APPLICATION_ACCEPTED]:  'applicationUpdates',
  [NotificationType.JOB_APPLICATION_REJECTED]:  'applicationRejected',
  [NotificationType.JOB_CANCELLED]:             'artisanJobUpdates',
  [NotificationType.JOB_COMPLETED]:             'paymentReleased',
  [NotificationType.JOB_EXPIRED]:               'appliedJobExpired',
  [NotificationType.REVIEW_RECEIVED]:           'reviewsAndRatings',
  [NotificationType.ARTISAN_PROFILE_VERIFIED]:  'profileVerified',
  [NotificationType.MESSAGE_RECEIVED]:           'messageReceived',
};

// Fields each role is allowed to update — prevents artisans from setting customer flags
const CUSTOMER_UPDATABLE = new Set<keyof NotificationPreferences>([
  'bookingConfirmations', 'jobStatusUpdates', 'paymentReceipts',
  'promotionalOffers', 'serviceReminders', 'reviewRequests',
  'jobExpired', 'messageReceived', 'emailEnabled', 'smsEnabled', 'pushEnabled',
]);

const ARTISAN_UPDATABLE = new Set<keyof NotificationPreferences>([
  'newJobOpportunities', 'applicationUpdates', 'artisanJobUpdates',
  'paymentReleased', 'reviewsAndRatings', 'artisanPromotions',
  'applicationRejected', 'appliedJobExpired', 'profileVerified',
  'messageReceived', 'emailEnabled', 'smsEnabled', 'pushEnabled',
]);

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    @InjectRepository(Notification)
    private readonly notificationsRepository: Repository<Notification>,
    @InjectRepository(NotificationPreferences)
    private readonly prefsRepository: Repository<NotificationPreferences>,
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

  @OnEvent(APP_EVENTS.JOB_APPLICATION_REJECTED)
  async handleApplicationRejected(payload: JobApplicationRejectedPayload) {
    await this.persist(
      payload.artisanId,
      NotificationType.JOB_APPLICATION_REJECTED,
      'Application Not Selected',
      `Your application for "${payload.jobTitle}" was not selected. Keep applying!`,
      { jobId: payload.jobId },
    );
  }

  @OnEvent(APP_EVENTS.JOB_EXPIRED)
  async handleJobExpired(payload: JobExpiredPayload) {
    // Notify the customer whose posting expired
    await this.persist(
      payload.customerId,
      NotificationType.JOB_EXPIRED,
      'Job Posting Expired',
      `Your job posting "${payload.jobTitle}" has expired without being filled.`,
      { jobId: payload.jobId },
    );
    // Notify each artisan who had a pending application on this job
    for (const artisanId of payload.pendingArtisanIds) {
      await this.persist(
        artisanId,
        NotificationType.JOB_EXPIRED,
        'Job No Longer Available',
        `The job "${payload.jobTitle}" has expired. Your application has been closed.`,
        { jobId: payload.jobId },
      );
    }
  }

  @OnEvent(APP_EVENTS.ARTISAN_PROFILE_VERIFIED)
  async handleProfileVerified(payload: ArtisanProfileVerifiedPayload) {
    await this.persist(
      payload.artisanUserId,
      NotificationType.ARTISAN_PROFILE_VERIFIED,
      'Profile Verified',
      'Your artisan profile has been verified. You now have full access to the platform.',
    );
  }

  @OnEvent(APP_EVENTS.SECURITY_ALERT)
  async handleSecurityAlert(payload: SecurityAlertPayload) {
    // Security alerts bypass preferences — always persisted regardless of user settings
    try {
      const titles: Record<SecurityAlertPayload['event'], string> = {
        PASSWORD_CHANGED: 'Password Changed',
        PASSWORD_RESET:   'Password Reset',
      };
      const bodies: Record<SecurityAlertPayload['event'], string> = {
        PASSWORD_CHANGED: 'Your account password was changed. If this wasn\'t you, contact support immediately.',
        PASSWORD_RESET:   'Your account password was reset. If this wasn\'t you, contact support immediately.',
      };
      await this.notificationsRepository.save(
        this.notificationsRepository.create({
          user:    { id: payload.userId },
          type:    NotificationType.SECURITY_ALERT,
          title:   titles[payload.event],
          body:    bodies[payload.event],
          payload: { event: payload.event },
        }),
      );
    } catch (err) {
      this.logger.error(
        `Failed to persist SECURITY_ALERT for user ${payload.userId}: ${(err as Error).message}`,
      );
    }
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

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

  async getUnreadCount(userId: number): Promise<{ count: number }> {
    const count = await this.notificationsRepository.count({
      where: { user: { id: userId }, isRead: false },
    });
    return { count };
  }

  async markRead(userId: number, notificationId: number): Promise<{ message: string }> {
    const notification = await this.notificationsRepository.findOne({
      where: { id: notificationId, user: { id: userId } },
    });
    if (!notification) throw new NotFoundException('Notification not found.');
    notification.isRead = true;
    await this.notificationsRepository.save(notification);
    return { message: SUCCESS_MESSAGES.NOTIFICATION.MARKED_READ };
  }

  async markAllRead(userId: number): Promise<{ message: string }> {
    await this.notificationsRepository
      .createQueryBuilder()
      .update(Notification)
      .set({ isRead: true })
      .where('user_id = :userId AND is_read = false', { userId })
      .execute();
    return { message: SUCCESS_MESSAGES.NOTIFICATION.ALL_MARKED_READ };
  }

  // ─── Notification preferences ────────────────────────────────────────────────

  /**
   * Returns the authenticated user's notification preferences.
   * Creates a default record on first access. The shape differs by role —
   * artisans see artisan-specific toggles; customers see customer-specific ones.
   * Both roles see the notification channel toggles (email, SMS, push).
   */
  async getPreferences(userId: number): Promise<PrefsResponse> {
    const prefs = await this.findOrCreatePrefs(userId);
    return {
      message: SUCCESS_MESSAGES.NOTIFICATION_PREFERENCES.RETRIEVED,
      data:    this.toPrefsDto(prefs),
    };
  }

  /**
   * Partially updates the authenticated user's notification preferences.
   * Only role-relevant fields are applied — a customer cannot accidentally
   * set artisan-only flags and vice versa.
   */
  async updatePreferences(userId: number, dto: UpdateNotificationPreferencesDto): Promise<PrefsResponse> {
    const prefs       = await this.findOrCreatePrefs(userId);
    const allowedKeys = prefs.user.role === Role.ARTISAN ? ARTISAN_UPDATABLE : CUSTOMER_UPDATABLE;

    for (const [key, value] of Object.entries(dto)) {
      if (allowedKeys.has(key as keyof NotificationPreferences) && value !== undefined) {
        (prefs as any)[key] = value;
      }
    }

    await this.prefsRepository.save(prefs);
    return {
      message: SUCCESS_MESSAGES.NOTIFICATION_PREFERENCES.UPDATED,
      data:    this.toPrefsDto(prefs),
    };
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  private toPrefsDto(prefs: NotificationPreferences): PrefsData {
    if (prefs.user.role === Role.ARTISAN) {
      return plainToInstance(ArtisanNotificationPreferencesResponseDto, prefs, { excludeExtraneousValues: true });
    }
    return plainToInstance(CustomerNotificationPreferencesResponseDto, prefs, { excludeExtraneousValues: true });
  }

  private async findOrCreatePrefs(userId: number): Promise<NotificationPreferences> {
    let prefs = await this.prefsRepository.findOne({
      where:     { user: { id: userId } },
      relations: ['user'],
    });
    if (!prefs) {
      await this.prefsRepository.save(this.prefsRepository.create({ user: { id: userId } }));
      prefs = await this.prefsRepository.findOne({
        where:     { user: { id: userId } },
        relations: ['user'],
      });
    }
    return prefs!;
  }

  private async persist(
    userId: number,
    type: NotificationType,
    title: string,
    body: string,
    payload?: Record<string, unknown>,
  ): Promise<void> {
    try {
      const prefs = await this.prefsRepository.findOne({
        where:     { user: { id: userId } },
        relations: ['user'],
      });

      if (prefs) {
        const prefMap = prefs.user.role === Role.ARTISAN ? ARTISAN_PREF_KEY : CUSTOMER_PREF_KEY;
        const prefKey = prefMap[type];
        // Skip if the user has explicitly disabled this notification type
        if (prefKey && prefs[prefKey] === false) return;
        // Skip in-app delivery if the user has disabled all channels
        // (email/SMS/push channel checks happen in their respective send services)
        if (!prefs.pushEnabled && !prefs.emailEnabled && !prefs.smsEnabled) return;
      }

      await this.notificationsRepository.save(
        this.notificationsRepository.create({ user: { id: userId }, type, title, body, payload }),
      );
    } catch (err) {
      this.logger.error(
        `Failed to persist ${type} notification for user ${userId}: ${(err as Error).message}`,
      );
    }
  }
}

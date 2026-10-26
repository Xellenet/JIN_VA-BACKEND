import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { MailService } from '../mail.service';
import { APP_EVENTS } from '@common/events/app.events';
import { getErrorMessage } from '@common/utils/error.util';
import { NotificationType } from '@common/types/enums';
import { preferenceKeyFor } from '../../notifications/notifications.service';
import { User } from '../../users/entities/user.entity';
import { NotificationPreferences } from '../../notifications/entities/notification-preferences.entity';
import type {
  ArtisanProfileVerifiedPayload,
  ArtisanVerificationRejectedPayload,
  BookingReceivedPayload,
  BookingConfirmedPayload,
  BookingDeclinedPayload,
  BookingCancelledPayload,
  BookingCompletedPayload,
  BookingExpiredPayload,
  BookingNoShowPayload,
  BookingReminderPayload,
} from '@common/events/app.events';

@Injectable()
export class DomainMailListener {
  private readonly logger = new Logger(DomainMailListener.name);

  constructor(
    private readonly mailService: MailService,
    private readonly config: ConfigService,
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
    @InjectRepository(NotificationPreferences)
    private readonly prefsRepository: Repository<NotificationPreferences>,
  ) {}

  private async findUser(
    userId: number,
  ): Promise<{ email: string; firstname: string } | null> {
    return this.usersRepository.findOne({
      where: { id: userId },
      select: ['email', 'firstname'],
    });
  }

  /**
   * A7 / QA NOT-09: whether this person wants this email. The same rules as
   * in-app notifications (`preferenceKeyFor`): all email off, or the type's
   * own toggle off, means no email. Reminders used to be the only emails that
   * checked; booking and verification emails went out regardless.
   */
  private async isEmailWanted(
    userId: number,
    type: NotificationType,
  ): Promise<boolean> {
    const prefs = await this.prefsRepository.findOne({
      where: { user: { id: userId } },
      relations: ['user'],
    });
    if (!prefs) return true; // no record yet → defaults apply (enabled)
    if (!prefs.emailEnabled) return false;
    const key = prefs.user
      ? preferenceKeyFor(prefs.user.role, type)
      : undefined;
    return !key || prefs[key] !== false;
  }

  private get appName(): string {
    return this.config.get<string>('APP_NAME', 'JinVa');
  }

  private get year(): number {
    return new Date().getFullYear();
  }

  private get supportEmail(): string {
    return this.config.get<string>('SUPPORT_EMAIL', '');
  }

  private get dashboardUrl(): string {
    return `${this.config.get<string>('FRONTEND_URL', '')}/dashboard`;
  }

  @OnEvent(APP_EVENTS.ARTISAN_PROFILE_VERIFIED, { async: true })
  async handleArtisanVerified(
    payload: ArtisanProfileVerifiedPayload,
  ): Promise<void> {
    try {
      if (
        !(await this.isEmailWanted(
          payload.artisanUserId,
          NotificationType.ARTISAN_PROFILE_VERIFIED,
        ))
      )
        return;
      const user = await this.findUser(payload.artisanUserId);
      if (!user) return;
      await this.mailService.sendMail(
        user.email,
        APP_EVENTS.ARTISAN_PROFILE_VERIFIED,
        {
          firstname: user.firstname,
          dashboardUrl: this.dashboardUrl,
          appName: this.appName,
          year: this.year,
          supportEmail: this.supportEmail,
        },
      );
    } catch (err) {
      this.logger.error(
        `Failed to send artisan verified email: ${getErrorMessage(err)}`,
      );
    }
  }

  @OnEvent(APP_EVENTS.ARTISAN_VERIFICATION_REJECTED, { async: true })
  async handleVerificationRejected(
    payload: ArtisanVerificationRejectedPayload,
  ): Promise<void> {
    try {
      if (
        !(await this.isEmailWanted(
          payload.artisanUserId,
          NotificationType.ARTISAN_VERIFICATION_REJECTED,
        ))
      )
        return;
      const user = await this.findUser(payload.artisanUserId);
      if (!user) return;
      await this.mailService.sendMail(
        user.email,
        APP_EVENTS.ARTISAN_VERIFICATION_REJECTED,
        {
          firstname: user.firstname,
          reason: payload.reason,
          appName: this.appName,
          year: this.year,
          supportEmail: this.supportEmail,
        },
      );
    } catch (err) {
      this.logger.error(
        `Failed to send verification rejected email: ${getErrorMessage(err)}`,
      );
    }
  }

  @OnEvent(APP_EVENTS.BOOKING_RECEIVED, { async: true })
  async handleBookingReceived(payload: BookingReceivedPayload): Promise<void> {
    try {
      if (
        !(await this.isEmailWanted(
          payload.artisanUserId,
          NotificationType.BOOKING_RECEIVED,
        ))
      )
        return;
      const user = await this.findUser(payload.artisanUserId);
      if (!user) return;
      await this.mailService.sendMail(user.email, APP_EVENTS.BOOKING_RECEIVED, {
        firstname: user.firstname,
        customerName: payload.customerName,
        scheduledDate: payload.scheduledDate,
        bookingId: payload.bookingId,
        dashboardUrl: this.dashboardUrl,
        appName: this.appName,
        year: this.year,
      });
    } catch (err) {
      this.logger.error(
        `Failed to send booking received email: ${getErrorMessage(err)}`,
      );
    }
  }

  @OnEvent(APP_EVENTS.BOOKING_CONFIRMED, { async: true })
  async handleBookingConfirmed(
    payload: BookingConfirmedPayload,
  ): Promise<void> {
    try {
      if (
        !(await this.isEmailWanted(
          payload.customerId,
          NotificationType.BOOKING_CONFIRMED,
        ))
      )
        return;
      const user = await this.findUser(payload.customerId);
      if (!user) return;
      await this.mailService.sendMail(
        user.email,
        APP_EVENTS.BOOKING_CONFIRMED,
        {
          firstname: user.firstname,
          artisanName: payload.artisanName,
          scheduledDate: payload.scheduledDate,
          bookingId: payload.bookingId,
          dashboardUrl: this.dashboardUrl,
          appName: this.appName,
          year: this.year,
          supportEmail: this.supportEmail,
        },
      );
    } catch (err) {
      this.logger.error(
        `Failed to send booking confirmed email: ${getErrorMessage(err)}`,
      );
    }
  }

  @OnEvent(APP_EVENTS.BOOKING_DECLINED, { async: true })
  async handleBookingDeclined(payload: BookingDeclinedPayload): Promise<void> {
    try {
      if (
        !(await this.isEmailWanted(
          payload.customerId,
          NotificationType.BOOKING_DECLINED,
        ))
      )
        return;
      const user = await this.findUser(payload.customerId);
      if (!user) return;
      await this.mailService.sendMail(user.email, APP_EVENTS.BOOKING_DECLINED, {
        firstname: user.firstname,
        artisanName: payload.artisanName,
        scheduledDate: payload.scheduledDate,
        bookingId: payload.bookingId,
        dashboardUrl: this.dashboardUrl,
        appName: this.appName,
        year: this.year,
        supportEmail: this.supportEmail,
      });
    } catch (err) {
      this.logger.error(
        `Failed to send booking declined email: ${getErrorMessage(err)}`,
      );
    }
  }

  @OnEvent(APP_EVENTS.BOOKING_CANCELLED, { async: true })
  async handleBookingCancelled(
    payload: BookingCancelledPayload,
  ): Promise<void> {
    try {
      if (
        !(await this.isEmailWanted(
          payload.artisanUserId,
          NotificationType.BOOKING_CANCELLED,
        ))
      )
        return;
      const user = await this.findUser(payload.artisanUserId);
      if (!user) return;
      await this.mailService.sendMail(
        user.email,
        APP_EVENTS.BOOKING_CANCELLED,
        {
          firstname: user.firstname,
          customerName: payload.customerName,
          scheduledDate: payload.scheduledDate,
          bookingId: payload.bookingId,
          appName: this.appName,
          year: this.year,
          supportEmail: this.supportEmail,
        },
      );
    } catch (err) {
      this.logger.error(
        `Failed to send booking cancelled email: ${getErrorMessage(err)}`,
      );
    }
  }

  @OnEvent(APP_EVENTS.BOOKING_COMPLETED, { async: true })
  async handleBookingCompleted(
    payload: BookingCompletedPayload,
  ): Promise<void> {
    try {
      if (
        !(await this.isEmailWanted(
          payload.artisanUserId,
          NotificationType.BOOKING_COMPLETED,
        ))
      )
        return;
      const user = await this.findUser(payload.artisanUserId);
      if (!user) return;
      await this.mailService.sendMail(
        user.email,
        APP_EVENTS.BOOKING_COMPLETED,
        {
          firstname: user.firstname,
          scheduledDate: payload.scheduledDate,
          bookingId: payload.bookingId,
          appName: this.appName,
          year: this.year,
          supportEmail: this.supportEmail,
        },
      );
    } catch (err) {
      this.logger.error(
        `Failed to send booking completed email: ${getErrorMessage(err)}`,
      );
    }
  }

  @OnEvent(APP_EVENTS.BOOKING_EXPIRED, { async: true })
  async handleBookingExpired(payload: BookingExpiredPayload): Promise<void> {
    try {
      if (
        !(await this.isEmailWanted(
          payload.customerId,
          NotificationType.BOOKING_EXPIRED,
        ))
      )
        return;
      const user = await this.findUser(payload.customerId);
      if (!user) return;
      await this.mailService.sendMail(user.email, APP_EVENTS.BOOKING_EXPIRED, {
        firstname: user.firstname,
        scheduledDate: payload.scheduledDate,
        bookingId: payload.bookingId,
        appName: this.appName,
        year: this.year,
        supportEmail: this.supportEmail,
      });
    } catch (err) {
      this.logger.error(
        `Failed to send booking expired email: ${(err as Error).message}`,
      );
    }
  }

  @OnEvent(APP_EVENTS.BOOKING_NO_SHOW, { async: true })
  async handleBookingNoShow(payload: BookingNoShowPayload): Promise<void> {
    try {
      if (
        !(await this.isEmailWanted(
          payload.recipientUserId,
          NotificationType.BOOKING_NO_SHOW,
        ))
      )
        return;
      const user = await this.findUser(payload.recipientUserId);
      if (!user) return;
      await this.mailService.sendMail(user.email, APP_EVENTS.BOOKING_NO_SHOW, {
        firstname: user.firstname,
        flaggedByName: payload.flaggedByName,
        scheduledDate: payload.scheduledDate,
        bookingId: payload.bookingId,
        appName: this.appName,
        year: this.year,
        supportEmail: this.supportEmail,
      });
    } catch (err) {
      this.logger.error(
        `Failed to send no-show email: ${(err as Error).message}`,
      );
    }
  }

  @OnEvent(APP_EVENTS.BOOKING_REMINDER_24H, { async: true })
  async handleBookingReminder24h(
    payload: BookingReminderPayload,
  ): Promise<void> {
    await this.sendReminderEmail(payload);
  }

  @OnEvent(APP_EVENTS.BOOKING_REMINDER_2H, { async: true })
  async handleBookingReminder2h(
    payload: BookingReminderPayload,
  ): Promise<void> {
    await this.sendReminderEmail(payload);
  }

  private async sendReminderEmail(
    payload: BookingReminderPayload,
  ): Promise<void> {
    try {
      const enabled = await this.isEmailWanted(
        payload.recipientUserId,
        NotificationType.BOOKING_REMINDER,
      );
      if (!enabled) return;
      const user = await this.findUser(payload.recipientUserId);
      if (!user) return;
      const eventKey =
        payload.milestone === '24H'
          ? APP_EVENTS.BOOKING_REMINDER_24H
          : APP_EVENTS.BOOKING_REMINDER_2H;
      await this.mailService.sendMail(user.email, eventKey, {
        firstname: user.firstname,
        scheduledDate: payload.scheduledDate,
        startTime: payload.startTime.slice(0, 5),
        bookingId: payload.bookingId,
        hoursOut: payload.milestone === '24H' ? '24 hours' : '2 hours',
        appName: this.appName,
        year: this.year,
        supportEmail: this.supportEmail,
      });
    } catch (err) {
      this.logger.error(
        `Failed to send ${payload.milestone} reminder email: ${(err as Error).message}`,
      );
    }
  }
}

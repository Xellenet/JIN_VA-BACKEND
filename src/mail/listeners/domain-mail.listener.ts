import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { MailService } from '../mail.service';
import { APP_EVENTS } from '@common/events/app.events';
import { User } from '../../users/entities/user.entity';
import type {
  ArtisanProfileVerifiedPayload,
  ArtisanVerificationRejectedPayload,
  BookingReceivedPayload,
  BookingConfirmedPayload,
  BookingDeclinedPayload,
  BookingCancelledPayload,
  BookingCompletedPayload,
} from '@common/events/app.events';

@Injectable()
export class DomainMailListener {
  private readonly logger = new Logger(DomainMailListener.name);

  constructor(
    private readonly mailService: MailService,
    private readonly config: ConfigService,
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
  ) {}

  private async findUser(userId: number): Promise<{ email: string; firstname: string } | null> {
    return this.usersRepository.findOne({
      where: { id: userId },
      select: ['email', 'firstname'],
    });
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
  async handleArtisanVerified(payload: ArtisanProfileVerifiedPayload): Promise<void> {
    try {
      const user = await this.findUser(payload.artisanUserId);
      if (!user) return;
      await this.mailService.sendMail(user.email, APP_EVENTS.ARTISAN_PROFILE_VERIFIED, {
        firstname: user.firstname,
        dashboardUrl: this.dashboardUrl,
        appName: this.appName,
        year: this.year,
        supportEmail: this.supportEmail,
      });
    } catch (err) {
      this.logger.error(`Failed to send artisan verified email: ${err.message}`);
    }
  }

  @OnEvent(APP_EVENTS.ARTISAN_VERIFICATION_REJECTED, { async: true })
  async handleVerificationRejected(payload: ArtisanVerificationRejectedPayload): Promise<void> {
    try {
      const user = await this.findUser(payload.artisanUserId);
      if (!user) return;
      await this.mailService.sendMail(user.email, APP_EVENTS.ARTISAN_VERIFICATION_REJECTED, {
        firstname: user.firstname,
        reason: payload.reason,
        appName: this.appName,
        year: this.year,
        supportEmail: this.supportEmail,
      });
    } catch (err) {
      this.logger.error(`Failed to send verification rejected email: ${err.message}`);
    }
  }

  @OnEvent(APP_EVENTS.BOOKING_RECEIVED, { async: true })
  async handleBookingReceived(payload: BookingReceivedPayload): Promise<void> {
    try {
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
      this.logger.error(`Failed to send booking received email: ${err.message}`);
    }
  }

  @OnEvent(APP_EVENTS.BOOKING_CONFIRMED, { async: true })
  async handleBookingConfirmed(payload: BookingConfirmedPayload): Promise<void> {
    try {
      const user = await this.findUser(payload.customerId);
      if (!user) return;
      await this.mailService.sendMail(user.email, APP_EVENTS.BOOKING_CONFIRMED, {
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
      this.logger.error(`Failed to send booking confirmed email: ${err.message}`);
    }
  }

  @OnEvent(APP_EVENTS.BOOKING_DECLINED, { async: true })
  async handleBookingDeclined(payload: BookingDeclinedPayload): Promise<void> {
    try {
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
      this.logger.error(`Failed to send booking declined email: ${err.message}`);
    }
  }

  @OnEvent(APP_EVENTS.BOOKING_CANCELLED, { async: true })
  async handleBookingCancelled(payload: BookingCancelledPayload): Promise<void> {
    try {
      const user = await this.findUser(payload.artisanUserId);
      if (!user) return;
      await this.mailService.sendMail(user.email, APP_EVENTS.BOOKING_CANCELLED, {
        firstname: user.firstname,
        customerName: payload.customerName,
        scheduledDate: payload.scheduledDate,
        bookingId: payload.bookingId,
        appName: this.appName,
        year: this.year,
        supportEmail: this.supportEmail,
      });
    } catch (err) {
      this.logger.error(`Failed to send booking cancelled email: ${err.message}`);
    }
  }

  @OnEvent(APP_EVENTS.BOOKING_COMPLETED, { async: true })
  async handleBookingCompleted(payload: BookingCompletedPayload): Promise<void> {
    try {
      const user = await this.findUser(payload.artisanUserId);
      if (!user) return;
      await this.mailService.sendMail(user.email, APP_EVENTS.BOOKING_COMPLETED, {
        firstname: user.firstname,
        scheduledDate: payload.scheduledDate,
        bookingId: payload.bookingId,
        appName: this.appName,
        year: this.year,
        supportEmail: this.supportEmail,
      });
    } catch (err) {
      this.logger.error(`Failed to send booking completed email: ${err.message}`);
    }
  }
}

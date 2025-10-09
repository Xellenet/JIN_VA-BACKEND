import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { MailEvent } from '../events/mail.events';
import { MailService } from '../mail.service';
import { ConfigService } from '@nestjs/config';
import type { PasswordResetPayload, PasswordResetSuccessPayload, UserRegisteredPayload, WelcomeUserPayload } from '../events/mail.events';

@Injectable()
export class UserMailListener {
  constructor(
    private readonly mailService: MailService,
    private readonly config: ConfigService,
  ) {}

  @OnEvent(MailEvent.USER_REGISTERED, { async: true })
  async handleUserRegistered(payload: UserRegisteredPayload) {
    const verificationLink = `${this.config.get('FRONTEND_URL')}/verify?token=${payload.verificationToken}`;

    await this.mailService.sendMail(payload.email, MailEvent.USER_REGISTERED, {
      firstname: payload.firstname,
      verificationLink,
      appName: this.config.get('APP_NAME'),
      year: new Date().getFullYear(),
      supportEmail: this.config.get('SUPPORT_EMAIL'),
    });
  }

  @OnEvent(MailEvent.WELCOME_USER, { async: true })
  async handleUserVerified(payload: WelcomeUserPayload) {
    await this.mailService.sendMail(payload.email, MailEvent.WELCOME_USER, {
      firstname: payload.firstname,
      appName: this.config.get('APP_NAME'),
      year: new Date().getFullYear(),
    });
  }

  @OnEvent(MailEvent.PASSWORD_RESET, { async: true })
  async handlePasswordReset(payload: PasswordResetPayload) {
    const resetLink = `${this.config.get('FRONTEND_URL')}/reset-password?token=${payload.resetToken}`;  
    await this.mailService.sendMail(payload.email, MailEvent.PASSWORD_RESET, {
      firstname: payload.firstname,
      resetLink,
      expiryMinutes: this.config.get('PASSWORD_RESET_TOKEN_EXPIRES_IN_MINUTES'),
      appName: this.config.get('APP_NAME'),
      year: new Date().getFullYear(),
      supportEmail: this.config.get('SUPPORT_EMAIL'),
    });
  }
  @OnEvent(MailEvent.PASSWORD_RESET_SUCCESS, { async: true })
  async handlePasswordResetSuccess(payload: PasswordResetSuccessPayload) {
    await this.mailService.sendMail(payload.email, MailEvent.PASSWORD_RESET_SUCCESS, {
      firstname: payload.firstname,
      appName: this.config.get('APP_NAME'),
      year: new Date().getFullYear(),
      supportEmail: this.config.get('SUPPORT_EMAIL'),
    });
  }

  @OnEvent(MailEvent.PASSWORD_CHANGED, { async: true })
  async handlePasswordChanged(payload: PasswordResetSuccessPayload) {
    await this.mailService.sendMail(payload.email, MailEvent.PASSWORD_CHANGED, {
      firstname: payload.firstname,
      appName: this.config.get('APP_NAME'),
      year: new Date().getFullYear(),
      supportEmail: this.config.get('SUPPORT_EMAIL'),
    });
  }

}

import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { MailEvent } from '../events/mail.events';
import { MailService } from '../mail.service';
import { ConfigService } from '@nestjs/config';
import { format } from 'date-fns';
import { getErrorMessage } from '@common/utils/error.util';
import { VARIABLES } from '@common/constants/variables.constants';
import type {
  AccountDeletedPayload,
  AccountRestoredPayload,
  PasswordResetPayload,
  PasswordResetSuccessPayload,
  UserRegisteredPayload,
  WelcomeUserPayload,
} from '../events/mail.events';

@Injectable()
export class UserMailListener {
  private readonly logger = new Logger(UserMailListener.name);

  constructor(
    private readonly mailService: MailService,
    private readonly config: ConfigService,
  ) {}

  @OnEvent(MailEvent.USER_REGISTERED, { async: true })
  async handleUserRegistered(payload: UserRegisteredPayload) {
    const verificationLink = `${this.config.get<string>('FRONTEND_URL')}/verify-email?token=${payload.verificationToken}`;

    await this.mailService.sendMail(payload.email, MailEvent.USER_REGISTERED, {
      firstname: payload.firstname,
      verificationLink,
      appName: this.config.get<string>('APP_NAME'),
      year: new Date().getFullYear(),
      supportEmail: this.config.get<string>('SUPPORT_EMAIL'),
    });
  }

  @OnEvent(MailEvent.WELCOME_USER, { async: true })
  async handleUserVerified(payload: WelcomeUserPayload) {
    await this.mailService.sendMail(payload.email, MailEvent.WELCOME_USER, {
      firstname: payload.firstname,
      appName: this.config.get<string>('APP_NAME'),
      year: new Date().getFullYear(),
    });
  }

  @OnEvent(MailEvent.PASSWORD_RESET, { async: true })
  async handlePasswordReset(payload: PasswordResetPayload) {
    const resetLink = `${this.config.get<string>('FRONTEND_URL')}/reset-password?token=${payload.resetToken}`;
    await this.mailService.sendMail(payload.email, MailEvent.PASSWORD_RESET, {
      firstname: payload.firstname,
      resetLink,
      expiryMinutes: this.config.get<number>(
        'PASSWORD_RESET_TOKEN_EXPIRES_IN_MINUTES',
      ),
      appName: this.config.get<string>('APP_NAME'),
      year: new Date().getFullYear(),
      supportEmail: this.config.get<string>('SUPPORT_EMAIL'),
    });
  }
  @OnEvent(MailEvent.PASSWORD_RESET_SUCCESS, { async: true })
  async handlePasswordResetSuccess(payload: PasswordResetSuccessPayload) {
    await this.mailService.sendMail(
      payload.email,
      MailEvent.PASSWORD_RESET_SUCCESS,
      {
        firstname: payload.firstname,
        appName: this.config.get<string>('APP_NAME'),
        year: new Date().getFullYear(),
        supportEmail: this.config.get<string>('SUPPORT_EMAIL'),
      },
    );
  }

  @OnEvent(MailEvent.PASSWORD_CHANGED, { async: true })
  async handlePasswordChanged(payload: PasswordResetSuccessPayload) {
    await this.mailService.sendMail(payload.email, MailEvent.PASSWORD_CHANGED, {
      firstname: payload.firstname,
      appName: this.config.get<string>('APP_NAME'),
      year: new Date().getFullYear(),
      supportEmail: this.config.get<string>('SUPPORT_EMAIL'),
    });
  }

  /**
   * C1.5: deletion confirmation. States the exact calendar date the account is
   * permanently purged and that signing in before then restores it, and links
   * to `/login` — deliberately **not** a tokenised one-click restore URL, so
   * possession of the mailbox alone can never un-delete an account (restoring
   * still requires the account's own credentials).
   *
   * Failures are caught and logged rather than propagated. Two reasons: the
   * deletion request itself must never fail because a mail server did (C1.5),
   * and `EventEmitter2` does not await async listeners, so a rejection here
   * would surface as an unhandled promise rejection rather than as anything
   * the caller could handle.
   */
  @OnEvent(MailEvent.ACCOUNT_DELETED, { async: true })
  async handleAccountDeleted(payload: AccountDeletedPayload) {
    try {
      await this.mailService.sendMail(
        payload.email,
        MailEvent.ACCOUNT_DELETED,
        {
          firstname: payload.firstname,
          deletedOn: formatCalendarDate(payload.deletedAt),
          purgeOn: formatCalendarDate(payload.purgeAt),
          retentionDays: VARIABLES.SOFT_DELETE_RETENTION_DAYS,
          loginLink: `${this.config.get<string>('FRONTEND_URL')}/login`,
          appName: this.config.get<string>('APP_NAME'),
          year: new Date().getFullYear(),
          supportEmail: this.config.get<string>('SUPPORT_EMAIL'),
        },
      );
    } catch (err) {
      this.logger.error(
        `Failed to send account-deleted email: ${getErrorMessage(err)}`,
      );
    }
  }

  /** C1.4: restore confirmation. Same log-and-swallow contract as above. */
  @OnEvent(MailEvent.ACCOUNT_RESTORED, { async: true })
  async handleAccountRestored(payload: AccountRestoredPayload) {
    try {
      await this.mailService.sendMail(
        payload.email,
        MailEvent.ACCOUNT_RESTORED,
        {
          firstname: payload.firstname,
          loginLink: `${this.config.get<string>('FRONTEND_URL')}/login`,
          appName: this.config.get<string>('APP_NAME'),
          year: new Date().getFullYear(),
          supportEmail: this.config.get<string>('SUPPORT_EMAIL'),
        },
      );
    } catch (err) {
      this.logger.error(
        `Failed to send account-restored email: ${getErrorMessage(err)}`,
      );
    }
  }
}

/**
 * C1.5 requires an exact calendar date, never a relative duration, so the
 * recipient knows precisely how long they have. `d MMMM yyyy` →
 * "23 September 2026".
 */
function formatCalendarDate(value: Date): string {
  return format(new Date(value), 'd MMMM yyyy');
}

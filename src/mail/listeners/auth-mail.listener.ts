import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { ConfigService } from '@nestjs/config';
import { format } from 'date-fns';
import { MailEvent } from '../events/mail.events';
import type {
  AuthCodeMailKind,
  AuthCodePayload,
  AuthNewSignInPayload,
  AuthPasswordChangedPayload,
  AuthSignupAttemptPayload,
} from '../events/mail.events';
import { MailService } from '../mail.service';
import { getErrorMessage } from '@common/utils/error.util';

const CODE_COPY: Record<AuthCodeMailKind, { heading: string; intro: string }> =
  {
    signup: {
      heading: 'Confirm your email',
      intro: 'Use this code to confirm your email and finish signing up.',
    },
    login: {
      heading: 'Your sign-in code',
      intro: 'Use this code to log in to your JinVa account.',
    },
    password_reset: {
      heading: 'Reset your password',
      intro: 'Use this code to choose a new password for your JinVa account.',
    },
  };

const METHOD_LABEL: Record<AuthNewSignInPayload['method'], string> = {
  password: 'Password',
  code: 'Email code',
  google: 'Google',
};

/**
 * Auth v2 emails. Like the other listeners, a delivery failure is logged
 * (without the address or the code) and never thrown: EventEmitter2 doesn't
 * await async listeners, and the request that triggered the mail has already
 * answered.
 */
@Injectable()
export class AuthMailListener {
  private readonly logger = new Logger(AuthMailListener.name);

  constructor(
    private readonly mailService: MailService,
    private readonly config: ConfigService,
  ) {}

  @OnEvent(MailEvent.AUTH_CODE, { async: true })
  async handleCode(payload: AuthCodePayload) {
    const copy = CODE_COPY[payload.kind] ?? CODE_COPY.login;
    await this.send('code', payload.email, MailEvent.AUTH_CODE, {
      firstname: payload.firstname,
      code: payload.code,
      expiresInMinutes: payload.expiresInMinutes,
      heading: copy.heading,
      intro: copy.intro,
    });
  }

  @OnEvent(MailEvent.AUTH_SIGNUP_ATTEMPT, { async: true })
  async handleSignupAttempt(payload: AuthSignupAttemptPayload) {
    await this.send(
      'signup-attempt',
      payload.email,
      MailEvent.AUTH_SIGNUP_ATTEMPT,
      {
        firstname: payload.firstname,
        loginLink: `${this.frontendUrl}/login`,
        forgotPasswordLink: this.forgotPasswordLink,
      },
    );
  }

  @OnEvent(MailEvent.AUTH_NEW_SIGN_IN, { async: true })
  async handleNewSignIn(payload: AuthNewSignInPayload) {
    await this.send('new-sign-in', payload.email, MailEvent.AUTH_NEW_SIGN_IN, {
      firstname: payload.firstname,
      signedInAt: formatInstant(payload.signedInAt),
      device: payload.device,
      method: METHOD_LABEL[payload.method] ?? payload.method,
      secureLink: this.forgotPasswordLink,
    });
  }

  @OnEvent(MailEvent.AUTH_PASSWORD_CHANGED, { async: true })
  async handlePasswordChanged(payload: AuthPasswordChangedPayload) {
    await this.send(
      'password-changed',
      payload.email,
      MailEvent.AUTH_PASSWORD_CHANGED,
      {
        firstname: payload.firstname,
        changedAt: formatInstant(payload.changedAt),
        secureLink: this.forgotPasswordLink,
      },
    );
  }

  private get frontendUrl(): string {
    return this.config.get<string>('FRONTEND_URL', '');
  }

  /** "Secure my account" goes to forgot password: a reset signs every other device out. */
  private get forgotPasswordLink(): string {
    return `${this.frontendUrl}/forgot-password`;
  }

  private async send(
    what: string,
    email: string,
    event: string,
    context: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.mailService.sendMail(email, event, {
        ...context,
        appName: this.config.get<string>('APP_NAME'),
        year: new Date().getFullYear(),
        supportEmail: this.config.get<string>('SUPPORT_EMAIL'),
      });
    } catch (err) {
      this.logger.error(
        `Failed to send ${what} email: ${getErrorMessage(err)}`,
      );
    }
  }
}

/** "3 November 2026, 14:05 UTC" — the server's clock, stated in UTC so it is unambiguous. */
export function formatInstant(value: Date): string {
  const d = new Date(value);
  const utc = new Date(d.getTime() + d.getTimezoneOffset() * 60_000);
  return `${format(utc, 'd MMMM yyyy, HH:mm')} UTC`;
}

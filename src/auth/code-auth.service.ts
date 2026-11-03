import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import * as bcrypt from 'bcrypt';
import { UsersService } from '@users/users.service';
import { UserTokenService } from '@users/token.service';
import { User } from '@users/entities/user.entity';
import { Token } from '@common/types/enums';
import { VARIABLES } from '@common/constants/variables.constants';
import { SUCCESS_MESSAGES } from '@common/constants/success-messages.constants';
import { normalizeEmail } from '@common/utils/email.util';
import { AccountBannedException } from '@common/exceptions/account-banned.exception';
import {
  APP_EVENTS,
  type SecurityAlertPayload,
} from '@common/events/app.events';
import { MailEvent } from 'mail/events/mail.events';
import type {
  AuthCodeMailKind,
  AuthCodePayload,
  AuthPasswordChangedPayload,
} from 'mail/events/mail.events';
import { AccountSecurityService } from '../account-security/account-security.service';
import { AuthCodeService } from './codes/auth-code.service';
import type { AuthCodePurpose } from './codes/auth-code.entity';
import {
  codeAttemptsExceeded,
  codeInvalid,
  codeSendLimited,
} from './codes/auth-code.errors';
import { AuthSessionService, ClientContext } from './auth-session.service';
import type { AuthTokenResult } from './dto/login-response.dto';
import type {
  CodeSentData,
  ClientCodePurpose,
  ResetPasswordWithCodeDto,
  VerifyCodeDto,
} from './dto/auth-code.dto';
import {
  responseFloorMs,
  withMinimumDuration,
} from './utils/response-floor.util';

/**
 * Auth v2: the code flows — `POST /auth/code/request`, `/auth/code/verify`,
 * `/auth/password/forgot` and `/auth/password/reset` — and the code delivery
 * that `POST /auth/register` shares with them.
 *
 * **No account fishing.** `request` and `forgot` answer the same body, after
 * the same minimum time (`AUTH_RESPONSE_FLOOR_MS`), whether or not the address
 * has an account: the per-address limits run first and identically for
 * everyone, the code is generated and hashed either way, and only the write
 * and the email are skipped when there is no account. `verify` answers
 * `CODE_INVALID` / `CODE_ATTEMPTS_EXCEEDED` on the same schedule for an
 * address with no account (see `AuthCodeService.verify`).
 */
@Injectable()
export class CodeAuthService {
  private readonly logger = new Logger(CodeAuthService.name);

  constructor(
    private readonly users: UsersService,
    private readonly userTokens: UserTokenService,
    private readonly codes: AuthCodeService,
    private readonly sessions: AuthSessionService,
    private readonly accountSecurity: AccountSecurityService,
    private readonly emitter: EventEmitter2,
  ) {}

  /**
   * Reserves a send for this address and purpose, or throws the 429. The
   * first step of every code-sending path, for every address.
   */
  async reserveOrThrow(emailHash: string, purpose: AuthCodePurpose) {
    const reservation = await this.codes.reserveSend(emailHash, purpose);
    if (!reservation.allowed) throw codeSendLimited(reservation);
    return reservation;
  }

  /**
   * Issues a code and, when `user` is given, stores it and emails it. With no
   * user the code is still generated and hashed (same cost) and discarded.
   */
  async deliverCode(
    emailHash: string,
    purpose: AuthCodePurpose,
    user: User | null,
    kind: AuthCodeMailKind = purpose,
    ctx?: ClientContext,
  ): Promise<void> {
    const code = await this.codes.issue(emailHash, purpose, user?.id ?? null);
    if (!user) return;
    this.emitter.emit(MailEvent.AUTH_CODE, {
      email: user.email,
      firstname: user.firstname,
      code,
      kind,
      expiresInMinutes: VARIABLES.AUTH_CODE_TTL_MINUTES,
    } satisfies AuthCodePayload);
    await this.accountSecurity.recordBestEffort({
      userId: user.id,
      event: 'auth.code_sent',
      details: { purpose },
      ip: ctx?.ip ?? null,
      userAgent: ctx?.userAgent ?? null,
    });
  }

  /** `POST /auth/code/request`. Always `{ resendAvailableAt }`, or the same 429. */
  async requestCode(
    email: string,
    purpose: ClientCodePurpose,
    ctx?: ClientContext,
  ): Promise<{ message: string; data: CodeSentData }> {
    return withMinimumDuration(async () => {
      const address = normalizeEmail(email);
      const emailHash = this.codes.hashEmail(address);
      const reservation = await this.reserveOrThrow(emailHash, purpose);

      const user = await this.users.findUserByEmail(address);
      let recipient: User | null = null;
      let kind: AuthCodeMailKind = purpose;
      if (user && !user.isBanned) {
        if (purpose === 'login') {
          recipient = user;
          // A login code for an account that never confirmed its email is
          // worded as the sign-up code; verifying it confirms and signs in.
          if (!user.accountVerified) kind = 'signup';
        } else if (!user.accountVerified) {
          recipient = user;
        }
      }
      await this.deliverCode(emailHash, purpose, recipient, kind, ctx);

      return {
        message: SUCCESS_MESSAGES.AUTH.CODE_REQUESTED,
        data: {
          resendAvailableAt: reservation.resendAvailableAt.toISOString(),
        },
      };
    }, responseFloorMs());
  }

  /** `POST /auth/password/forgot`. Same shape and timing as `requestCode`. */
  async forgotPassword(
    email: string,
    ctx?: ClientContext,
  ): Promise<{ message: string; data: CodeSentData }> {
    return withMinimumDuration(async () => {
      const address = normalizeEmail(email);
      const emailHash = this.codes.hashEmail(address);
      const reservation = await this.reserveOrThrow(
        emailHash,
        'password_reset',
      );
      const user = await this.users.findUserByEmail(address);
      await this.deliverCode(
        emailHash,
        'password_reset',
        user && !user.isBanned ? user : null,
        'password_reset',
        ctx,
      );
      return {
        message: SUCCESS_MESSAGES.AUTH.CODE_REQUESTED,
        data: {
          resendAvailableAt: reservation.resendAvailableAt.toISOString(),
        },
      };
    }, responseFloorMs());
  }

  /**
   * Checks a code for `purpose` and resolves its account, or throws the
   * contract's 400. Records failed and locking tries against the account when
   * there is one (never the code).
   */
  private async consume(
    email: string,
    purpose: AuthCodePurpose,
    code: string,
    ctx?: ClientContext,
    consume = true,
  ): Promise<User> {
    const emailHash = this.codes.hashEmail(email);
    const check = consume
      ? await this.codes.verify(emailHash, purpose, code)
      : await this.codes.verify(emailHash, purpose, code, undefined, {
          consume: false,
        });
    if (!check.ok) {
      if (check.userId !== undefined) {
        const base = {
          userId: check.userId,
          details: { purpose },
          ip: ctx?.ip ?? null,
          userAgent: ctx?.userAgent ?? null,
        };
        await this.accountSecurity.recordBestEffort({
          ...base,
          event: 'auth.code_failed',
        });
        if (check.justLocked) {
          await this.accountSecurity.recordBestEffort({
            ...base,
            event: 'auth.code_locked',
          });
        }
      }
      throw check.reason === 'locked' ? codeAttemptsExceeded() : codeInvalid();
    }

    const user = await this.users.findUserById(check.userId);
    if (!user) throw codeInvalid();
    if (user.isBanned) throw new AccountBannedException();
    return user;
  }

  /** Marks the account's email confirmed (a code proves the mailbox). */
  private async confirmEmail(user: User): Promise<boolean> {
    if (user.accountVerified) return false;
    user.accountVerified = true;
    user.verifiedAt = new Date();
    await this.users.updateUserData(user.id, {
      accountVerified: true,
      verifiedAt: user.verifiedAt,
    });
    return true;
  }

  /** `POST /auth/code/verify`: sign-up confirmation or code login; both sign in. */
  async verifyCode(
    dto: Pick<VerifyCodeDto, 'email' | 'code' | 'purpose'>,
    ctx?: ClientContext,
  ): Promise<AuthTokenResult> {
    const user = await this.consume(
      normalizeEmail(dto.email),
      dto.purpose,
      dto.code,
      ctx,
    );
    const confirmedNow = await this.confirmEmail(user);
    if (confirmedNow) {
      this.emitter.emit(MailEvent.WELCOME_USER, {
        email: user.email,
        firstname: user.firstname,
      });
    }
    return this.sessions.start(user, 'code', ctx, {
      message: SUCCESS_MESSAGES.AUTH.CODE_VERIFIED,
      // A brand-new account's first session isn't news to its owner.
      notifyNewSignIn: !confirmedNow,
    });
  }

  /**
   * `POST /auth/password/reset/check`: says whether a reset code is right
   * without using it up, so the page can move on to the new-password step.
   * A wrong code costs one of the code's 5 tries, exactly like a reset
   * attempt, so this is no cheaper a guessing oracle than the reset itself.
   */
  async checkResetCode(
    dto: { email: string; code: string },
    ctx?: ClientContext,
  ): Promise<{ message: string; data: { valid: true } }> {
    await this.consume(
      normalizeEmail(dto.email),
      'password_reset',
      dto.code,
      ctx,
      false,
    );
    return {
      message: SUCCESS_MESSAGES.AUTH.RESET_CODE_VALID,
      data: { valid: true },
    };
  }

  /**
   * `POST /auth/password/reset`: sets the new password, signs every other
   * session out (all refresh tokens, live codes and old reset links), records
   * the reset, emails "Your password was changed", and signs this one in.
   */
  async resetPassword(
    dto: Pick<ResetPasswordWithCodeDto, 'email' | 'code' | 'newPassword'>,
    ctx?: ClientContext,
  ): Promise<AuthTokenResult> {
    const user = await this.consume(
      normalizeEmail(dto.email),
      'password_reset',
      dto.code,
      ctx,
    );
    const password = await bcrypt.hash(
      dto.newPassword,
      VARIABLES.SALT_OR_ROUNDS,
    );
    await this.users.updateUserData(user.id, { password });
    await this.confirmEmail(user);

    await this.userTokens.revokeRefreshTokenForUser(user.id);
    await this.userTokens.revokeTokensOfType(user.id, Token.PASSWORD_RESET);
    await this.codes.revokeAllForUser(user.id);
    this.logger.log(`Password reset by code for user ${user.id}`);

    await this.accountSecurity.recordBestEffort({
      userId: user.id,
      event: 'auth.password_reset',
      details: { method: 'code' },
      ip: ctx?.ip ?? null,
      userAgent: ctx?.userAgent ?? null,
    });
    this.emitter.emit(MailEvent.AUTH_PASSWORD_CHANGED, {
      email: user.email,
      firstname: user.firstname,
      changedAt: new Date(),
    } satisfies AuthPasswordChangedPayload);
    this.emitter.emit(APP_EVENTS.SECURITY_ALERT, {
      userId: user.id,
      event: 'PASSWORD_RESET',
    } as SecurityAlertPayload);

    return this.sessions.start(user, 'code', ctx, {
      message: SUCCESS_MESSAGES.AUTH.PASSWORD_RESET_BY_CODE,
      notifyNewSignIn: false,
    });
  }
}

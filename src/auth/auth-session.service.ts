import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { plainToInstance } from 'class-transformer';
import { UserTokenService } from '@users/token.service';
import { User } from '@users/entities/user.entity';
import { UserResponseDto } from '@users/dto/user-response.dto';
import { AccountSecurityService } from '../account-security/account-security.service';
import { MailEvent } from 'mail/events/mail.events';
import type { AuthNewSignInPayload } from 'mail/events/mail.events';
import { AuthTokenResult, LoginResponseDto } from './dto/login-response.dto';
import { describeUserAgent } from './utils/user-agent.util';

/** The caller's network identity, from the request. */
export interface ClientContext {
  ip: string | null;
  userAgent: string | null;
}

export type SignInMethod = AuthNewSignInPayload['method'];

export interface StartSessionOptions {
  message: string;
  /** Email "New sign-in to your JinVa account". Off for a brand-new account and after a reset. */
  notifyNewSignIn: boolean;
}

/**
 * Auth v2: the one place a sign-in turns into a session, shared by password
 * login, code login, sign-up verification, password reset and Google.
 *
 * Issues a fresh access token and a fresh, persisted refresh token (so every
 * sign-in gets a new session identifier; the controller sets them as the same
 * httpOnly cookies login always has), records `auth.login` with the method in
 * the security log, and optionally sends the new-sign-in email.
 */
@Injectable()
export class AuthSessionService {
  private readonly logger = new Logger(AuthSessionService.name);

  constructor(
    private readonly userTokenService: UserTokenService,
    private readonly accountSecurity: AccountSecurityService,
    private readonly emitter: EventEmitter2,
  ) {}

  async start(
    user: User,
    method: SignInMethod,
    ctx: ClientContext | undefined,
    options: StartSessionOptions,
  ): Promise<AuthTokenResult> {
    const { access_token, refresh_token, expires_at } =
      await this.userTokenService.createJWTTokens(user);

    await this.accountSecurity.recordBestEffort({
      userId: user.id,
      event: 'auth.login',
      details: { method },
      ip: ctx?.ip ?? null,
      userAgent: ctx?.userAgent ?? null,
    });

    if (options.notifyNewSignIn) {
      try {
        this.emitter.emit(MailEvent.AUTH_NEW_SIGN_IN, {
          email: user.email,
          firstname: user.firstname,
          signedInAt: new Date(),
          device: describeUserAgent(ctx?.userAgent),
          method,
        } satisfies AuthNewSignInPayload);
      } catch (err) {
        this.logger.warn(
          `Could not queue the new sign-in email for user ${user.id}: ${(err as Error)?.name ?? 'Error'}`,
        );
      }
    }

    this.logger.log(`Session started for user ${user.id} (${method})`);
    const result = plainToInstance(LoginResponseDto, {
      access_token,
      expires_at,
      message: options.message,
      data: plainToInstance(UserResponseDto, user, {
        excludeExtraneousValues: true,
      }),
    });
    return { result, refreshToken: refresh_token };
  }
}

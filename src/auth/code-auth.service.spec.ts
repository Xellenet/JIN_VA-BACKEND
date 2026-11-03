import { HttpException } from '@nestjs/common';
import type { EventEmitter2 } from '@nestjs/event-emitter';
import type { UsersService } from '@users/users.service';
import type { UserTokenService } from '@users/token.service';
import type { User } from '@users/entities/user.entity';
import { Role, Token } from '@common/types/enums';
import { AccountBannedException } from '@common/exceptions/account-banned.exception';
import { MailEvent } from 'mail/events/mail.events';
import type { AccountSecurityService } from '../account-security/account-security.service';
import { CodeAuthService } from './code-auth.service';
import type { AuthCodeService } from './codes/auth-code.service';
import type { AuthSessionService } from './auth-session.service';

describe('CodeAuthService', () => {
  const ctx = { ip: '203.0.113.5', userAgent: 'Fictional/1.0' };
  const resendAt = new Date('2026-11-03T10:01:00.000Z');
  const user = (over: Partial<User> = {}): User =>
    ({
      id: 7,
      email: 'kofi.asante@example.com',
      firstname: 'Kofi',
      role: Role.CUSTOMER,
      accountVerified: true,
      isBanned: false,
      ...over,
    }) as User;

  let users: Record<string, jest.Mock>;
  let tokens: Record<string, jest.Mock>;
  let codes: Record<string, jest.Mock>;
  let sessions: { start: jest.Mock };
  let security: { recordBestEffort: jest.Mock };
  let emitter: { emit: jest.Mock };
  let service: CodeAuthService;
  const session = { result: { access_token: 'a' }, refreshToken: 'r' };

  beforeEach(() => {
    process.env.AUTH_RESPONSE_FLOOR_MS = '0';
    users = {
      findUserByEmail: jest.fn(),
      findUserById: jest.fn(),
      updateUserData: jest.fn().mockResolvedValue(undefined),
    };
    tokens = {
      revokeRefreshTokenForUser: jest.fn().mockResolvedValue(undefined),
      revokeTokensOfType: jest.fn().mockResolvedValue(undefined),
    };
    codes = {
      hashEmail: jest.fn().mockReturnValue('e'.repeat(64)),
      reserveSend: jest
        .fn()
        .mockResolvedValue({ allowed: true, resendAvailableAt: resendAt }),
      issue: jest.fn().mockResolvedValue('482915'),
      verify: jest.fn(),
      revokeAllForUser: jest.fn().mockResolvedValue(undefined),
    };
    sessions = { start: jest.fn().mockResolvedValue(session) };
    security = { recordBestEffort: jest.fn().mockResolvedValue(undefined) };
    emitter = { emit: jest.fn() };
    service = new CodeAuthService(
      users as unknown as UsersService,
      tokens as unknown as UserTokenService,
      codes as unknown as AuthCodeService,
      sessions as unknown as AuthSessionService,
      security as unknown as AccountSecurityService,
      emitter as unknown as EventEmitter2,
    );
  });

  afterAll(() => {
    delete process.env.AUTH_RESPONSE_FLOOR_MS;
  });

  const codeMails = (): Array<[string, Record<string, unknown>]> =>
    (
      emitter.emit.mock.calls as Array<[string, Record<string, unknown>]>
    ).filter(([e]) => e === MailEvent.AUTH_CODE);

  describe('requestCode / forgotPassword — no account fishing', () => {
    it('answers an unknown address with the same body, sends nothing, writes no code', async () => {
      users.findUserByEmail.mockResolvedValueOnce(user());
      const known = await service.requestCode(
        'kofi.asante@example.com',
        'login',
        ctx,
      );
      users.findUserByEmail.mockResolvedValueOnce(null);
      const unknown = await service.requestCode(
        'nobody@example.com',
        'login',
        ctx,
      );

      expect(unknown).toEqual(known);
      expect(known).toEqual({
        message: 'If an account uses this email, a code is on its way.',
        data: { resendAvailableAt: resendAt.toISOString() },
      });
      // Both paths generate and hash a code; only the known one stores and mails it.
      expect(codes.issue).toHaveBeenNthCalledWith(
        1,
        expect.any(String),
        'login',
        7,
      );
      expect(codes.issue).toHaveBeenNthCalledWith(
        2,
        expect.any(String),
        'login',
        null,
      );
      expect(codeMails()).toHaveLength(1);
      expect(codeMails()[0][1]).toMatchObject({
        code: '482915',
        kind: 'login',
        expiresInMinutes: 10,
      });
      expect(security.recordBestEffort).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'auth.code_sent',
          details: { purpose: 'login' },
        }),
      );
      // The security log never carries the code.
      expect(
        JSON.stringify(security.recordBestEffort.mock.calls),
      ).not.toContain('482915');
    });

    it('takes the same minimum time for both', async () => {
      process.env.AUTH_RESPONSE_FLOOR_MS = '80';
      users.findUserByEmail.mockResolvedValueOnce(user());
      let t = Date.now();
      await service.requestCode('kofi.asante@example.com', 'login');
      const knownMs = Date.now() - t;
      users.findUserByEmail.mockResolvedValueOnce(null);
      t = Date.now();
      await service.requestCode('nobody@example.com', 'login');
      const unknownMs = Date.now() - t;
      expect(knownMs).toBeGreaterThanOrEqual(75);
      expect(unknownMs).toBeGreaterThanOrEqual(75);
      expect(Math.abs(knownMs - unknownMs)).toBeLessThan(60);
    });

    it('applies the per-address limit before looking the address up, for everyone', async () => {
      codes.reserveSend.mockResolvedValueOnce({
        allowed: false,
        resendAvailableAt: resendAt,
        retryAfterSeconds: 42,
      });
      const err = (await service
        .requestCode('nobody@example.com', 'login')
        .catch((e: unknown) => e)) as HttpException;
      expect(err.getStatus()).toBe(429);
      expect(err.getResponse()).toMatchObject({
        errorCode: 'AUTH_RATE_LIMIT_EXCEEDED',
        retryAfterSeconds: 42,
        data: { resendAvailableAt: resendAt.toISOString() },
      });
      expect(users.findUserByEmail).not.toHaveBeenCalled();
    });

    it('a login code for an unconfirmed account is worded as the sign-up code', async () => {
      users.findUserByEmail.mockResolvedValueOnce(
        user({ accountVerified: false }),
      );
      await service.requestCode('kofi.asante@example.com', 'login');
      expect(codeMails()[0][1]).toMatchObject({ kind: 'signup' });
    });

    it('a sign-up resend goes only to an unconfirmed account', async () => {
      users.findUserByEmail.mockResolvedValueOnce(
        user({ accountVerified: true }),
      );
      await service.requestCode('kofi.asante@example.com', 'signup');
      users.findUserByEmail.mockResolvedValueOnce(
        user({ accountVerified: false }),
      );
      await service.requestCode('kofi.asante@example.com', 'signup');
      expect(codeMails()).toHaveLength(1);
    });

    it('sends nothing to a banned account', async () => {
      users.findUserByEmail.mockResolvedValue(user({ isBanned: true }));
      await service.requestCode('kofi.asante@example.com', 'login');
      await service.forgotPassword('kofi.asante@example.com');
      expect(codeMails()).toHaveLength(0);
    });

    it('forgot password: same body for known and unknown, a reset code only for the known one', async () => {
      users.findUserByEmail.mockResolvedValueOnce(user());
      const known = await service.forgotPassword(
        'kofi.asante@example.com',
        ctx,
      );
      users.findUserByEmail.mockResolvedValueOnce(null);
      const unknown = await service.forgotPassword('nobody@example.com', ctx);
      expect(unknown).toEqual(known);
      expect(codeMails()).toHaveLength(1);
      expect(codeMails()[0][1]).toMatchObject({ kind: 'password_reset' });
      expect(codes.reserveSend).toHaveBeenCalledWith(
        expect.any(String),
        'password_reset',
      );
    });
  });

  describe('verifyCode', () => {
    it('confirms the email on a sign-up code, welcomes, and signs in without a new-sign-in email', async () => {
      codes.verify.mockResolvedValueOnce({ ok: true, userId: 7 });
      users.findUserById.mockResolvedValueOnce(
        user({ accountVerified: false }),
      );

      const out = await service.verifyCode(
        { email: 'Kofi.Asante@example.com', code: '482915', purpose: 'signup' },
        ctx,
      );

      expect(out).toBe(session);
      expect(codes.verify).toHaveBeenCalledWith(
        expect.any(String),
        'signup',
        '482915',
      );
      expect(users.updateUserData).toHaveBeenCalledWith(
        7,
        expect.objectContaining({ accountVerified: true }),
      );
      expect(emitter.emit).toHaveBeenCalledWith(
        MailEvent.WELCOME_USER,
        expect.anything(),
      );
      expect(sessions.start).toHaveBeenCalledWith(
        expect.objectContaining({ id: 7 }),
        'code',
        ctx,
        expect.objectContaining({ notifyNewSignIn: false }),
      );
    });

    it('a login code on a confirmed account signs in and sends the new-sign-in email', async () => {
      codes.verify.mockResolvedValueOnce({ ok: true, userId: 7 });
      users.findUserById.mockResolvedValueOnce(user());
      await service.verifyCode(
        { email: 'kofi.asante@example.com', code: '482915', purpose: 'login' },
        ctx,
      );
      expect(users.updateUserData).not.toHaveBeenCalled();
      expect(sessions.start).toHaveBeenCalledWith(
        expect.anything(),
        'code',
        ctx,
        expect.objectContaining({ notifyNewSignIn: true }),
      );
    });

    it('answers CODE_INVALID and records a failed try against the account', async () => {
      codes.verify.mockResolvedValueOnce({
        ok: false,
        reason: 'invalid',
        userId: 7,
      });
      const err = (await service
        .verifyCode(
          {
            email: 'kofi.asante@example.com',
            code: '000000',
            purpose: 'login',
          },
          ctx,
        )
        .catch((e: unknown) => e)) as HttpException;
      expect(err.getStatus()).toBe(400);
      expect(err.getResponse()).toEqual({
        errorCode: 'CODE_INVALID',
        message: "That code didn't work. Check it or ask for a new one.",
      });
      expect(security.recordBestEffort).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 7, event: 'auth.code_failed' }),
      );
      expect(sessions.start).not.toHaveBeenCalled();
    });

    it('answers CODE_ATTEMPTS_EXCEEDED and records the lock once', async () => {
      codes.verify.mockResolvedValueOnce({
        ok: false,
        reason: 'locked',
        userId: 7,
        justLocked: true,
      });
      const err = (await service
        .verifyCode({
          email: 'kofi.asante@example.com',
          code: '000000',
          purpose: 'login',
        })
        .catch((e: unknown) => e)) as HttpException;
      expect(err.getResponse()).toMatchObject({
        errorCode: 'CODE_ATTEMPTS_EXCEEDED',
      });
      expect(
        security.recordBestEffort.mock.calls.map(
          ([e]: [{ event: string }]) => e.event,
        ),
      ).toEqual(['auth.code_failed', 'auth.code_locked']);
    });

    it('records nothing for an address with no account', async () => {
      codes.verify.mockResolvedValueOnce({ ok: false, reason: 'invalid' });
      await expect(
        service.verifyCode({
          email: 'nobody@example.com',
          code: '000000',
          purpose: 'login',
        }),
      ).rejects.toBeInstanceOf(HttpException);
      expect(security.recordBestEffort).not.toHaveBeenCalled();
    });

    it('treats a code whose account has gone as invalid, and refuses a banned one', async () => {
      codes.verify.mockResolvedValue({ ok: true, userId: 7 });
      users.findUserById.mockResolvedValueOnce(null);
      await expect(
        service.verifyCode({
          email: 'kofi.asante@example.com',
          code: '1',
          purpose: 'login',
        }),
      ).rejects.toMatchObject({ response: { errorCode: 'CODE_INVALID' } });
      users.findUserById.mockResolvedValueOnce(user({ isBanned: true }));
      await expect(
        service.verifyCode({
          email: 'kofi.asante@example.com',
          code: '1',
          purpose: 'login',
        }),
      ).rejects.toBeInstanceOf(AccountBannedException);
    });
  });

  describe('checkResetCode', () => {
    it('checks a reset code without consuming it', async () => {
      codes.verify.mockResolvedValueOnce({ ok: true, userId: 7 });
      users.findUserById.mockResolvedValueOnce(user());
      expect(
        await service.checkResetCode({
          email: 'Kofi.Asante@example.com',
          code: '482915',
        }),
      ).toEqual({
        message: expect.any(String) as string,
        data: { valid: true },
      });
      expect(codes.verify).toHaveBeenCalledWith(
        expect.any(String),
        'password_reset',
        '482915',
        undefined,
        { consume: false },
      );
      expect(users.updateUserData).not.toHaveBeenCalled();
      expect(sessions.start).not.toHaveBeenCalled();
    });

    it('answers a wrong code like a reset would', async () => {
      codes.verify.mockResolvedValueOnce({ ok: false, reason: 'invalid' });
      await expect(
        service.checkResetCode({ email: 'nobody@example.com', code: '000000' }),
      ).rejects.toMatchObject({ response: { errorCode: 'CODE_INVALID' } });
    });
  });

  describe('resetPassword', () => {
    it('sets the password, signs every other session out, records and emails, then signs in', async () => {
      codes.verify.mockResolvedValueOnce({ ok: true, userId: 7 });
      users.findUserById.mockResolvedValueOnce(user());

      const out = await service.resetPassword(
        {
          email: 'kofi.asante@example.com',
          code: '482915',
          newPassword: 'Fict1onal!',
        },
        ctx,
      );

      expect(out).toBe(session);
      expect(codes.verify).toHaveBeenCalledWith(
        expect.any(String),
        'password_reset',
        '482915',
      );
      const [, change] = users.updateUserData.mock.calls[0] as [
        number,
        { password: string },
      ];
      expect(change.password).toMatch(/^\$2[aby]\$/);
      expect(change.password).not.toContain('Fict1onal!');
      expect(tokens.revokeRefreshTokenForUser).toHaveBeenCalledWith(7);
      expect(tokens.revokeTokensOfType).toHaveBeenCalledWith(
        7,
        Token.PASSWORD_RESET,
      );
      expect(codes.revokeAllForUser).toHaveBeenCalledWith(7);
      expect(security.recordBestEffort).toHaveBeenCalledWith(
        expect.objectContaining({
          event: 'auth.password_reset',
          details: { method: 'code' },
        }),
      );
      expect(JSON.stringify(security.recordBestEffort.mock.calls)).not.toMatch(
        /Fict1onal|482915/,
      );
      expect(emitter.emit).toHaveBeenCalledWith(
        MailEvent.AUTH_PASSWORD_CHANGED,
        expect.objectContaining({ email: 'kofi.asante@example.com' }),
      );
      // The revocation happens before the new session is issued.
      expect(
        tokens.revokeRefreshTokenForUser.mock.invocationCallOrder[0],
      ).toBeLessThan(sessions.start.mock.invocationCallOrder[0]);
    });

    it('confirms an unconfirmed account on the way (the code proves the mailbox)', async () => {
      codes.verify.mockResolvedValueOnce({ ok: true, userId: 7 });
      users.findUserById.mockResolvedValueOnce(
        user({ accountVerified: false }),
      );
      await service.resetPassword({
        email: 'kofi.asante@example.com',
        code: '482915',
        newPassword: 'Fict1onal!',
      });
      expect(users.updateUserData).toHaveBeenCalledWith(
        7,
        expect.objectContaining({ accountVerified: true }),
      );
    });

    it('changes nothing for a wrong code', async () => {
      codes.verify.mockResolvedValueOnce({
        ok: false,
        reason: 'invalid',
        userId: 7,
      });
      await expect(
        service.resetPassword({
          email: 'kofi.asante@example.com',
          code: '000000',
          newPassword: 'Fict1onal!',
        }),
      ).rejects.toBeInstanceOf(HttpException);
      expect(users.updateUserData).not.toHaveBeenCalled();
      expect(tokens.revokeRefreshTokenForUser).not.toHaveBeenCalled();
    });
  });
});

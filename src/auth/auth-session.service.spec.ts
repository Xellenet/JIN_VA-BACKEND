import type { EventEmitter2 } from '@nestjs/event-emitter';
import type { UserTokenService } from '@users/token.service';
import type { User } from '@users/entities/user.entity';
import { Role } from '@common/types/enums';
import { MailEvent } from 'mail/events/mail.events';
import type { AccountSecurityService } from '../account-security/account-security.service';
import { AuthSessionService } from './auth-session.service';

describe('AuthSessionService', () => {
  const user = {
    id: 9,
    email: 'esi@example.com',
    firstname: 'Esi',
    role: Role.ARTISAN,
  } as User;
  const tokens = {
    createJWTTokens: jest.fn().mockResolvedValue({
      access_token: 'access',
      refresh_token: 'refresh',
      expires_at: new Date('2026-11-03T10:15:00Z'),
    }),
  };
  const security = { recordBestEffort: jest.fn().mockResolvedValue(undefined) };
  const emitter = { emit: jest.fn() };
  const service = new AuthSessionService(
    tokens as unknown as UserTokenService,
    security as unknown as AccountSecurityService,
    emitter as unknown as EventEmitter2,
  );
  const chrome =
    'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

  beforeEach(() => jest.clearAllMocks());

  it('issues a fresh pair, keeps the refresh token out of the body, and records the method', async () => {
    const { result, refreshToken } = await service.start(
      user,
      'code',
      { ip: '203.0.113.1', userAgent: chrome },
      {
        message: 'Signed in',
        notifyNewSignIn: true,
      },
    );
    expect(refreshToken).toBe('refresh');
    expect(result).toMatchObject({
      access_token: 'access',
      message: 'Signed in',
      data: { id: 9 },
    });
    expect(JSON.stringify(result)).not.toContain('refresh');
    expect(security.recordBestEffort).toHaveBeenCalledWith({
      userId: 9,
      event: 'auth.login',
      details: { method: 'code' },
      ip: '203.0.113.1',
      userAgent: chrome,
    });
    expect(emitter.emit).toHaveBeenCalledWith(MailEvent.AUTH_NEW_SIGN_IN, {
      email: 'esi@example.com',
      firstname: 'Esi',
      signedInAt: expect.any(Date) as Date,
      device: 'Chrome on Windows',
      method: 'code',
    });
  });

  it('sends no new-sign-in email when asked not to, and works without a request context', async () => {
    await service.start(user, 'google', undefined, {
      message: 'ok',
      notifyNewSignIn: false,
    });
    expect(emitter.emit).not.toHaveBeenCalled();
    expect(security.recordBestEffort).toHaveBeenCalledWith(
      expect.objectContaining({ ip: null, userAgent: null }),
    );
  });

  it('never fails a sign-in because the email could not be queued', async () => {
    emitter.emit.mockImplementationOnce(() => {
      throw new Error('listener blew up');
    });
    await expect(
      service.start(user, 'password', undefined, {
        message: 'ok',
        notifyNewSignIn: true,
      }),
    ).resolves.toMatchObject({ refreshToken: 'refresh' });
  });
});

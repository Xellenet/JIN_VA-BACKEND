import { UnauthorizedException } from '@nestjs/common';
import { JwtStrategy } from './jwt.strategy';
import type { UsersService } from '@users/users.service';
import { Role } from '@common/types/enums';
import {
  isAccessTokenPayload,
  type JwtPayload,
} from '@common/types/jwt-payload.type';

/**
 * QA SEC-05/06/08: a refresh token (days, same signing key) was accepted as an
 * access token, so it survived logout, rotation and password resets.
 */
describe('JwtStrategy.validate — token type', () => {
  const user = { id: 7, email: 'ama@example.com', isBanned: false };
  const usersService = {
    findUserByEmail: jest.fn().mockResolvedValue(user),
  } as unknown as UsersService;
  const strategy = new JwtStrategy(usersService);
  const now = Math.floor(Date.now() / 1000);
  const base = { sub: 7, email: 'ama@example.com', role: Role.CUSTOMER };

  it('accepts an access token', async () => {
    await expect(
      strategy.validate({ ...base, typ: 'access', iat: now, exp: now + 900 }),
    ).resolves.toBe(user);
  });

  it('refuses a refresh token, whatever its lifetime', async () => {
    await expect(
      strategy.validate({ ...base, typ: 'refresh', iat: now, exp: now + 900 }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(usersService.findUserByEmail).toHaveBeenCalledTimes(1);
  });

  it('still accepts a short-lived untyped token issued before the claim existed', async () => {
    await expect(
      strategy.validate({ ...base, iat: now, exp: now + 15 * 60 }),
    ).resolves.toBe(user);
  });

  it('refuses a long-lived untyped token (a pre-claim refresh token)', async () => {
    await expect(
      strategy.validate({ ...base, iat: now, exp: now + 3 * 24 * 3600 }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

describe('isAccessTokenPayload', () => {
  const p = (extra: Partial<JwtPayload>): JwtPayload => ({
    sub: 1,
    email: 'a@example.com',
    role: Role.CUSTOMER,
    ...extra,
  });

  it('decides by typ when present', () => {
    expect(isAccessTokenPayload(p({ typ: 'access' }))).toBe(true);
    expect(isAccessTokenPayload(p({ typ: 'refresh' }))).toBe(false);
  });

  it('refuses an untyped token with no lifetime claims', () => {
    expect(isAccessTokenPayload(p({}))).toBe(false);
  });
});

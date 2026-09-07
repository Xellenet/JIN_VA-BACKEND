import { Injectable } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import type {
  ThrottlerModuleOptions,
  ThrottlerOptions,
} from '@nestjs/throttler';
import { NamedThrottlerGuard } from './named-throttler.guard';
import { THROTTLER_NAMES } from './throttler-names';

/**
 * `NamedThrottlerGuard` exists to stop one concern's limit leaking onto another
 * concern's routes. That matters as soon as the config holds more than one
 * named throttler, which it now does (message-send + the two auth ones): the
 * stock `ThrottlerGuard` applies *every* configured throttler to *every* route
 * it protects, so without scoping, adding the auth limits would have silently
 * capped `POST /messages` at the auth limit too.
 */
@Injectable()
class CredentialsScopedGuard extends NamedThrottlerGuard {
  protected readonly throttlerName = THROTTLER_NAMES.AUTH_CREDENTIALS;

  /** The scoped list `canActivate` will iterate over. */
  public get scopedThrottlers(): ThrottlerOptions[] {
    return this.throttlers;
  }
}

@Injectable()
class MisnamedGuard extends NamedThrottlerGuard {
  protected readonly throttlerName = 'not-a-configured-throttler';
}

const options = (): ThrottlerModuleOptions => ({
  throttlers: [
    { name: THROTTLER_NAMES.MESSAGE_SEND, ttl: 60_000, limit: 25 },
    { name: THROTTLER_NAMES.AUTH_CREDENTIALS, ttl: 60_000, limit: 10 },
    { name: THROTTLER_NAMES.AUTH_EMAIL, ttl: 60_000, limit: 5 },
  ],
});

/** A storage stub that always answers "not blocked". */
const allowingStorage = () => ({
  increment: jest.fn().mockResolvedValue({
    totalHits: 1,
    timeToExpire: 60,
    isBlocked: false,
    timeToBlockExpire: 0,
  }),
});

const build = <T extends NamedThrottlerGuard>(
  Guard: new (...args: never[]) => T,
  moduleOptions: ThrottlerModuleOptions = options(),
): T =>
  new Guard(
    ...([
      moduleOptions,
      allowingStorage(),
      { getAllAndOverride: jest.fn() },
    ] as unknown as never[]),
  );

describe('NamedThrottlerGuard', () => {
  it('narrows the configured throttlers down to its own, so another concern’s limit cannot apply to its routes', async () => {
    const guard = build(CredentialsScopedGuard);
    await guard.onModuleInit();

    expect(guard.scopedThrottlers).toHaveLength(1);
    expect(guard.scopedThrottlers[0].name).toBe(
      THROTTLER_NAMES.AUTH_CREDENTIALS,
    );
    expect(guard.scopedThrottlers[0].limit).toBe(10);
  });

  it('refuses to start when its name matches nothing configured, rather than enforcing no limit at all', async () => {
    const guard = build(MisnamedGuard);

    await expect(guard.onModuleInit()).rejects.toThrow(
      /no throttler named "not-a-configured-throttler"/,
    );
  });

  it('self-initialises on first use, so a guard Nest never lifecycle-managed cannot 500 instead of returning a 429', async () => {
    const guard = build(CredentialsScopedGuard);
    // Deliberately skip onModuleInit, i.e. the guard was attached to a route
    // but never registered in the module's providers.
    const context = {
      getHandler: () => function handler() {},
      getClass: () => class Ctrl {},
      switchToHttp: () => ({
        getRequest: () => ({ ip: '203.0.113.7' }),
        getResponse: () => ({ header: jest.fn() }),
      }),
    } as unknown as ExecutionContext;

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(guard.scopedThrottlers).toHaveLength(1);
  });
});

import { HttpException, HttpStatus } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ThrottlerStorageService } from '@nestjs/throttler';
import type { ThrottlerModuleOptions } from '@nestjs/throttler';
import {
  CUSTOMER_RATE_LIMIT_ERROR_CODES,
  CUSTOMER_RATE_LIMIT_MESSAGE,
  CustomerAnalyticsThrottlerGuard,
  CustomerExportThrottlerGuard,
  NotificationReadThrottlerGuard,
  PaymentSettingsWriteThrottlerGuard,
  ProfileMediaWriteThrottlerGuard,
  UserKeyedThrottlerGuard,
} from './customer-throttler.guards';
import { THROTTLER_NAMES } from './throttler-names';
import {
  ARTISAN_RATE_LIMIT_ERROR_CODES,
  ArtisanExportThrottlerGuard,
  ArtisanInsightsThrottlerGuard,
  PayoutAccountLookupThrottlerGuard,
} from './artisan-throttler.guards';

type GuardClass = new (...args: never[]) => UserKeyedThrottlerGuard;

const CASES: Array<{
  Guard: GuardClass;
  name: string;
  code: string;
}> = [
  {
    Guard: CustomerAnalyticsThrottlerGuard,
    name: THROTTLER_NAMES.CUSTOMER_ANALYTICS,
    code: CUSTOMER_RATE_LIMIT_ERROR_CODES.CUSTOMER_ANALYTICS,
  },
  {
    Guard: CustomerExportThrottlerGuard,
    name: THROTTLER_NAMES.CUSTOMER_EXPORT,
    code: CUSTOMER_RATE_LIMIT_ERROR_CODES.CUSTOMER_EXPORT,
  },
  {
    Guard: PaymentSettingsWriteThrottlerGuard,
    name: THROTTLER_NAMES.PAYMENT_SETTINGS_WRITE,
    code: CUSTOMER_RATE_LIMIT_ERROR_CODES.PAYMENT_SETTINGS_WRITE,
  },
  {
    Guard: ProfileMediaWriteThrottlerGuard,
    name: THROTTLER_NAMES.PROFILE_MEDIA_WRITE,
    code: CUSTOMER_RATE_LIMIT_ERROR_CODES.PROFILE_MEDIA_WRITE,
  },
  {
    Guard: NotificationReadThrottlerGuard,
    name: THROTTLER_NAMES.NOTIFICATION_READ,
    code: CUSTOMER_RATE_LIMIT_ERROR_CODES.NOTIFICATION_READ,
  },
  {
    Guard: ArtisanInsightsThrottlerGuard,
    name: THROTTLER_NAMES.ARTISAN_INSIGHTS,
    code: ARTISAN_RATE_LIMIT_ERROR_CODES.ARTISAN_INSIGHTS,
  },
  {
    Guard: ArtisanExportThrottlerGuard,
    name: THROTTLER_NAMES.ARTISAN_EXPORT,
    code: ARTISAN_RATE_LIMIT_ERROR_CODES.ARTISAN_EXPORT,
  },
  {
    Guard: PayoutAccountLookupThrottlerGuard,
    name: THROTTLER_NAMES.PAYOUT_ACCOUNT_LOOKUP,
    code: ARTISAN_RATE_LIMIT_ERROR_CODES.PAYOUT_ACCOUNT_LOOKUP,
  },
];

/** A config with every customer throttler at limit 2, plus one unrelated. */
const options = (): ThrottlerModuleOptions => ({
  throttlers: [
    { name: THROTTLER_NAMES.MESSAGE_SEND, ttl: 60_000, limit: 1 },
    ...CASES.map(({ name }) => ({ name, ttl: 60_000, limit: 2 })),
  ],
});

function build(Guard: GuardClass, storage = new ThrottlerStorageService()) {
  return new Guard(
    ...([options(), storage, new Reflector()] as unknown as never[]),
  );
}

/** Two distinct route handlers, so per-route buckets can be shown. */
class FakeController {
  first() {}
  second() {}
}

function context(
  req: Record<string, unknown>,
  handler: () => void = FakeController.prototype.first,
) {
  const headers: Record<string, string> = {};
  const res = {
    header: jest.fn((name: string, value: unknown) => {
      headers[name] = String(value);
    }),
  };
  const ctx = {
    getHandler: () => handler,
    getClass: () => FakeController,
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => res,
    }),
  } as unknown as ExecutionContext;
  return { ctx, headers };
}

describe('Customer Experience v2 throttler guards', () => {
  describe.each(CASES)('$name', ({ Guard, name, code }) => {
    it('scopes itself to its own named throttler only', async () => {
      const guard = build(Guard);
      await guard.onModuleInit();
      const scoped = (guard as unknown as { throttlers: { name: string }[] })
        .throttlers;
      expect(scoped.map((t) => t.name)).toEqual([name]);
    });

    it('lets the limit through, then answers N+1 with a 429 carrying Retry-After and its code', async () => {
      const guard = build(Guard);
      await guard.onModuleInit();
      const req = { user: { id: 7 }, ip: '198.51.100.4' };

      await expect(guard.canActivate(context(req).ctx)).resolves.toBe(true);
      await expect(guard.canActivate(context(req).ctx)).resolves.toBe(true);

      const third = context(req);
      expect.assertions(8);
      try {
        await guard.canActivate(third.ctx);
      } catch (err) {
        const exception = err as HttpException;
        expect(exception).toBeInstanceOf(HttpException);
        expect(exception.getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
        const body = exception.getResponse() as {
          errorCode: string;
          message: string;
          retryAfterSeconds: number;
        };
        expect(body.errorCode).toBe(code);
        expect(body.message).toBe(CUSTOMER_RATE_LIMIT_MESSAGE);
        expect(body.retryAfterSeconds).toBeGreaterThanOrEqual(1);
        expect(third.headers['Retry-After']).toBe(
          String(body.retryAfterSeconds),
        );
      }
    });

    it('keys on the user, so another user is not blocked by this one', async () => {
      const guard = build(Guard);
      await guard.onModuleInit();
      const busy = { user: { id: 1 }, ip: '198.51.100.4' };
      await guard.canActivate(context(busy).ctx);
      await guard.canActivate(context(busy).ctx);
      await expect(guard.canActivate(context(busy).ctx)).rejects.toThrow(
        HttpException,
      );

      // Same IP (one office NAT), different user: still allowed.
      const other = { user: { id: 2 }, ip: '198.51.100.4' };
      await expect(guard.canActivate(context(other).ctx)).resolves.toBe(true);
    });

    it('gives every route its own bucket under the shared configuration', async () => {
      const guard = build(Guard);
      await guard.onModuleInit();
      const req = { user: { id: 3 } };
      const first = FakeController.prototype.first;
      await guard.canActivate(context(req, first).ctx);
      await guard.canActivate(context(req, first).ctx);
      await expect(guard.canActivate(context(req, first).ctx)).rejects.toThrow(
        HttpException,
      );

      await expect(
        guard.canActivate(context(req, FakeController.prototype.second).ctx),
      ).resolves.toBe(true);
    });
  });

  describe('tracker', () => {
    class Exposed extends CustomerAnalyticsThrottlerGuard {
      track(req: Record<string, unknown>) {
        return this.getTracker(req);
      }
    }
    const guard = build(Exposed as unknown as GuardClass) as unknown as Exposed;

    it('uses the user id when there is one', async () => {
      await expect(
        guard.track({ user: { id: 42 }, ip: '10.0.0.1' }),
      ).resolves.toBe('user-42');
    });

    it('falls back to the IP, and never stringifies a non-string ip', async () => {
      await expect(guard.track({ ip: '10.0.0.1' })).resolves.toBe(
        'ip-10.0.0.1',
      );
      await expect(guard.track({ ip: { odd: true } })).resolves.toBe(
        'ip-unknown',
      );
    });
  });

  describe('429 without an HTTP response object', () => {
    class Exposed extends NotificationReadThrottlerGuard {
      throwIt(ctx: ExecutionContext, timeToBlockExpire: number) {
        return this.throwThrottlingException(ctx, {
          totalHits: 61,
          timeToExpire: 30,
          isBlocked: true,
          timeToBlockExpire,
          ttl: 60_000,
          limit: 60,
          key: 'k',
          tracker: 'user-1',
        });
      }
    }

    it('still throws a 429 and never advertises a zero retry window', async () => {
      const guard = build(
        Exposed as unknown as GuardClass,
      ) as unknown as Exposed;
      const ctx = {
        switchToHttp: () => ({ getResponse: () => ({}) }),
      } as unknown as ExecutionContext;
      expect.assertions(2);
      try {
        await guard.throwIt(ctx, 0);
      } catch (err) {
        const body = (err as HttpException).getResponse() as {
          retryAfterSeconds: number;
        };
        expect((err as HttpException).getStatus()).toBe(429);
        expect(body.retryAfterSeconds).toBe(1);
      }
    });
  });
});

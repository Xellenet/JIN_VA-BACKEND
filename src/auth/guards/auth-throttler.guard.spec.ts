import { HttpException, HttpStatus } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import type {
  ThrottlerLimitDetail,
  ThrottlerModuleOptions,
} from '@nestjs/throttler';
import { THROTTLER_NAMES } from '@common/throttling/throttler-names';
import {
  AUTH_RATE_LIMIT_ERROR_CODE,
  AuthCredentialsThrottlerGuard,
  AuthEmailThrottlerGuard,
} from './auth-throttler.guard';

/** Exposes the two protected overrides that carry the requirements. */
class ExposedCredentialsGuard extends AuthCredentialsThrottlerGuard {
  public track(req: Record<string, unknown>): Promise<string> {
    return this.getTracker(req);
  }

  public throwIt(detail: ThrottlerLimitDetail): Promise<void> {
    return this.throwThrottlingException({} as ExecutionContext, detail);
  }

  public get scopedName(): string | undefined {
    return this.throttlers[0]?.name;
  }
}

class ExposedEmailGuard extends AuthEmailThrottlerGuard {
  public throwIt(detail: ThrottlerLimitDetail): Promise<void> {
    return this.throwThrottlingException({} as ExecutionContext, detail);
  }

  public get scopedName(): string | undefined {
    return this.throttlers[0]?.name;
  }
}

const options: ThrottlerModuleOptions = {
  throttlers: [
    { name: THROTTLER_NAMES.MESSAGE_SEND, ttl: 60_000, limit: 25 },
    { name: THROTTLER_NAMES.AUTH_CREDENTIALS, ttl: 60_000, limit: 10 },
    { name: THROTTLER_NAMES.AUTH_EMAIL, ttl: 60_000, limit: 5 },
  ],
};

const detail = (timeToBlockExpire: number): ThrottlerLimitDetail =>
  ({
    totalHits: 11,
    timeToExpire: 30,
    isBlocked: true,
    timeToBlockExpire,
    ttl: 60,
    limit: 10,
    key: 'k',
    tracker: 'ip-203.0.113.7',
  }) as ThrottlerLimitDetail;

const construct = <T>(Guard: new (...args: never[]) => T): T =>
  new Guard(
    ...([
      options,
      { increment: jest.fn() },
      { getAllAndOverride: jest.fn() },
    ] as unknown as never[]),
  );

describe('Auth abuse throttler guards', () => {
  const credentials = construct(ExposedCredentialsGuard);
  const email = construct(ExposedEmailGuard);

  describe('scoping', () => {
    it('each guard binds to exactly its own named throttler', async () => {
      await credentials.onModuleInit();
      await email.onModuleInit();

      expect(credentials.scopedName).toBe(THROTTLER_NAMES.AUTH_CREDENTIALS);
      expect(email.scopedName).toBe(THROTTLER_NAMES.AUTH_EMAIL);
    });
  });

  describe('tracker', () => {
    it('keys unauthenticated auth traffic on the client IP', async () => {
      await expect(credentials.track({ ip: '203.0.113.7' })).resolves.toBe(
        'ip-203.0.113.7',
      );
    });

    it('never keys on the submitted email, which would hand an attacker a fresh quota per address', async () => {
      const tracker = await credentials.track({
        ip: '203.0.113.7',
        body: { email: 'victim@example.com', password: 'guess' },
      });

      expect(tracker).not.toContain('victim@example.com');
      expect(tracker).toBe('ip-203.0.113.7');
    });

    it('prefers the authenticated account when there is one (change-password)', async () => {
      await expect(
        credentials.track({ user: { id: 42 }, ip: '203.0.113.7' }),
      ).resolves.toBe('user-42');
    });

    it('does not stringify a missing or non-string ip into "[object Object]"', async () => {
      await expect(credentials.track({ ip: { weird: true } })).resolves.toBe(
        'ip-unknown',
      );
      await expect(credentials.track({})).resolves.toBe('ip-unknown');
    });
  });

  describe('error contract', () => {
    it('throws a 429 with a stable code, human copy and retry hint — never a bare "Too many requests", never a 500', async () => {
      expect.assertions(6);
      try {
        await credentials.throwIt(detail(24));
      } catch (err) {
        const exception = err as HttpException;
        expect(exception).toBeInstanceOf(HttpException);
        expect(exception.getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);

        const body = exception.getResponse() as {
          errorCode: string;
          message: string;
          retryAfterSeconds: number;
        };
        // `errorCode`, not `error`: only the former survives
        // `AllExceptionsFilter` into the client-visible envelope (QA B1).
        expect(body.errorCode).toBe(AUTH_RATE_LIMIT_ERROR_CODE);
        expect(body.retryAfterSeconds).toBe(24);
        expect(body.message).toBe(
          'Too many attempts. Please try again in about 24 seconds.',
        );
        expect(body.message).not.toBe('ThrottlerException: Too many requests');
      }
    });

    it('never advertises a zero or negative retry window', async () => {
      expect.assertions(2);
      try {
        await credentials.throwIt(detail(0));
      } catch (err) {
        const body = (err as HttpException).getResponse() as {
          message: string;
          retryAfterSeconds: number;
        };
        expect(body.retryAfterSeconds).toBe(1);
        // Singular, not "1 seconds".
        expect(body.message).toContain('1 second.');
      }
    });

    it('says exactly the same thing on every throttled route, so a 429 cannot hint at which account or endpoint was hit', async () => {
      const capture = async (guard: {
        throwIt: (d: ThrottlerLimitDetail) => Promise<void>;
      }) => {
        try {
          await guard.throwIt(detail(30));
          throw new Error('expected a 429');
        } catch (err) {
          const exception = err as HttpException;
          return {
            status: exception.getStatus(),
            body: exception.getResponse(),
          };
        }
      };

      // The credential guard (login/restore-account) and the email guard
      // (register/forgot-password) are different limits, but an attacker must
      // not be able to tell them — or a real account from a fake one — apart
      // from the rejection.
      expect(await capture(credentials)).toEqual(await capture(email));
    });
  });
});

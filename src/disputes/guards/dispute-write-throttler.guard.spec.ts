import { HttpException, HttpStatus } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import type { ThrottlerLimitDetail } from '@nestjs/throttler';
import { DisputeWriteThrottlerGuard } from './dispute-write-throttler.guard';
import { THROTTLER_NAMES } from '@common/throttling/throttler-names';

/**
 * B5 has two testable properties beyond "a limit exists": it must be keyed on
 * the authenticated user (a party and an admin on the same office NAT are not
 * one actor), and exceeding it must say what happened rather than emit a bare
 * 429. Both live in the protected overrides, exposed here via a subclass.
 */
class ExposedGuard extends DisputeWriteThrottlerGuard {
  public track(req: Record<string, unknown>): Promise<string> {
    return this.getTracker(req);
  }

  public throwIt(detail: ThrottlerLimitDetail): Promise<void> {
    return this.throwThrottlingException({} as ExecutionContext, detail);
  }

  public get name(): string {
    return this.throttlerName;
  }
}

const detail = (timeToBlockExpire: number): ThrottlerLimitDetail =>
  ({
    totalHits: 21,
    timeToExpire: 30,
    isBlocked: true,
    timeToBlockExpire,
    ttl: 60,
    limit: 20,
    key: 'k',
    tracker: 'user-1',
  }) as ThrottlerLimitDetail;

describe('DisputeWriteThrottlerGuard (B5)', () => {
  const guard = new ExposedGuard(
    { throttlers: [{ name: 'dispute-write', ttl: 60_000, limit: 20 }] },
    { increment: jest.fn() } as never,
    { getAllAndOverride: jest.fn() } as never,
  );

  it('scopes itself to the dispute-write throttler, so no other concern’s limit applies', () => {
    expect(guard.name).toBe(THROTTLER_NAMES.DISPUTE_WRITE);
  });

  describe('tracker', () => {
    it('keys on the authenticated user, so one NAT is not treated as one actor', async () => {
      await expect(
        guard.track({ user: { id: 42 }, ip: '10.0.0.7' }),
      ).resolves.toBe('user-42');
    });

    it('falls back to IP only when there is no authenticated user', async () => {
      // Both routes run behind JwtAuthGuard, so this is the theoretical case
      // only — but it must not key everyone into one bucket named "undefined".
      await expect(guard.track({ ip: '10.0.0.7' })).resolves.toBe(
        'ip-10.0.0.7',
      );
    });

    it('does not stringify a non-string ip into "[object Object]"', async () => {
      await expect(guard.track({ ip: { weird: true } })).resolves.toBe(
        'ip-unknown',
      );
    });
  });

  describe('error contract', () => {
    it('throws a 429 with a machine code, a human message and a retry hint', async () => {
      expect.assertions(6);
      try {
        await guard.throwIt(detail(12));
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
        // `AllExceptionsFilter` into the client-visible envelope.
        expect(body.errorCode).toBe('DISPUTE_RATE_LIMIT_EXCEEDED');
        expect(body.retryAfterSeconds).toBe(12);
        expect(body.message).toContain('Too many dispute updates');
        expect(body.message).not.toBe('ThrottlerException: Too many requests');
      }
    });

    it('never advertises a zero or negative retry window', async () => {
      expect.assertions(2);
      try {
        await guard.throwIt(detail(0));
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
  });
});

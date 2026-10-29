import { HttpException, HttpStatus } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import type { ThrottlerLimitDetail } from '@nestjs/throttler';
import { MessageSendThrottlerGuard } from './message-send-throttler.guard';

/**
 * RL1 has two testable requirements beyond "a limit exists": the limit must be
 * per *user* (not per IP), and hitting it must produce a clear, specific error —
 * "never a raw 429 with no explanation". Both live in the two protected
 * overrides below, exposed here via a subclass.
 */
class ExposedGuard extends MessageSendThrottlerGuard {
  public track(req: Record<string, unknown>): Promise<string> {
    return this.getTracker(req);
  }

  public throwIt(detail: ThrottlerLimitDetail): Promise<void> {
    return this.throwThrottlingException({} as ExecutionContext, detail);
  }
}

const detail = (timeToBlockExpire: number): ThrottlerLimitDetail =>
  ({
    totalHits: 26,
    timeToExpire: 30,
    isBlocked: true,
    timeToBlockExpire,
    ttl: 60,
    limit: 25,
    key: 'k',
    tracker: 'user-1',
  }) as ThrottlerLimitDetail;

describe('MessageSendThrottlerGuard (RL1)', () => {
  const guard = new ExposedGuard(
    { throttlers: [{ name: 'message-send', ttl: 60_000, limit: 25 }] },
    { increment: jest.fn() } as never,
    { getAllAndOverride: jest.fn() } as never,
  );

  describe('tracker', () => {
    it('keys on the authenticated user, so one NAT is not treated as one sender', async () => {
      await expect(
        guard.track({ user: { id: 42 }, ip: '10.0.0.7' }),
      ).resolves.toBe('user-42');
    });

    it('falls back to IP only when there is no authenticated user', async () => {
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
    it('throws a 429 carrying a specific machine code, human message and retry hint — never a bare "Too many requests"', async () => {
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
        // `AllExceptionsFilter` into the client-visible envelope (QA B1).
        expect(body.errorCode).toBe('MESSAGE_RATE_LIMIT_EXCEEDED');
        expect(body.retryAfterSeconds).toBe(12);
        expect(body.message).toContain('sending messages too fast');
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

import {
  BadRequestException,
  HttpException,
  HttpStatus,
  InternalServerErrorException,
} from '@nestjs/common';
import type { ArgumentsHost, ExecutionContext } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { Logger } from 'winston';
import type { ThrottlerLimitDetail } from '@nestjs/throttler';
import { AllExceptionsFilter } from './all-exceptions.filter';
import { MessageSendThrottlerGuard } from '@messages/guards/message-send-throttler.guard';
import { ErrorResponse } from '../types/api-response.type';

/**
 * The filter owns the *client-visible* error contract, so what matters here is
 * the whole seam: what a thrower puts in an `HttpException` versus what
 * actually reaches the browser.
 *
 * QA B1 was exactly that seam coming apart — `MessageSendThrottlerGuard` threw
 * a documented `{ error, retryAfterSeconds }` body and the filter silently
 * copied out only `message`, so the published 429 contract was undeliverable.
 * The RL1 case below therefore drives the *real* guard, not a hand-written
 * stand-in, so a future rename on either side of the seam fails here.
 */

/** Exposes the guard's protected throw so the real exception can be captured. */
class ExposedGuard extends MessageSendThrottlerGuard {
  public throwIt(detail: ThrottlerLimitDetail): Promise<void> {
    return this.throwThrottlingException({} as ExecutionContext, detail);
  }
}

const throttleDetail = (timeToBlockExpire: number): ThrottlerLimitDetail =>
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

const captureThrown = async (
  detail: ThrottlerLimitDetail,
): Promise<HttpException> => {
  const guard = new ExposedGuard(
    { throttlers: [{ name: 'message-send', ttl: 60_000, limit: 25 }] },
    { increment: jest.fn() } as never,
    { getAllAndOverride: jest.fn() } as never,
  );
  try {
    await guard.throwIt(detail);
    throw new Error('guard did not throw');
  } catch (err) {
    return err as HttpException;
  }
};

describe('AllExceptionsFilter', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  /** Runs the filter and returns the body the client would receive. */
  const render = (exception: unknown): ErrorResponse => {
    const jsonSpy = jest.fn<void, [ErrorResponse]>();
    const mockResponse = {
      status: jest.fn().mockReturnValue({ json: jsonSpy }),
    } as unknown as Response;
    const mockRequest = {
      method: 'POST',
      url: '/api/v1/messages',
    } as unknown as Request;
    const host = {
      switchToHttp: () => ({
        getResponse: () => mockResponse,
        getRequest: () => mockRequest,
      }),
    } as unknown as ArgumentsHost;

    new AllExceptionsFilter({ error: jest.fn() } as unknown as Logger).catch(
      exception,
      host,
    );

    return jsonSpy.mock.calls[0][0];
  };

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  describe('RL1: the 429 body a browser really receives (QA B1)', () => {
    it('surfaces the throttler guard machine code and retry hint instead of the exception class name', async () => {
      const body = render(await captureThrown(throttleDetail(12)));

      expect(body.status).toBe('error');
      expect(body.meta.statusCode).toBe(HttpStatus.TOO_MANY_REQUESTS);
      // Previously 'HttpException' — useless for branching.
      expect(body.meta.error).toBe('MESSAGE_RATE_LIMIT_EXCEEDED');
      expect(body.meta.retryAfterSeconds).toBe(12);
      // The user-facing copy RL1 requires must still survive intact.
      expect(body.message).toContain('sending messages too fast');
      expect(body.message).not.toContain('ThrottlerException');
    });

    it('keeps the retry hint and the copy in agreement', async () => {
      const body = render(await captureThrown(throttleDetail(0)));

      expect(body.meta.retryAfterSeconds).toBe(1);
      expect(body.message).toContain('1 second.');
    });
  });

  describe('the rest of the app is unchanged', () => {
    it('still reports the exception class name for exceptions that opt into nothing', () => {
      const body = render(new BadRequestException('Invalid input data'));

      expect(body.meta.error).toBe('BadRequestException');
      expect(body.message).toBe('Invalid input data');
      // Nest's own `error: 'Bad Request'` key must NOT leak in as meta.error,
      // and a non-throttled error must not advertise a retry window.
      expect(body.meta.retryAfterSeconds).toBeUndefined();
    });

    it('preserves a ValidationPipe array message', () => {
      const body = render(
        new BadRequestException(['content must be shorter than 2000 chars']),
      );

      expect(body.message).toEqual(['content must be shorter than 2000 chars']);
      expect(body.meta.error).toBe('BadRequestException');
    });

    it('carries a string-constructed exception name through, as G10 relies on', () => {
      class SomeNamedException extends HttpException {}
      const body = render(
        new SomeNamedException('nope', HttpStatus.UNAUTHORIZED),
      );

      expect(body.meta.error).toBe('SomeNamedException');
      expect(body.message).toBe('nope');
    });

    it('ignores a non-string errorCode and a non-finite retryAfterSeconds', () => {
      const body = render(
        new HttpException(
          {
            message: 'weird',
            errorCode: 42,
            retryAfterSeconds: Number.NaN,
          },
          HttpStatus.BAD_REQUEST,
        ),
      );

      expect(body.meta.error).toBe('HttpException');
      expect(body.meta.retryAfterSeconds).toBeUndefined();
    });
  });

  describe('5xx redaction still holds in production', () => {
    it('leaks neither the message, the code, nor a retry hint', () => {
      process.env.NODE_ENV = 'production';
      const body = render(
        new InternalServerErrorException({
          message: 'connect ECONNREFUSED 10.0.0.4:5432',
          errorCode: 'DB_DOWN',
          retryAfterSeconds: 30,
        }),
      );

      expect(body.message).toBe(
        'Something went wrong. Please try again later.',
      );
      expect(body.meta.error).toBeUndefined();
      expect(body.meta.retryAfterSeconds).toBeUndefined();
    });
  });
});

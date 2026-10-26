import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import type { ErrorResponse } from '@common/types/api-response.type';

/**
 * PR5/LOC9: route-scoped replacement for `AllExceptionsFilter` on
 * `/locations/suggestions`.
 *
 * The global filter logs `${method} ${request.url}` for every error — for this
 * route that URL is `/api/v1/locations/suggestions?q=<what the user typed>`, so
 * every 400 (a 1-character `q`) and every 429 would write typed location text to
 * the logs. This filter produces the same `{ status, message, meta }` envelope
 * (including `meta.error` from `errorCode` and `meta.retryAfterSeconds`), but:
 * - `meta.path` is the path without its query string;
 * - 4xx are not logged at all (they're the caller's input or rate);
 * - an unexpected 5xx is logged with the exception name only — no URL, no
 *   query, no IP, no message (a message could quote input).
 */
@Catch()
export class LocationSuggestionsExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('LocationSuggestions');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;
    const path = (request.originalUrl ?? request.url ?? '').split('?')[0];

    let message: string | string[] =
      'Something went wrong. Please try again later.';
    let error: string | undefined;
    let retryAfterSeconds: number | undefined;

    if (status >= 400 && status < 500 && exception instanceof HttpException) {
      const raw: unknown = exception.getResponse();
      const body =
        typeof raw === 'object' && raw !== null
          ? (raw as {
              message?: unknown;
              errorCode?: unknown;
              retryAfterSeconds?: unknown;
            })
          : {};
      const bodyMessage = body.message;
      message =
        typeof bodyMessage === 'string' ||
        (Array.isArray(bodyMessage) &&
          bodyMessage.every((m) => typeof m === 'string'))
          ? bodyMessage
          : exception.message;
      error =
        typeof body.errorCode === 'string' && body.errorCode
          ? body.errorCode
          : exception.name;
      if (
        typeof body.retryAfterSeconds === 'number' &&
        Number.isFinite(body.retryAfterSeconds)
      ) {
        retryAfterSeconds = body.retryAfterSeconds;
      }
    } else {
      const name = exception instanceof Error ? exception.name : 'Error';
      this.logger.error(`GET ${path} failed (${status}, ${name})`);
    }

    const payload: ErrorResponse = {
      status: 'error',
      message,
      meta: {
        timestamp: new Date().toISOString(),
        path,
        statusCode: status,
        ...(error ? { error } : {}),
        ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
      },
    };

    response.setHeader('Cache-Control', 'no-store');
    response.status(status).json(payload);
  }
}

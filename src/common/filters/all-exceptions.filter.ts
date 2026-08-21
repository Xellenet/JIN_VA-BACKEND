import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { Logger } from 'winston';
import { ErrorResponse } from '../types/api-response.type';

/**
 * The optional, opt-in keys an exception may put in its response object to
 * shape the error envelope. Everything else in the response object is
 * deliberately dropped — the envelope is `{ status, message, meta }` and we do
 * not leak arbitrary internals into it.
 */
interface StructuredErrorResponse {
  message?: string | string[];
  /**
   * A stable, machine-readable code surfaced as `meta.error` instead of the
   * exception's class name. For errors the client must branch on rather than
   * merely display (e.g. RL1's `MESSAGE_RATE_LIMIT_EXCEEDED`), a class name is
   * a refactor-fragile contract; this is not.
   */
  errorCode?: string;
  /** Seconds until the caller may retry. Surfaced as `meta.retryAfterSeconds`. */
  retryAfterSeconds?: number;
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(private readonly logger: Logger) {}

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    const isProduction = process.env.NODE_ENV === 'production';

    let message: string | string[];
    let errorName: string;
    let errorCode: string | undefined;
    let retryAfterSeconds: number | undefined;

    if (exception instanceof HttpException) {
      const rawResponse: unknown = exception.getResponse();
      const structured: StructuredErrorResponse =
        typeof rawResponse === 'object' && rawResponse !== null
          ? (rawResponse as StructuredErrorResponse)
          : {};
      message = structured.message || exception.message || 'An error occurred';
      errorName = exception.name;
      // Opt-in overrides. Anything else in the response object stays out of the
      // envelope.
      if (typeof structured.errorCode === 'string' && structured.errorCode) {
        errorCode = structured.errorCode;
      }
      if (
        typeof structured.retryAfterSeconds === 'number' &&
        Number.isFinite(structured.retryAfterSeconds)
      ) {
        retryAfterSeconds = structured.retryAfterSeconds;
      }
    } else if (exception instanceof Error) {
      message = exception.message;
      errorName = exception.name;
    } else {
      message = 'Internal server error';
      errorName = 'Error';
    }

    this.logger.error(`${request.method} ${request.url}`, {
      status,
      message,
      stack: exception instanceof Error ? exception.stack : '',
      context: errorName,
      ...(errorCode ? { errorCode } : {}),
      environment: process.env.NODE_ENV,
    });

    let safeMessage: string | string[];
    let safeError: string | undefined;
    let safeRetryAfterSeconds: number | undefined;
    const isClientError = status >= 400 && status < 500;

    if (isClientError) {
      safeMessage = message;
      safeError = errorCode ?? errorName;
      safeRetryAfterSeconds = retryAfterSeconds;
    } else {
      // 5xx: never hand the client internals in production, including the code.
      safeMessage = isProduction
        ? 'Something went wrong. Please try again later.'
        : message;
      safeError = isProduction ? undefined : (errorCode ?? errorName);
      safeRetryAfterSeconds = isProduction ? undefined : retryAfterSeconds;
    }

    const errorResponse: ErrorResponse = {
      status: 'error',
      message: safeMessage,
      meta: {
        timestamp: new Date().toISOString(),
        path: request.url,
        statusCode: status,
        error: safeError,
        ...(safeRetryAfterSeconds !== undefined
          ? { retryAfterSeconds: safeRetryAfterSeconds }
          : {}),
      },
    };

    response.status(status).json(errorResponse);
  }
}

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
  /**
   * C1.4: a small bag of primitive, machine-readable facts the client needs in
   * order to *act* on the error rather than merely display it — currently only
   * the pending-deletion login rejection's `deletedAt`/`restorableUntil`,
   * which the login form prints as real dates instead of computing "+30 days"
   * itself.
   *
   * Still opt-in and still not a passthrough of the exception's response
   * object: only primitive values survive, and only under `meta.details`.
   * Anything an exception puts here is, by definition, something it has
   * decided is safe to hand the client — never load internals into it.
   */
  details?: Record<string, unknown>;
}

/** Only primitives cross the boundary — no nested objects, no functions. */
function sanitizeDetails(
  details: Record<string, unknown> | undefined,
): Record<string, string | number | boolean> | undefined {
  if (typeof details !== 'object' || details === null) return undefined;
  const safe: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(details)) {
    if (
      typeof value === 'string' ||
      typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value))
    ) {
      safe[key] = value;
    }
  }
  return Object.keys(safe).length > 0 ? safe : undefined;
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
    let details: Record<string, string | number | boolean> | undefined;

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
      details = sanitizeDetails(structured.details);
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
    let safeDetails: Record<string, string | number | boolean> | undefined;
    const isClientError = status >= 400 && status < 500;

    if (isClientError) {
      safeMessage = message;
      safeError = errorCode ?? errorName;
      safeRetryAfterSeconds = retryAfterSeconds;
      safeDetails = details;
    } else {
      // 5xx: never hand the client internals in production, including the code.
      safeMessage = isProduction
        ? 'Something went wrong. Please try again later.'
        : message;
      safeError = isProduction ? undefined : (errorCode ?? errorName);
      safeRetryAfterSeconds = isProduction ? undefined : retryAfterSeconds;
      safeDetails = isProduction ? undefined : details;
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
        ...(safeDetails ? { details: safeDetails } : {}),
      },
    };

    response.status(status).json(errorResponse);
  }
}

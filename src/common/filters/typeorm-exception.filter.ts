import { ArgumentsHost, Catch, ExceptionFilter, Logger } from '@nestjs/common';
import { QueryFailedError } from 'typeorm';
import type { Request, Response } from 'express';

/** TypeORM forwards the pg driver's error fields directly onto the thrown
 * `QueryFailedError` instance at runtime, but they aren't part of its
 * declared type — this narrows the `any` cast to just those two fields. */
interface PgQueryFailedError extends QueryFailedError {
  code?: string;
  detail?: string;
}

/**
 * Global exception filter that intercepts TypeORM {@link QueryFailedError} instances
 * and converts PostgreSQL driver errors into meaningful HTTP responses before they
 * reach the catch-all {@link AllExceptionsFilter}.
 *
 * Currently handles:
 * - `23505` (unique_violation) → 409 Conflict with a column-specific message.
 */
@Catch(QueryFailedError)
export class TypeOrmFilter implements ExceptionFilter {
  private readonly logger = new Logger(TypeOrmFilter.name);

  /**
   * Processes a failed database query and returns an appropriate HTTP error.
   *
   * @param exception - The TypeORM {@link QueryFailedError} that was thrown.
   * @param host - The NestJS arguments host providing access to the HTTP context.
   */
  catch(exception: QueryFailedError, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const pgException = exception as PgQueryFailedError;
    // TypeORM forwards the pg driver error code directly onto the exception object.
    const pgCode = pgException.code;
    // PostgreSQL includes a human-readable detail like:
    // "Key (email)=(john@example.com) already exists."
    const detail = pgException.detail ?? '';

    let message = 'Database operation failed';
    let status = 500;

    if (pgCode === '23505') {
      status = 409;

      if (detail.includes('email')) {
        message = 'Email already exists';
      } else if (detail.includes('username')) {
        message = 'Username already exists';
      } else if (detail.includes('phone_number')) {
        message = 'Phone number already in use';
      } else {
        message = 'Duplicate entry detected';
      }
    }

    this.logger.warn(`QueryFailedError [${pgCode}]: ${exception.message}`);

    response.status(status).json({
      status: 'error',
      message,
      meta: {
        timestamp: new Date().toISOString(),
        path: request.url,
        statusCode: status,
      },
    });
  }
}

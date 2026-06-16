import { ArgumentsHost, Catch, ExceptionFilter, Logger } from '@nestjs/common';
import { QueryFailedError } from 'typeorm';

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
    const response = ctx.getResponse();
    const request = ctx.getRequest();

    // TypeORM forwards the pg driver error code directly onto the exception object.
    const pgCode = (exception as any).code as string | undefined;
    // PostgreSQL includes a human-readable detail like:
    // "Key (email)=(john@example.com) already exists."
    const detail = ((exception as any).detail ?? '') as string;

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

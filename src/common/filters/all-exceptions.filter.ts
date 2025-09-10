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

    let message: string | string[];
    if (exception instanceof HttpException) {
      const errorResponse = exception.getResponse();
      message =
        (errorResponse as any).message ||
        exception.message ||
        'An error occurred';
    } else if (exception instanceof Error) {
      message = exception.message;
    } else {
      message = 'Internal server error';
    }

    this.logger.error(`${request.method} ${request.url} -> ${message}`, {
      status,
      stack: exception instanceof Error ? exception.stack : '',
      context: exception instanceof Error ? exception.name : 'UnknownError',
    });

    const errorResponse: ErrorResponse = {
      status: 'error',
      message,
      meta: {
        timestamp: new Date().toISOString(),
        path: request.url,
        statusCode: status,
        error: exception instanceof Error ? exception.name : 'Error',
      },
    };

    response.status(status).json(errorResponse);
  }
}

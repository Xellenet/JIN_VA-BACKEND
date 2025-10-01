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

    const isProduction = process.env.NODE_ENV === 'production';

    let message: string | string[];
    let errorName: string;

    if (exception instanceof HttpException) {
      const errorResponse = exception.getResponse();
      message =
        (errorResponse as any).message ||
        exception.message ||
        'An error occurred';
      errorName = exception.name;
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
      environment: process.env.NODE_ENV,
    });

    let safeMessage: string | string[];
    let safeError: string | undefined;

    if (status >= 400 && status < 500) {
      safeMessage = message;
      safeError = errorName;
    } else {
      safeMessage = isProduction
        ? 'Something went wrong. Please try again later.'
        : message;
      safeError = isProduction ? undefined : errorName;
    }

    const errorResponse: ErrorResponse = {
      status: 'error',
      message: safeMessage,
      meta: {
        timestamp: new Date().toISOString(),
        path: request.url,
        statusCode: status,
        error: safeError,
      },
    };

    response.status(status).json(errorResponse);
  }
}

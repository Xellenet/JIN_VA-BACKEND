import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import type { Request, Response } from 'express';
import { SuccessResponse } from '../types/api-response.type';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

@Injectable()
export class ResponseInterceptor<T>
  implements NestInterceptor<T, SuccessResponse<T>>
{
  intercept(
    context: ExecutionContext,
    next: CallHandler<T>,
  ): Observable<SuccessResponse<T>> {
    const ctx = context.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    if (request.url.startsWith('/api/v1/auth')) {
      // Auth routes intentionally bypass the success-envelope wrapping below
      // and return their own structured payload verbatim.
      return next.handle() as unknown as Observable<SuccessResponse<T>>;
    }
    return next.handle().pipe(
      map((data: unknown) => {
        const pagination = isRecord(data) ? data.pagination : undefined;
        let responseData: unknown = data;

        if (isRecord(data) && 'data' in data) {
          responseData = data.data;
        }

        const message =
          isRecord(data) && typeof data.message === 'string'
            ? data.message
            : Array.isArray(responseData)
              ? 'Resources retrieved successfully'
              : 'Request successful';

        return {
          status: 'success',
          message,
          data: responseData,
          meta: {
            timestamp: new Date().toISOString(),
            path: request.url,
            statusCode: response.statusCode,
            ...(pagination ? { pagination } : {}),
          },
        } as SuccessResponse<T>;
      }),
    );
  }
}

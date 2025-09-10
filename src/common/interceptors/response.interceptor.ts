
import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { SuccessResponse } from '../types/api-response.type';

@Injectable()
export class ResponseInterceptor<T>
  implements NestInterceptor<T, SuccessResponse<T>>
{
  intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Observable<SuccessResponse<T>> {
    const ctx = context.switchToHttp();
    const response = ctx.getResponse();
    const request = ctx.getRequest();

    return next.handle().pipe(
      map((data: any) => {
        const pagination = data?.pagination;
        let responseData = data;

        if (data && typeof data === 'object' && 'data' in data) {
          responseData = data.data;
        }

        return {
          status: 'success',
          message:
            data?.message ||
            (Array.isArray(responseData)
              ? 'Resources retrieved successfully'
              : 'Request successful'),
          data: responseData,
          meta: {
            timestamp: new Date().toISOString(),
            path: request.url,
            statusCode: response.statusCode,
            ...(pagination ? { pagination } : {}),
          },
        };
      }),
    );
  }
}

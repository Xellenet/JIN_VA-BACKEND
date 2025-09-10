import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

@Injectable()
export class ResponseInterceptor<T> implements NestInterceptor<T, any> {
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const ctx = context.switchToHttp();
    const response = ctx.getResponse();
    const request = ctx.getRequest();

    return next.handle().pipe(
      map((data) => {
        const { pagination, ...rest } = data;

        return {
            status: 'success',
            message: rest?.message || 'Request successful',
            data: rest?.data ?? rest,
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

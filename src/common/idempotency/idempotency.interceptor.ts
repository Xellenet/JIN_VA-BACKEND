import {
  CallHandler,
  ExecutionContext,
  HttpStatus,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { HTTP_CODE_METADATA } from '@nestjs/common/constants';
import type { Request, Response } from 'express';
import { from, Observable, of, throwError } from 'rxjs';
import { catchError, mergeMap } from 'rxjs/operators';
import {
  IdempotencyService,
  isValidIdempotencyKey,
  requestFingerprint,
} from './idempotency.service';

export const IDEMPOTENCY_HEADER = 'idempotency-key';
export const IDEMPOTENCY_REPLAYED_HEADER = 'Idempotency-Replayed';

/**
 * Makes a POST safe to retry with an `Idempotency-Key` header (optional:
 * without one the route behaves as before). Runs after the guards, so the
 * key is scoped to the authenticated user; the route template and the
 * request fingerprint come from the request itself. See
 * {@link IdempotencyService} for the rules.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    private readonly idempotency: IdempotencyService,
    private readonly reflector: Reflector,
  ) {}

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<unknown>> {
    const http = context.switchToHttp();
    const req = http.getRequest<Request & { user?: { id?: number } }>();
    const res = http.getResponse<Response>();
    const raw = req.headers?.[IDEMPOTENCY_HEADER];
    if (raw === undefined) return next.handle();
    const key = Array.isArray(raw) ? raw[0] : raw;
    if (!isValidIdempotencyKey(key)) throw IdempotencyService.invalidKey();
    const userId = req.user?.id;
    if (typeof userId !== 'number') return next.handle();

    const template =
      (req.route as { path?: string } | undefined)?.path ?? req.path;
    const route = `${req.method} ${template}`.slice(0, 80);
    const path = (req.originalUrl ?? req.url ?? '').split('?')[0];
    const fingerprint = requestFingerprint(req.method, path, req.body);

    const begun = await this.idempotency.begin(userId, key, route, fingerprint);
    if (begun.kind === 'replay') {
      res.setHeader(IDEMPOTENCY_REPLAYED_HEADER, 'true');
      if (begun.stored.kind === 'error') {
        return throwError(() =>
          IdempotencyService.toException(begun.status, begun.stored),
        );
      }
      return of(begun.stored.body);
    }

    const status =
      this.reflector.get<number | undefined>(
        HTTP_CODE_METADATA,
        context.getHandler(),
      ) ?? (req.method === 'POST' ? HttpStatus.CREATED : HttpStatus.OK);
    return next.handle().pipe(
      mergeMap((body: unknown) =>
        from(this.idempotency.complete(begun.id, status, body)).pipe(
          mergeMap(() => of(body)),
        ),
      ),
      catchError((err: unknown) =>
        from(this.idempotency.fail(begun.id, err)).pipe(
          mergeMap(() => throwError(() => err)),
        ),
      ),
    );
  }
}

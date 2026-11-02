import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  Logger,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';
import { createHash } from 'crypto';
import { LessThan, Repository } from 'typeorm';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { IdempotencyKey, type StoredResponse } from './idempotency-key.entity';

/** How long a key's first response is kept and replayed. */
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60_000;
/** An in-flight key older than this is taken over (its request died). */
export const IDEMPOTENCY_STALE_MS = 2 * 60_000;

export const IDEMPOTENCY_KEY_INVALID = 'IDEMPOTENCY_KEY_INVALID';
export const IDEMPOTENCY_KEY_REUSED = 'IDEMPOTENCY_KEY_REUSED';
export const IDEMPOTENCY_IN_PROGRESS = 'IDEMPOTENCY_IN_PROGRESS';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN = /^[A-Za-z0-9_-]{16,64}$/;

/** A UUID, or 16 to 64 URL-safe characters. */
export function isValidIdempotencyKey(value: unknown): value is string {
  return typeof value === 'string' && (UUID.test(value) || TOKEN.test(value));
}

/** JSON with object keys sorted, so `{a,b}` and `{b,a}` fingerprint alike. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .map(
        (k) =>
          `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`,
      );
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

export function requestFingerprint(
  method: string,
  path: string,
  body: unknown,
): string {
  return createHash('sha256')
    .update(`${method.toUpperCase()} ${path}\n${canonicalJson(body ?? {})}`)
    .digest('hex');
}

/** Errors that are not stored: the same request may succeed when retried. */
const RETRYABLE_STATUSES = new Set([401, 403, 408, 425, 429]);
const OWN_CODES = new Set([
  IDEMPOTENCY_KEY_INVALID,
  IDEMPOTENCY_KEY_REUSED,
  IDEMPOTENCY_IN_PROGRESS,
]);

export type BeginResult =
  | { kind: 'started'; id: number }
  | { kind: 'replay'; status: number; stored: StoredResponse };

/**
 * `Idempotency-Key` on the payment POSTs. A small table rather than a column
 * on `payment_charges`: a key covers responses that create no attempt (an
 * existing attempt returned, a 409, a validation error, the OTP step), and
 * it needs its own per-route uniqueness and expiry.
 *
 * - First use: the key is recorded `in_progress`; the response (2xx, or a
 *   4xx other than auth/throttling) is stored when the handler finishes. A
 *   5xx or thrown non-HTTP error releases the key so a retry runs again.
 * - Same key, same request: the stored response is replayed.
 * - Same key, different request: 422 `IDEMPOTENCY_KEY_REUSED`.
 * - Same key while the first is running: 409 `IDEMPOTENCY_IN_PROGRESS`.
 * - Keys live 24 hours; an hourly job deletes expired ones.
 */
@Injectable()
export class IdempotencyService {
  private readonly logger = new Logger(IdempotencyService.name);

  constructor(
    @InjectRepository(IdempotencyKey)
    private readonly keys: Repository<IdempotencyKey>,
  ) {}

  static invalidKey(): BadRequestException {
    return new BadRequestException({
      errorCode: IDEMPOTENCY_KEY_INVALID,
      message:
        'Idempotency-Key must be a UUID or 16 to 64 letters, digits, "-" or "_".',
    });
  }

  async begin(
    userId: number,
    key: string,
    route: string,
    fingerprint: string,
  ): Promise<BeginResult> {
    for (let round = 0; round < 3; round++) {
      const now = Date.now();
      const inserted = await this.keys
        .createQueryBuilder()
        .insert()
        .into(IdempotencyKey)
        .values({
          userId,
          key,
          route,
          fingerprint,
          state: 'in_progress',
          expiresAt: new Date(now + IDEMPOTENCY_TTL_MS),
        })
        .orIgnore()
        .returning(['id'])
        .execute();
      const id = (inserted.raw as Array<{ id: number }> | undefined)?.[0]?.id;
      if (id) return { kind: 'started', id };

      const row = await this.keys.findOne({ where: { userId, route, key } });
      if (!row) continue; // Removed in between: try again.
      if (new Date(row.expiresAt).getTime() <= now) {
        await this.keys.delete({ id: row.id, expiresAt: LessThan(new Date()) });
        continue;
      }
      if (row.fingerprint !== fingerprint) {
        throw new UnprocessableEntityException({
          errorCode: IDEMPOTENCY_KEY_REUSED,
          message:
            'This Idempotency-Key was already used for a different request. Use a new key.',
        });
      }
      if (row.state === 'completed' && row.responseBody) {
        return {
          kind: 'replay',
          status: row.responseStatus ?? 200,
          stored: row.responseBody,
        };
      }
      if (now - new Date(row.updatedAt).getTime() > IDEMPOTENCY_STALE_MS) {
        // The first request never finished (the process died): take it over.
        const res = await this.keys.update(
          {
            id: row.id,
            state: 'in_progress',
            updatedAt: LessThan(new Date(now - IDEMPOTENCY_STALE_MS)),
          },
          { updatedAt: new Date(now) },
        );
        if ((res.affected ?? 0) > 0) return { kind: 'started', id: row.id };
      }
      throw new ConflictException({
        errorCode: IDEMPOTENCY_IN_PROGRESS,
        message:
          'This request is still being processed. Wait a moment and try again with the same key.',
      });
    }
    throw new ConflictException({
      errorCode: IDEMPOTENCY_IN_PROGRESS,
      message:
        'This request is still being processed. Wait a moment and try again with the same key.',
    });
  }

  /** Never fails the request: an unsaved key is taken over once stale. */
  async complete(id: number, status: number, body: unknown): Promise<void> {
    try {
      await this.save(id, status, body);
    } catch (err) {
      this.logger.error(
        `Could not store an idempotent response: ${(err as Error)?.name ?? 'Error'}`,
      );
    }
  }

  private async save(id: number, status: number, body: unknown) {
    await this.store(id, status, {
      kind: 'success',
      body: JSON.parse(JSON.stringify(body ?? null)) as unknown,
    });
  }

  private async store(id: number, status: number, stored: StoredResponse) {
    const patch: Partial<IdempotencyKey> = {
      state: 'completed',
      responseStatus: status,
      responseBody: stored,
    };
    await this.keys.update(
      { id },
      patch as QueryDeepPartialEntity<IdempotencyKey>,
    );
  }

  /** Stores a deterministic client error; releases the key otherwise. */
  async fail(id: number, err: unknown): Promise<void> {
    try {
      await this.saveFailure(id, err);
    } catch (e) {
      this.logger.error(
        `Could not store an idempotent error: ${(e as Error)?.name ?? 'Error'}`,
      );
    }
  }

  private async saveFailure(id: number, err: unknown): Promise<void> {
    if (err instanceof HttpException && IdempotencyService.storable(err)) {
      await this.store(id, err.getStatus(), {
        kind: 'error',
        name: err.name,
        body: JSON.parse(JSON.stringify(err.getResponse())) as unknown,
      });
      return;
    }
    await this.keys.delete({ id });
  }

  static storable(err: HttpException): boolean {
    const status = err.getStatus();
    if (status >= 500 || RETRYABLE_STATUSES.has(status)) return false;
    const body = err.getResponse() as { errorCode?: unknown } | string;
    const code =
      typeof body === 'object' && body !== null ? body.errorCode : undefined;
    return !(typeof code === 'string' && OWN_CODES.has(code));
  }

  /** Rebuilds a stored error so the exception filter renders it identically. */
  static toException(status: number, stored: StoredResponse): HttpException {
    const name = stored.kind === 'error' ? stored.name : 'HttpException';
    const body = stored.body;
    const response =
      typeof body === 'object' && body !== null
        ? {
            ...(body as Record<string, unknown>),
            errorCode: (body as { errorCode?: unknown }).errorCode ?? name,
          }
        : { message: typeof body === 'string' ? body : '', errorCode: name };
    return new HttpException(response, status);
  }

  /** Hourly: removes expired keys. */
  @Cron(CronExpression.EVERY_HOUR)
  async purgeExpired(now: Date = new Date()): Promise<number> {
    try {
      const res = await this.keys.delete({ expiresAt: LessThan(now) });
      const removed = res.affected ?? 0;
      this.logger.log(`purgeExpired run summary: removed=${removed}`);
      return removed;
    } catch (err) {
      this.logger.error(
        `purgeExpired failed: ${(err as Error)?.name ?? 'Error'}`,
      );
      return 0;
    }
  }
}

import {
  BadRequestException,
  ConflictException,
  HttpException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Repository } from 'typeorm';
import { lastValueFrom, of, throwError } from 'rxjs';
import { IdempotencyKey } from './idempotency-key.entity';
import {
  canonicalJson,
  IDEMPOTENCY_IN_PROGRESS,
  IDEMPOTENCY_KEY_INVALID,
  IDEMPOTENCY_KEY_REUSED,
  IDEMPOTENCY_STALE_MS,
  IdempotencyService,
  isValidIdempotencyKey,
  requestFingerprint,
} from './idempotency.service';
import { IdempotencyInterceptor } from './idempotency.interceptor';

/**
 * An in-memory `idempotency_keys` table: the unique (user, route, key)
 * insert-or-ignore, reads, conditional updates and deletes.
 */
function keyTable() {
  const rows: IdempotencyKey[] = [];
  let nextId = 1;
  const match = (r: IdempotencyKey, where: Record<string, unknown>) =>
    Object.entries(where).every(([k, v]) => {
      const val = (r as unknown as Record<string, unknown>)[k];
      if (v && typeof v === 'object' && '_type' in v) {
        const op = v as { _type: string; _value: Date };
        return op._type === 'lessThan' && (val as Date) < op._value;
      }
      return val === v;
    });
  let pending: Partial<IdempotencyKey> | null = null;
  const qb = {
    insert: () => qb,
    into: () => qb,
    values: (v: Partial<IdempotencyKey>) => {
      pending = v;
      return qb;
    },
    orIgnore: () => qb,
    returning: () => qb,
    execute: () => {
      const v = pending!;
      const taken = rows.some(
        (r) => r.userId === v.userId && r.route === v.route && r.key === v.key,
      );
      if (taken) return Promise.resolve({ raw: [] });
      const now = new Date();
      const row = {
        ...v,
        id: nextId++,
        responseStatus: null,
        responseBody: null,
        createdAt: now,
        updatedAt: now,
      } as IdempotencyKey;
      rows.push(row);
      return Promise.resolve({ raw: [{ id: row.id }] });
    },
  };
  const repo = {
    rows,
    createQueryBuilder: jest.fn(() => qb),
    findOne: jest.fn(({ where }: { where: Record<string, unknown> }) =>
      Promise.resolve(rows.find((r) => match(r, where)) ?? null),
    ),
    update: jest.fn(
      (where: Record<string, unknown>, patch: Partial<IdempotencyKey>) => {
        const hits = rows.filter((r) => match(r, where));
        hits.forEach((r) => Object.assign(r, patch, { updatedAt: new Date() }));
        return Promise.resolve({ affected: hits.length });
      },
    ),
    delete: jest.fn((where: Record<string, unknown>) => {
      let affected = 0;
      for (let i = rows.length - 1; i >= 0; i--) {
        if (match(rows[i], where)) {
          rows.splice(i, 1);
          affected++;
        }
      }
      return Promise.resolve({ affected });
    }),
  };
  return repo;
}

describe('Idempotency keys', () => {
  let table: ReturnType<typeof keyTable>;
  let service: IdempotencyService;
  const KEY = '3f1c2d9e-8a4b-4c3d-9e2f-1a2b3c4d5e6f';
  const FP = 'a'.repeat(64);

  beforeEach(() => {
    table = keyTable();
    service = new IdempotencyService(
      table as unknown as Repository<IdempotencyKey>,
    );
  });

  describe('format and fingerprint', () => {
    it.each([
      [KEY, true],
      ['pay_0123456789abcdef', true],
      ['a'.repeat(64), true],
      ['short-key', false],
      ['a'.repeat(65), false],
      ['has space in it 1234', false],
      ['emoji🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂🙂', false],
      [undefined, false],
    ])('%s → %s', (key, ok) => {
      expect(isValidIdempotencyKey(key)).toBe(ok);
    });

    it('fingerprints the method, path and body, whatever the key order', () => {
      expect(canonicalJson({ b: 1, a: [1, { d: 2, c: null }] })).toBe(
        '{"a":[1,{"c":null,"d":2}],"b":1}',
      );
      const a = requestFingerprint('post', '/api/v1/payments/35/charge', {
        paymentMethodId: 4,
        x: undefined,
      });
      expect(a).toBe(
        requestFingerprint('POST', '/api/v1/payments/35/charge', {
          paymentMethodId: 4,
        }),
      );
      expect(a).not.toBe(
        requestFingerprint('POST', '/api/v1/payments/36/charge', {
          paymentMethodId: 4,
        }),
      );
      expect(a).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe('begin / complete / fail', () => {
    it('first use starts; the same request then replays the stored response', async () => {
      const first = await service.begin(22, KEY, 'POST /x', FP);
      expect(first.kind).toBe('started');
      await service.complete((first as { id: number }).id, 200, {
        message: 'ok',
        data: { reference: 'r1' },
      });
      await expect(service.begin(22, KEY, 'POST /x', FP)).resolves.toEqual({
        kind: 'replay',
        status: 200,
        stored: {
          kind: 'success',
          body: { message: 'ok', data: { reference: 'r1' } },
        },
      });
    });

    it('the same key for a different request is 422 IDEMPOTENCY_KEY_REUSED', async () => {
      await service.begin(22, KEY, 'POST /x', FP);
      await expect(
        service.begin(22, KEY, 'POST /x', 'b'.repeat(64)),
      ).rejects.toMatchObject({
        response: expect.objectContaining({
          errorCode: IDEMPOTENCY_KEY_REUSED,
        }) as unknown,
      });
    });

    it('the same key while the first is running is 409 IDEMPOTENCY_IN_PROGRESS', async () => {
      await service.begin(22, KEY, 'POST /x', FP);
      const err = await service
        .begin(22, KEY, 'POST /x', FP)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect((err as ConflictException).getResponse()).toMatchObject({
        errorCode: IDEMPOTENCY_IN_PROGRESS,
      });
    });

    it('keys are scoped per user and per route', async () => {
      await service.begin(22, KEY, 'POST /x', FP);
      await expect(
        service.begin(23, KEY, 'POST /x', FP),
      ).resolves.toMatchObject({
        kind: 'started',
      });
      await expect(
        service.begin(22, KEY, 'POST /y', FP),
      ).resolves.toMatchObject({
        kind: 'started',
      });
    });

    it('a request that died in flight is taken over once stale', async () => {
      const first = await service.begin(22, KEY, 'POST /x', FP);
      table.rows[0].updatedAt = new Date(Date.now() - IDEMPOTENCY_STALE_MS - 1);
      await expect(service.begin(22, KEY, 'POST /x', FP)).resolves.toEqual({
        kind: 'started',
        id: (first as { id: number }).id,
      });
    });

    it('an expired key starts afresh', async () => {
      await service.begin(22, KEY, 'POST /x', FP);
      table.rows[0].expiresAt = new Date(Date.now() - 1);
      await expect(
        service.begin(22, KEY, 'POST /x', 'c'.repeat(64)),
      ).resolves.toMatchObject({ kind: 'started' });
      expect(table.rows).toHaveLength(1);
    });

    it('stores a client error (replayed) but releases the key on a 5xx or a throttle', async () => {
      const a = (await service.begin(22, KEY, 'POST /x', FP)) as { id: number };
      await service.fail(
        a.id,
        new ConflictException({ errorCode: 'ALREADY_PAID', message: 'Paid' }),
      );
      await expect(
        service.begin(22, KEY, 'POST /x', FP),
      ).resolves.toMatchObject({
        kind: 'replay',
        status: 409,
        stored: { kind: 'error', name: 'ConflictException' },
      });

      const k2 = 'pay_0000000000000002';
      const b = (await service.begin(22, k2, 'POST /x', FP)) as { id: number };
      await service.fail(b.id, new ServiceUnavailableException('later'));
      expect(table.rows.find((r) => r.key === k2)).toBeUndefined();

      const k3 = 'pay_0000000000000003';
      const c = (await service.begin(22, k3, 'POST /x', FP)) as { id: number };
      await service.fail(c.id, new HttpException('slow down', 429));
      await service.fail(c.id, new Error('boom'));
      expect(table.rows.find((r) => r.key === k3)).toBeUndefined();
    });

    it('never stores its own idempotency errors', () => {
      expect(
        IdempotencyService.storable(
          new UnprocessableEntityException({
            errorCode: IDEMPOTENCY_KEY_REUSED,
          }),
        ),
      ).toBe(false);
      expect(
        IdempotencyService.storable(new BadRequestException('bad body')),
      ).toBe(true);
    });

    it('rebuilds a stored error with the same meta.error', () => {
      const plain = IdempotencyService.toException(409, {
        kind: 'error',
        name: 'ConflictException',
        body: { message: 'This job is already paid.', statusCode: 409 },
      });
      expect(plain.getStatus()).toBe(409);
      expect(plain.getResponse()).toMatchObject({
        errorCode: 'ConflictException',
        message: 'This job is already paid.',
      });
      const coded = IdempotencyService.toException(409, {
        kind: 'error',
        name: 'ConflictException',
        body: { errorCode: 'ALREADY_PAID', message: 'x', data: { jobId: 1 } },
      });
      expect(coded.getResponse()).toMatchObject({
        errorCode: 'ALREADY_PAID',
        data: { jobId: 1 },
      });
      expect(
        IdempotencyService.toException(400, {
          kind: 'error',
          name: 'BadRequestException',
          body: 'text',
        }).getResponse(),
      ).toEqual({ message: 'text', errorCode: 'BadRequestException' });
    });

    it('a storage failure never fails the request', async () => {
      table.update.mockRejectedValueOnce(new Error('db'));
      await expect(service.complete(1, 200, {})).resolves.toBeUndefined();
      table.delete.mockRejectedValueOnce(new Error('db'));
      await expect(service.fail(1, new Error('x'))).resolves.toBeUndefined();
    });

    it('purgeExpired deletes expired keys and survives a failure', async () => {
      await service.begin(22, KEY, 'POST /x', FP);
      table.rows[0].expiresAt = new Date(Date.now() - 1);
      await expect(service.purgeExpired()).resolves.toBe(1);
      table.delete.mockRejectedValueOnce(new Error('db'));
      await expect(service.purgeExpired()).resolves.toBe(0);
    });

    it('invalidKey is a 400 with its code', () => {
      expect(IdempotencyService.invalidKey().getResponse()).toMatchObject({
        errorCode: IDEMPOTENCY_KEY_INVALID,
      });
    });
  });

  describe('IdempotencyInterceptor', () => {
    let interceptor: IdempotencyInterceptor;
    const handler = function handler() {};
    const ctx = (
      headers: Record<string, string | string[]>,
      body: unknown = { paymentMethodId: 4 },
      user: { id?: number } | null = { id: 22 },
    ) => {
      const res = { setHeader: jest.fn() };
      const req = {
        method: 'POST',
        headers,
        body,
        user,
        route: { path: '/api/v1/payments/:jobId/charge' },
        originalUrl: '/api/v1/payments/35/charge?x=1',
        path: '/api/v1/payments/35/charge',
      };
      const context = {
        switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
        getHandler: () => handler,
      } as unknown as ExecutionContext;
      return { context, res };
    };
    const call = (handle: () => unknown): CallHandler => ({
      handle: jest.fn(handle) as unknown as CallHandler['handle'],
    });

    beforeEach(() => {
      interceptor = new IdempotencyInterceptor(service, new Reflector());
    });

    it('without the header the route behaves as before', async () => {
      const next = call(() => of('x'));
      const { context } = ctx({});
      await expect(
        lastValueFrom(await interceptor.intercept(context, next)),
      ).resolves.toBe('x');
      expect(table.rows).toHaveLength(0);
    });

    it('a malformed key is 400', async () => {
      const { context } = ctx({ 'idempotency-key': 'nope' });
      await expect(
        interceptor.intercept(
          context,
          call(() => of('x')),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('runs once, then replays with the replay header (one handler call)', async () => {
      const handle = jest.fn(() => of({ message: 'ok', data: { r: 1 } }));
      const next = { handle } as unknown as CallHandler;
      const first = ctx({ 'idempotency-key': KEY });
      await expect(
        lastValueFrom(await interceptor.intercept(first.context, next)),
      ).resolves.toEqual({ message: 'ok', data: { r: 1 } });
      expect(table.rows[0]).toMatchObject({
        route: 'POST /api/v1/payments/:jobId/charge',
        state: 'completed',
        responseStatus: 201,
      });

      const second = ctx({ 'idempotency-key': [KEY] });
      await expect(
        lastValueFrom(await interceptor.intercept(second.context, next)),
      ).resolves.toEqual({ message: 'ok', data: { r: 1 } });
      expect(handle).toHaveBeenCalledTimes(1);
      expect(second.res.setHeader).toHaveBeenCalledWith(
        'Idempotency-Replayed',
        'true',
      );
    });

    it('replays a stored error as the same error', async () => {
      const first = ctx({ 'idempotency-key': KEY });
      const boom = new ConflictException({
        errorCode: 'ALREADY_PAID',
        message: 'Paid',
      });
      await expect(
        lastValueFrom(
          await interceptor.intercept(
            first.context,
            call(() => throwError(() => boom)),
          ),
        ),
      ).rejects.toBe(boom);
      const again = ctx({ 'idempotency-key': KEY });
      const err = await lastValueFrom(
        await interceptor.intercept(
          again.context,
          call(() => of('never')),
        ),
      ).catch((e: unknown) => e);
      expect((err as HttpException).getStatus()).toBe(409);
      expect((err as HttpException).getResponse()).toMatchObject({
        errorCode: 'ALREADY_PAID',
      });
    });

    it('a different body with the same key is 422', async () => {
      const first = ctx({ 'idempotency-key': KEY });
      await lastValueFrom(
        await interceptor.intercept(
          first.context,
          call(() => of('x')),
        ),
      );
      const other = ctx({ 'idempotency-key': KEY }, { paymentMethodId: 5 });
      await expect(
        interceptor.intercept(
          other.context,
          call(() => of('x')),
        ),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
    });

    it('without a user (no auth) it steps aside', async () => {
      const { context } = ctx({ 'idempotency-key': KEY }, {}, null);
      await expect(
        lastValueFrom(
          await interceptor.intercept(
            context,
            call(() => of(1)),
          ),
        ),
      ).resolves.toBe(1);
      expect(table.rows).toHaveLength(0);
    });
  });
});

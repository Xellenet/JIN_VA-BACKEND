import { PGlite } from '@electric-sql/pglite';
import type { QueryRunner, Repository } from 'typeorm';
import { VARIABLES } from '@common/constants/variables.constants';
import { CreateAuthCodes1783370000000 } from '../../migrations/1783370000000-CreateAuthCodes';
import { AuthCode } from './auth-code.entity';
import { AuthCodeService, type CodeCheck } from './auth-code.service';
import { resolveAuthCodeKeys } from './auth-code-secret';

/**
 * The code store against real Postgres (PGlite, in this process — no server,
 * no network), with the real migration. `manager.query` is adapted to
 * TypeORM's return shape (`[rows, affected]` for UPDATE/DELETE).
 */
describe('AuthCodeService', () => {
  let db: PGlite;
  let service: AuthCodeService;
  const email = 'kofi.asante@example.com';
  let emailHash: string;
  const T0 = new Date('2026-11-03T10:00:00.000Z');
  const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);

  const manager = {
    async query(sql: string, params: unknown[] = []) {
      const res = await db.query(sql, params);
      return /^\s*(UPDATE|DELETE)/i.test(sql)
        ? [res.rows, res.affectedRows ?? 0]
        : res.rows;
    },
    async transaction<T>(work: (m: unknown) => Promise<T>): Promise<T> {
      await db.query('BEGIN');
      try {
        const out = await work(manager);
        await db.query('COMMIT');
        return out;
      } catch (err) {
        await db.query('ROLLBACK');
        throw err;
      }
    },
  };

  beforeAll(async () => {
    db = await PGlite.create();
    await db.exec('CREATE TABLE "users" ("id" SERIAL PRIMARY KEY)');
    await db.exec(
      'INSERT INTO "users" DEFAULT VALUES; INSERT INTO "users" DEFAULT VALUES;',
    );
    const runner = {
      query: (sql: string, params?: unknown[]) => manager.query(sql, params),
    } as unknown as QueryRunner;
    const migration = new CreateAuthCodes1783370000000();
    await migration.up(runner);
    // Idempotent: a second run changes nothing and does not fail.
    await migration.up(runner);
  });

  afterAll(async () => {
    await db.close();
  });

  beforeEach(async () => {
    await db.exec(
      'DELETE FROM "auth_codes"; DELETE FROM "auth_code_requests";',
    );
    service = new AuthCodeService({
      manager,
    } as unknown as Repository<AuthCode>);
    emailHash = service.hashEmail(email);
  });

  /** Reserve + issue, the way every sending path does. */
  async function send(
    purpose: 'signup' | 'login' | 'password_reset',
    s = 0,
    userId: number | null = 1,
  ) {
    const reservation = await service.reserveSend(emailHash, purpose, at(s));
    if (!reservation.allowed) throw new Error('unexpectedly limited');
    return service.issue(emailHash, purpose, userId, at(s));
  }

  describe('codes and hashes', () => {
    it('generates 6 digits, keeping leading zeros, from the CSPRNG', () => {
      const seen = new Set<string>();
      for (let i = 0; i < 500; i++) {
        const code = service.generateCode();
        expect(code).toMatch(/^\d{6}$/);
        seen.add(code);
      }
      // 500 draws from a million values: collisions are possible, a constant is not.
      expect(seen.size).toBeGreaterThan(490);
    });

    it('hashes the address case- and space-insensitively, with a key', () => {
      expect(service.hashEmail('  Kofi.Asante@Example.com ')).toBe(emailHash);
      expect(emailHash).toMatch(/^[0-9a-f]{64}$/);
      expect(emailHash).not.toContain('kofi');
    });

    it('binds the code hash to the purpose and the address', () => {
      const h = service.hashCode(emailHash, 'login', '123456');
      expect(service.hashCode(emailHash, 'signup', '123456')).not.toBe(h);
      expect(
        service.hashCode(
          service.hashEmail('esi@example.com'),
          'login',
          '123456',
        ),
      ).not.toBe(h);
      expect(service.hashCode(emailHash, 'login', '123456')).toBe(h);
    });

    it('compares digests in constant time and refuses mismatched lengths', () => {
      const h = service.hashCode(emailHash, 'login', '000001');
      expect(AuthCodeService.digestsMatch(h, h)).toBe(true);
      expect(
        AuthCodeService.digestsMatch(
          h,
          service.hashCode(emailHash, 'login', '000002'),
        ),
      ).toBe(false);
      expect(AuthCodeService.digestsMatch(h, 'abcd')).toBe(false);
      expect(AuthCodeService.digestsMatch('', '')).toBe(false);
    });

    it('stores only the hash — never the code — and the email only as its hash', async () => {
      const code = await send('signup');
      const rows = await db.query<Record<string, unknown>>(
        'SELECT * FROM "auth_codes"',
      );
      expect(rows.rows).toHaveLength(1);
      expect(JSON.stringify(rows.rows)).not.toContain(code);
      expect(JSON.stringify(rows.rows)).not.toContain('kofi');
      expect(rows.rows[0]).toMatchObject({
        user_id: 1,
        purpose: 'signup',
        attempts: 0,
      });
    });
  });

  describe('checking a code', () => {
    it('accepts the right code once (single use)', async () => {
      const code = await send('login');
      expect(await service.verify(emailHash, 'login', code, at(5))).toEqual({
        ok: true,
        userId: 1,
      });
      expect(
        await service.verify(emailHash, 'login', code, at(6)),
      ).toMatchObject({ ok: false, reason: 'invalid' });
    });

    it('a check-only call leaves the right code usable, and a wrong one still costs a try', async () => {
      const code = await send('password_reset');
      const wrong = code === '000000' ? '000001' : '000000';
      expect(
        await service.verify(emailHash, 'password_reset', code, at(1), {
          consume: false,
        }),
      ).toEqual({ ok: true, userId: 1 });
      for (let i = 0; i < 4; i++) {
        await service.verify(emailHash, 'password_reset', wrong, at(2 + i), {
          consume: false,
        });
      }
      expect(
        await service.verify(emailHash, 'password_reset', code, at(10)),
      ).toEqual({ ok: true, userId: 1 });
    });

    it('only works for its own purpose', async () => {
      const code = await send('login');
      expect(
        await service.verify(emailHash, 'password_reset', code, at(5)),
      ).toMatchObject({ ok: false });
      expect(
        await service.verify(emailHash, 'signup', code, at(5)),
      ).toMatchObject({ ok: false });
      expect(
        await service.verify(emailHash, 'login', code, at(5)),
      ).toMatchObject({ ok: true });
    });

    it('only works for its own address', async () => {
      const code = await send('login');
      const other = service.hashEmail('esi@example.com');
      expect(await service.verify(other, 'login', code, at(5))).toMatchObject({
        ok: false,
        reason: 'invalid',
      });
    });

    it('expires after 10 minutes', async () => {
      const code = await send('signup');
      const ttl = VARIABLES.AUTH_CODE_TTL_MINUTES * 60;
      expect(
        await service.verify(emailHash, 'signup', code, at(ttl + 1)),
      ).toMatchObject({ ok: false, reason: 'invalid' });
    });

    it('works just before it expires', async () => {
      const code = await send('signup');
      const ttl = VARIABLES.AUTH_CODE_TTL_MINUTES * 60;
      expect(
        await service.verify(emailHash, 'signup', code, at(ttl - 1)),
      ).toMatchObject({ ok: true });
    });

    it('replaces the previous code when a new one is issued', async () => {
      const first = await send('login', 0);
      const second = await send('login', 61);
      const rows = await db.query('SELECT 1 FROM "auth_codes"');
      expect(rows.rows).toHaveLength(1);
      if (first !== second) {
        expect(
          await service.verify(emailHash, 'login', first, at(62)),
        ).toMatchObject({ ok: false });
      }
      expect(
        await service.verify(emailHash, 'login', second, at(63)),
      ).toMatchObject({ ok: true });
    });

    it('kills the code on the 5th wrong try, even for the right code afterwards', async () => {
      const code = await send('login');
      const wrong = code === '000000' ? '000001' : '000000';
      const outcomes: CodeCheck[] = [];
      for (let i = 0; i < 5; i++) {
        outcomes.push(
          await service.verify(emailHash, 'login', wrong, at(10 + i)),
        );
      }
      expect(outcomes.map((o) => (o.ok ? 'ok' : o.reason))).toEqual([
        'invalid',
        'invalid',
        'invalid',
        'invalid',
        'locked',
      ]);
      expect(outcomes[4]).toMatchObject({ justLocked: true, userId: 1 });
      expect(outcomes[3]).toMatchObject({ userId: 1 });
      expect(
        await service.verify(emailHash, 'login', code, at(20)),
      ).toMatchObject({ ok: false, reason: 'locked' });
      expect(
        await service.verify(emailHash, 'login', code, at(21)),
      ).not.toHaveProperty('justLocked', true);
    });

    it('gives an address with no account the same answers on the same schedule', async () => {
      // A login code asked for an unknown address: no row, but the counter is kept.
      await send('login', 0, null);
      expect((await db.query('SELECT 1 FROM "auth_codes"')).rows).toHaveLength(
        0,
      );
      const outcomes: CodeCheck[] = [];
      for (let i = 0; i < 6; i++) {
        outcomes.push(
          await service.verify(emailHash, 'login', '123456', at(10 + i)),
        );
      }
      expect(outcomes.map((o) => (o.ok ? 'ok' : o.reason))).toEqual([
        'invalid',
        'invalid',
        'invalid',
        'invalid',
        'locked',
        'locked',
      ]);
      for (const o of outcomes) expect(o).not.toHaveProperty('userId');
      // Once a code would have expired, the same address is back to plain "invalid".
      const ttl = VARIABLES.AUTH_CODE_TTL_MINUTES * 60;
      expect(
        await service.verify(emailHash, 'login', '123456', at(ttl + 5)),
      ).toEqual({ ok: false, reason: 'invalid' });
    });

    it('says invalid for an address that never asked', async () => {
      expect(await service.verify(emailHash, 'login', '123456', at(0))).toEqual(
        { ok: false, reason: 'invalid' },
      );
    });

    it('revokes every code of a user', async () => {
      const code = await send('login');
      await service.revokeAllForUser(1);
      expect(
        await service.verify(emailHash, 'login', code, at(5)),
      ).toMatchObject({ ok: false });
    });
  });

  describe('send limits', () => {
    it('allows one send per 60 seconds and says when the next is allowed', async () => {
      const first = await service.reserveSend(emailHash, 'login', at(0));
      expect(first).toEqual({ allowed: true, resendAvailableAt: at(60) });

      const early = await service.reserveSend(emailHash, 'login', at(30));
      expect(early).toEqual({
        allowed: false,
        resendAvailableAt: at(60),
        retryAfterSeconds: 30,
      });

      expect(
        (await service.reserveSend(emailHash, 'login', at(60))).allowed,
      ).toBe(true);
    });

    it('counts each purpose separately', async () => {
      await service.reserveSend(emailHash, 'login', at(0));
      expect(
        (await service.reserveSend(emailHash, 'signup', at(1))).allowed,
      ).toBe(true);
      expect(
        (await service.reserveSend(emailHash, 'password_reset', at(2))).allowed,
      ).toBe(true);
    });

    it('caps sends at 5 per hour, then reopens when the hour is up', async () => {
      for (let i = 0; i < VARIABLES.AUTH_CODE_MAX_PER_HOUR; i++) {
        expect(
          (await service.reserveSend(emailHash, 'login', at(i * 61))).allowed,
        ).toBe(true);
      }
      const capped = await service.reserveSend(emailHash, 'login', at(5 * 61));
      expect(capped).toMatchObject({
        allowed: false,
        resendAvailableAt: at(3600),
      });
      expect(
        (await service.reserveSend(emailHash, 'login', at(3600))).allowed,
      ).toBe(true);
    });

    it('lets only one of two simultaneous sends through', async () => {
      const results = await Promise.all([
        service.reserveSend(emailHash, 'login', at(0)),
        service.reserveSend(emailHash, 'login', at(0)),
      ]);
      expect(results.filter((r) => r.allowed)).toHaveLength(1);
    });

    it('resets the failed-try counter when a new code is sent', async () => {
      await send('login', 0, null);
      for (let i = 0; i < 5; i++)
        await service.verify(emailHash, 'login', '123456', at(1 + i));
      expect(
        await service.verify(emailHash, 'login', '123456', at(7)),
      ).toMatchObject({ reason: 'locked' });
      await send('login', 61, null);
      expect(
        await service.verify(emailHash, 'login', '123456', at(62)),
      ).toMatchObject({ reason: 'invalid' });
    });

    it('computes the next send from the cooldown or the window, whichever is later', () => {
      expect(AuthCodeService.nextSendAt(undefined, at(0))).toEqual(at(60));
      expect(
        AuthCodeService.nextSendAt(
          {
            window_started_at: at(0),
            sent_in_window: 5,
            last_sent_at: at(300),
          },
          at(310),
        ),
      ).toEqual(at(3600));
      expect(
        AuthCodeService.nextSendAt(
          {
            window_started_at: at(0),
            sent_in_window: 2,
            last_sent_at: at(300),
          },
          at(310),
        ),
      ).toEqual(at(360));
    });
  });

  describe('hourly cleanup', () => {
    it('deletes expired and used codes and idle counters, keeps live ones', async () => {
      await send('login', 0);
      await send('signup', 0);
      const removed = await service.purgeExpired(at(30 * 60));
      expect(removed).toBe(0);
      expect(await service.purgeExpired(at(3 * 3600))).toBe(4);
      expect((await db.query('SELECT 1 FROM "auth_codes"')).rows).toHaveLength(
        0,
      );
      expect(
        (await db.query('SELECT 1 FROM "auth_code_requests"')).rows,
      ).toHaveLength(0);
    });

    it('never throws from the cron', async () => {
      const broken = new AuthCodeService({
        manager: { query: () => Promise.reject(new Error('down')) },
      } as unknown as Repository<AuthCode>);
      expect(await broken.purgeExpired()).toBe(0);
    });
  });

  describe('the secret', () => {
    it('prefers AUTH_CODE_SECRET, then SESSION_COOKIE_SECRET, then a dev key; production needs one', () => {
      expect(
        resolveAuthCodeKeys({
          AUTH_CODE_SECRET: 'a',
          SESSION_COOKIE_SECRET: 'b',
        } as NodeJS.ProcessEnv).source,
      ).toBe('AUTH_CODE_SECRET');
      expect(
        resolveAuthCodeKeys({ SESSION_COOKIE_SECRET: 'b' } as NodeJS.ProcessEnv)
          .source,
      ).toBe('SESSION_COOKIE_SECRET');
      expect(resolveAuthCodeKeys({} as NodeJS.ProcessEnv).source).toBe(
        'dev-fallback',
      );
      expect(() =>
        resolveAuthCodeKeys({ NODE_ENV: 'production' } as NodeJS.ProcessEnv),
      ).toThrow(/AUTH_CODE_SECRET/);
    });

    it('derives separate code and email keys, never the raw secret', () => {
      const keys = resolveAuthCodeKeys({
        AUTH_CODE_SECRET: 'fictional-secret',
      } as NodeJS.ProcessEnv);
      expect(keys.codeKey.equals(keys.emailKey)).toBe(false);
      expect(keys.codeKey.toString('utf8')).not.toContain('fictional-secret');
    });

    it('warns once at startup unless AUTH_CODE_SECRET is set', () => {
      const warn = jest
        .spyOn(service['logger'], 'warn')
        .mockImplementation(() => undefined);
      service.onModuleInit();
      expect(warn).toHaveBeenCalledTimes(1);
      warn.mockRestore();
    });
  });
});

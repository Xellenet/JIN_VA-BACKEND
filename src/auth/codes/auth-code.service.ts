import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';
import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { Repository } from 'typeorm';
import { VARIABLES } from '@common/constants/variables.constants';
import { normalizeEmail } from '@common/utils/email.util';
import { AuthCode, AuthCodePurpose } from './auth-code.entity';
import { AuthCodeKeys, resolveAuthCodeKeys } from './auth-code-secret';

/** Outcome of asking to send a code. Identical for registered and unknown addresses. */
export type SendReservation =
  | { allowed: true; resendAvailableAt: Date }
  | { allowed: false; resendAvailableAt: Date; retryAfterSeconds: number };

/** Outcome of checking a code. */
export type CodeCheck =
  | { ok: true; userId: number }
  | {
      ok: false;
      /** `invalid`: wrong, expired, used or never issued. `locked`: too many wrong tries. */
      reason: 'invalid' | 'locked';
      /** The account whose real code was tried, when there was one (for the security log). */
      userId?: number;
      /** True on exactly the attempt that used up the last try. */
      justLocked?: boolean;
    };

interface ReservationRow {
  window_started_at: Date | string;
  sent_in_window: number;
  last_sent_at: Date | string;
}

/** TypeORM returns `[rows, rowCount]` for UPDATE/DELETE and `rows` otherwise. */
function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result) && Array.isArray(result[0])) {
    return result[0] as T[];
  }
  return Array.isArray(result) ? (result as T[]) : [];
}

function affectedOf(result: unknown): number {
  return Array.isArray(result) && typeof result[1] === 'number' ? result[1] : 0;
}

/**
 * Auth v2: 6-digit email codes for sign-up, code login and password reset.
 *
 * - Generated with `crypto.randomInt`; stored only as HMAC-SHA-256 over
 *   `purpose:emailHash:code`, so a code is bound to its purpose and address,
 *   and compared in constant time. Never logged, never returned.
 * - 10-minute expiry, single use, and issuing a new one for the same address
 *   and purpose deletes the previous one.
 * - 5 wrong tries kill the code.
 * - Sends are limited per address and purpose: 60 s between sends and 5 per
 *   hour (from the first send of the window). The counters live in
 *   `auth_code_requests` and are kept for every address that asks — with or
 *   without an account — so the 429 is the same either way.
 * - A check against an address with no live code still counts a failed try
 *   on that counter row, so "too many tries" appears after the same number of
 *   attempts whether or not the address has an account.
 */
@Injectable()
export class AuthCodeService implements OnModuleInit {
  private readonly logger = new Logger(AuthCodeService.name);
  private readonly keys: AuthCodeKeys;

  constructor(
    @InjectRepository(AuthCode)
    private readonly codes: Repository<AuthCode>,
  ) {
    this.keys = resolveAuthCodeKeys();
  }

  onModuleInit(): void {
    if (this.keys.source === 'AUTH_CODE_SECRET') return;
    this.logger.warn(
      this.keys.source === 'SESSION_COOKIE_SECRET'
        ? 'AUTH_CODE_SECRET is not set: email codes are keyed from SESSION_COOKIE_SECRET. Set AUTH_CODE_SECRET to keep the two independent.'
        : 'AUTH_CODE_SECRET is not set: email codes use an insecure development key.',
    );
  }

  /** Keyed hash of the normalised address. Lets rows be found without storing it. */
  hashEmail(email: string): string {
    return createHmac('sha256', this.keys.emailKey)
      .update(normalizeEmail(email))
      .digest('hex');
  }

  /** Six digits, uniformly random, leading zeros kept. */
  generateCode(): string {
    const max = 10 ** VARIABLES.AUTH_CODE_LENGTH;
    return String(randomInt(0, max)).padStart(VARIABLES.AUTH_CODE_LENGTH, '0');
  }

  /** HMAC bound to the purpose and the address, so a code is useless anywhere else. */
  hashCode(emailHash: string, purpose: AuthCodePurpose, code: string): string {
    return createHmac('sha256', this.keys.codeKey)
      .update(`${purpose}:${emailHash}:${code}`)
      .digest('hex');
  }

  /** Constant-time comparison of two hex digests. */
  static digestsMatch(a: string, b: string): boolean {
    const left = Buffer.from(a, 'hex');
    const right = Buffer.from(b, 'hex');
    if (left.length !== right.length || left.length === 0) {
      // Still spend one comparison so a length mismatch isn't faster.
      timingSafeEqual(left.length ? left : Buffer.alloc(32), Buffer.alloc(32));
      return false;
    }
    return timingSafeEqual(left, right);
  }

  /**
   * Reserves one send for this address and purpose, if the cooldown and the
   * hourly cap allow it. One atomic upsert, so two simultaneous requests can't
   * both pass. A successful reservation also resets the failed-check counter,
   * because the code it leads to replaces the previous one.
   */
  async reserveSend(
    emailHash: string,
    purpose: AuthCodePurpose,
    now: Date = new Date(),
  ): Promise<SendReservation> {
    const cooldown = VARIABLES.AUTH_CODE_RESEND_COOLDOWN_SECONDS;
    const windowSeconds = 3600;
    const cap = VARIABLES.AUTH_CODE_MAX_PER_HOUR;
    const reserved = rowsOf<ReservationRow>(
      await this.codes.manager.query(
        `INSERT INTO "auth_code_requests" AS r
           ("email_hash", "purpose", "window_started_at", "sent_in_window", "last_sent_at", "failed_checks")
         VALUES ($1, $2, $3, 1, $3, 0)
         ON CONFLICT ("email_hash", "purpose") DO UPDATE SET
           "window_started_at" = CASE
             WHEN r."window_started_at" <= $3::timestamptz - make_interval(secs => $5) THEN $3::timestamptz
             ELSE r."window_started_at" END,
           "sent_in_window" = CASE
             WHEN r."window_started_at" <= $3::timestamptz - make_interval(secs => $5) THEN 1
             ELSE r."sent_in_window" + 1 END,
           "last_sent_at" = $3,
           "failed_checks" = 0
         WHERE r."last_sent_at" <= $3::timestamptz - make_interval(secs => $4)
           AND (r."window_started_at" <= $3::timestamptz - make_interval(secs => $5)
                OR r."sent_in_window" < $6)
         RETURNING "window_started_at", "sent_in_window", "last_sent_at"`,
        [emailHash, purpose, now, cooldown, windowSeconds, cap],
      ),
    );
    if (reserved.length > 0) {
      return {
        allowed: true,
        resendAvailableAt: new Date(now.getTime() + cooldown * 1000),
      };
    }

    const [current] = rowsOf<ReservationRow>(
      await this.codes.manager.query(
        `SELECT "window_started_at", "sent_in_window", "last_sent_at"
           FROM "auth_code_requests" WHERE "email_hash" = $1 AND "purpose" = $2`,
        [emailHash, purpose],
      ),
    );
    const resendAvailableAt = AuthCodeService.nextSendAt(current, now);
    return {
      allowed: false,
      resendAvailableAt,
      retryAfterSeconds: Math.max(
        1,
        Math.ceil((resendAvailableAt.getTime() - now.getTime()) / 1000),
      ),
    };
  }

  /** When the next send is allowed, given a counter row that refused one. */
  static nextSendAt(row: ReservationRow | undefined, now: Date): Date {
    if (!row) {
      return new Date(
        now.getTime() + VARIABLES.AUTH_CODE_RESEND_COOLDOWN_SECONDS * 1000,
      );
    }
    const afterCooldown =
      new Date(row.last_sent_at).getTime() +
      VARIABLES.AUTH_CODE_RESEND_COOLDOWN_SECONDS * 1000;
    const afterWindow =
      Number(row.sent_in_window) >= VARIABLES.AUTH_CODE_MAX_PER_HOUR
        ? new Date(row.window_started_at).getTime() + 3600 * 1000
        : 0;
    return new Date(Math.max(afterCooldown, afterWindow, now.getTime() + 1000));
  }

  /**
   * Generates a code and, for a real account, stores its hash in place of any
   * earlier code for the same address and purpose. For no account (`userId`
   * null) the same generation and hashing run and nothing is written, so the
   * two cases cost the same CPU; the caller sends no mail.
   *
   * @returns The code, for the caller to put in the email. Never log it.
   */
  async issue(
    emailHash: string,
    purpose: AuthCodePurpose,
    userId: number | null,
    now: Date = new Date(),
  ): Promise<string> {
    const code = this.generateCode();
    const codeHash = this.hashCode(emailHash, purpose, code);
    if (userId === null) return code;

    await this.codes.manager.transaction(async (manager) => {
      await manager.query(
        `DELETE FROM "auth_codes" WHERE "email_hash" = $1 AND "purpose" = $2`,
        [emailHash, purpose],
      );
      await manager.query(
        `INSERT INTO "auth_codes" ("user_id", "email_hash", "purpose", "code_hash", "attempts", "expires_at", "created_at")
         VALUES ($1, $2, $3, $4, 0, $5, $6)`,
        [
          userId,
          emailHash,
          purpose,
          codeHash,
          new Date(now.getTime() + VARIABLES.AUTH_CODE_TTL_MINUTES * 60_000),
          now,
        ],
      );
    });
    return code;
  }

  /**
   * Checks a code. Success consumes it (single use) unless `consume` is
   * false. A wrong code uses up one of its 5 tries; the 5th wrong try kills it.
   */
  async verify(
    emailHash: string,
    purpose: AuthCodePurpose,
    code: string,
    now: Date = new Date(),
    { consume = true }: { consume?: boolean } = {},
  ): Promise<CodeCheck> {
    const submitted = this.hashCode(emailHash, purpose, code);
    const max = VARIABLES.AUTH_CODE_MAX_ATTEMPTS;
    const [found] = rowsOf<{
      id: number;
      user_id: number | null;
      code_hash: string;
      attempts: number;
    }>(
      await this.codes.manager.query(
        `SELECT "id", "user_id", "code_hash", "attempts" FROM "auth_codes"
          WHERE "email_hash" = $1 AND "purpose" = $2
            AND "consumed_at" IS NULL AND "expires_at" > $3
          ORDER BY "created_at" DESC, "id" DESC
          LIMIT 1`,
        [emailHash, purpose, now],
      ),
    );

    if (!found)
      return this.countFailedCheckWithoutCode(emailHash, purpose, now);
    const live = {
      id: found.id,
      userId: found.user_id === null ? null : Number(found.user_id),
      codeHash: String(found.code_hash).trim(),
      attempts: Number(found.attempts),
    };

    if (live.attempts >= max) {
      return { ok: false, reason: 'locked', userId: live.userId ?? undefined };
    }

    if (AuthCodeService.digestsMatch(live.codeHash, submitted)) {
      // A check-only call (`POST /auth/password/reset/check`) leaves the code
      // usable; a wrong guess still costs a try below either way.
      if (!consume && live.userId !== null) {
        return { ok: true, userId: live.userId };
      }
      const consumed: unknown = await this.codes.manager.query(
        `UPDATE "auth_codes" SET "consumed_at" = $2
          WHERE "id" = $1 AND "consumed_at" IS NULL AND "attempts" < $3 AND "expires_at" > $2`,
        [live.id, now, max],
      );
      if (affectedOf(consumed) === 1 && live.userId !== null) {
        return { ok: true, userId: live.userId };
      }
      // Lost a race with another request that used or killed it.
      return { ok: false, reason: 'invalid', userId: live.userId ?? undefined };
    }

    const [row] = rowsOf<{ attempts: number }>(
      await this.codes.manager.query(
        `UPDATE "auth_codes" SET "attempts" = "attempts" + 1
          WHERE "id" = $1 AND "consumed_at" IS NULL
          RETURNING "attempts"`,
        [live.id],
      ),
    );
    const attempts = Number(row?.attempts ?? max);
    if (attempts >= max) {
      return {
        ok: false,
        reason: 'locked',
        userId: live.userId ?? undefined,
        justLocked: attempts === max,
      };
    }
    return { ok: false, reason: 'invalid', userId: live.userId ?? undefined };
  }

  /**
   * No live code: an unknown address, or a code that expired or was used.
   * Counts the try against the address's counter row while a code sent to it
   * would still be live, so an address without an account reaches
   * "too many tries" after the same 5 attempts as one with.
   */
  private async countFailedCheckWithoutCode(
    emailHash: string,
    purpose: AuthCodePurpose,
    now: Date,
  ): Promise<CodeCheck> {
    const [row] = rowsOf<{ failed_checks: number }>(
      await this.codes.manager.query(
        `UPDATE "auth_code_requests" SET "failed_checks" = LEAST("failed_checks" + 1, 32000)
          WHERE "email_hash" = $1 AND "purpose" = $2
            AND "last_sent_at" > $3::timestamptz - make_interval(mins => $4)
          RETURNING "failed_checks"`,
        [emailHash, purpose, now, VARIABLES.AUTH_CODE_TTL_MINUTES],
      ),
    );
    if (row && Number(row.failed_checks) >= VARIABLES.AUTH_CODE_MAX_ATTEMPTS) {
      return { ok: false, reason: 'locked' };
    }
    return { ok: false, reason: 'invalid' };
  }

  /** Removes every code of a user (e.g. after a password reset signs them in). */
  async revokeAllForUser(userId: number): Promise<void> {
    await this.codes.manager.query(
      `DELETE FROM "auth_codes" WHERE "user_id" = $1`,
      [userId],
    );
  }

  /**
   * Hourly: deletes codes that expired or were used more than an hour ago,
   * and counter rows idle for more than an hour (their cooldown and window
   * are over, so they hold nothing). Returns how many rows went.
   */
  @Cron(CronExpression.EVERY_HOUR)
  async purgeExpired(now: Date = new Date()): Promise<number> {
    try {
      const codes: unknown = await this.codes.manager.query(
        `DELETE FROM "auth_codes"
          WHERE "expires_at" < $1::timestamptz - interval '1 hour'
             OR "consumed_at" < $1::timestamptz - interval '1 hour'`,
        [now],
      );
      const requests: unknown = await this.codes.manager.query(
        `DELETE FROM "auth_code_requests"
          WHERE "last_sent_at" < $1::timestamptz - interval '1 hour'
            AND "window_started_at" < $1::timestamptz - interval '1 hour'`,
        [now],
      );
      const removed = affectedOf(codes) + affectedOf(requests);
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

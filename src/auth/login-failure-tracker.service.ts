import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { VARIABLES } from '@common/constants/variables.constants';
import { normalizeEmail } from '@common/utils/email.util';

interface Entry {
  count: number;
  firstAt: number;
}

/** Bound on remembered keys, so a spray of addresses can't grow memory without limit. */
const MAX_KEYS = 50_000;

/**
 * Auth v2: counts failed password logins per email and per client IP, so
 * `POST /auth/login` can ask for a Turnstile token after 3 failures (either
 * key) within 15 minutes.
 *
 * Counted for every submitted address, registered or not, so whether the
 * check is asked for says nothing about the account. A successful login
 * clears the email's count; the IP's count only expires, so one valid
 * account can't be used to reset a stuffing run's counter.
 *
 * In memory and per process, like the throttler storage (see
 * `ThrottlingModule`): with several API instances each one counts on its
 * own. The email is kept only as a SHA-256 digest.
 */
@Injectable()
export class LoginFailureTracker {
  private readonly entries = new Map<string, Entry>();

  private static emailKey(email: string): string {
    return `e:${createHash('sha256').update(normalizeEmail(email)).digest('hex')}`;
  }

  private static ipKey(ip: string | null | undefined): string | null {
    return ip ? `i:${ip}` : null;
  }

  private windowMs(): number {
    return VARIABLES.LOGIN_FAILURE_WINDOW_MINUTES * 60_000;
  }

  private read(key: string | null, now: number): number {
    if (!key) return 0;
    const entry = this.entries.get(key);
    if (!entry) return 0;
    if (now - entry.firstAt > this.windowMs()) {
      this.entries.delete(key);
      return 0;
    }
    return entry.count;
  }

  private bump(key: string | null, now: number): void {
    if (!key) return;
    const count = this.read(key, now);
    if (count === 0) {
      if (this.entries.size >= MAX_KEYS) {
        // Oldest insertion first — Map preserves insertion order.
        const oldest: string | undefined = this.entries.keys().next().value as
          | string
          | undefined;
        if (oldest !== undefined) this.entries.delete(oldest);
      }
      this.entries.set(key, { count: 1, firstAt: now });
    } else {
      this.entries.get(key)!.count = count + 1;
    }
  }

  /** True once the email or the IP has reached the failure threshold. */
  requiresChallenge(
    email: string,
    ip: string | null | undefined,
    now: number = Date.now(),
  ): boolean {
    const threshold = VARIABLES.LOGIN_FAILURES_BEFORE_TURNSTILE;
    return (
      this.read(LoginFailureTracker.emailKey(email), now) >= threshold ||
      this.read(LoginFailureTracker.ipKey(ip), now) >= threshold
    );
  }

  recordFailure(
    email: string,
    ip: string | null | undefined,
    now: number = Date.now(),
  ): void {
    this.bump(LoginFailureTracker.emailKey(email), now);
    this.bump(LoginFailureTracker.ipKey(ip), now);
  }

  recordSuccess(email: string): void {
    this.entries.delete(LoginFailureTracker.emailKey(email));
  }
}

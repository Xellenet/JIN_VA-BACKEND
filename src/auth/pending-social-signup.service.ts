import { VARIABLES } from '@common/constants/variables.constants';
import { Role } from '@common/types/enums';
import { Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';

/**
 * A brand-new social user who has completed the provider's consent screen but
 * has not yet picked a role and filled in their details. Nothing about them is
 * in the database until `POST /auth/social/complete` succeeds.
 */
export interface PendingSocialSignup {
  email: string;
  firstname: string;
  lastname: string;
  profilePicture?: string;
  provider: string;
  providerId: string;
  /**
   * The role the signup page's toggle carried through the OAuth `state`, used
   * only to preselect the toggle on the complete-signup page. Absent for a
   * login-page flow, where we genuinely don't know — the user must pick.
   * Only ever CUSTOMER or ARTISAN.
   */
  suggestedRole?: Role;
  createdAt: Date;
}

/**
 * In-memory store of pending social signups, keyed by an opaque random key
 * that travels in the `jinva_pending_signup` httpOnly cookie. Modelled on
 * {@link OAuthStateService}: entries are short-lived, expired ones are treated
 * as absent and swept lazily, and a process restart simply drops them — the
 * user is sent back through Google, which is the same outcome as abandoning
 * the page.
 */
@Injectable()
export class PendingSocialSignupService {
  private readonly entries: Map<string, PendingSocialSignup> = new Map();
  private readonly TTL_MS = VARIABLES.PENDING_SOCIAL_SIGNUP_TTL_MS;

  /** Stores a new pending signup and returns its key. */
  create(data: Omit<PendingSocialSignup, 'createdAt'>): string {
    this.cleanupExpired();

    const key = randomBytes(32).toString('hex');
    this.entries.set(key, { ...data, createdAt: new Date() });
    return key;
  }

  /** Reads a pending signup without consuming it, or `null` if absent/expired. */
  peek(key: string | undefined): PendingSocialSignup | null {
    if (!key) return null;
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (this.isExpired(entry)) {
      this.entries.delete(key);
      return null;
    }
    return entry;
  }

  /**
   * Reads and removes a pending signup in one synchronous step, so two
   * concurrent completions for the same key can never both get it.
   */
  take(key: string | undefined): PendingSocialSignup | null {
    const entry = this.peek(key);
    if (entry && key) this.entries.delete(key);
    return entry;
  }

  /**
   * Puts back an entry taken by {@link take} when account creation then
   * failed for a reason the user can fix (e.g. a phone number already in
   * use), so they can correct it and resubmit. Keeps the original `createdAt`,
   * so a retry never extends the entry's lifetime.
   */
  restore(key: string, entry: PendingSocialSignup): void {
    if (this.isExpired(entry)) return;
    this.entries.set(key, entry);
  }

  /** Removes a pending signup if present. Idempotent. */
  discard(key: string | undefined): void {
    if (key) this.entries.delete(key);
  }

  private isExpired(entry: PendingSocialSignup): boolean {
    return Date.now() - entry.createdAt.getTime() > this.TTL_MS;
  }

  private cleanupExpired(): void {
    for (const [key, entry] of this.entries.entries()) {
      if (this.isExpired(entry)) this.entries.delete(key);
    }
  }
}

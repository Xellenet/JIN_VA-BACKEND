import { VARIABLES } from '@common/constants/variables.constants';
import { Role } from '@common/types/enums';
import { Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';

interface OAuthStateData {
  provider: string;
  /** G9: the intended signup role, embedded alongside the CSRF nonce so it
   * survives the round trip to Google and back. Only ever CUSTOMER or
   * ARTISAN — never persisted/accepted as ADMIN (see AuthService). */
  role?: Role;
  createdAt: Date;
}

@Injectable()
export class OAuthStateService {
  private readonly states: Map<string, OAuthStateData> = new Map();
  private readonly STATE_EXPIRY_MS = VARIABLES.STATE_EXPIRY_MS;

  /**
   * Generates a one-time CSRF state token for the OAuth handshake.
   * @param provider - Social provider name (e.g. `google`).
   * @param role - G9: the signup role selected on the frontend's role toggle,
   *   already normalized to CUSTOMER/ARTISAN by the caller. Omitted for
   *   login-initiated flows with no role context.
   */
  generateState(provider: string, role?: Role): string {
    const state = randomBytes(32).toString('hex');
    this.states.set(state, { provider, role, createdAt: new Date() });

    // Clean up expired states
    this.cleanupExpiredStates();

    return state;
  }

  /**
   * Validates and consumes (one-time use) a CSRF state token.
   * @returns the embedded role data if the state is valid and matches the
   *   provider, or `null` if the state is missing, expired, tampered, or
   *   already consumed (e.g. a replayed/duplicate callback request).
   */
  consumeState(
    state: string | undefined,
    provider: string,
  ): { role?: Role } | null {
    if (!state) {
      return null;
    }

    const stateData = this.states.get(state);

    if (!stateData) {
      return null;
    }

    // Check if state is expired
    const now = new Date();
    if (now.getTime() - stateData.createdAt.getTime() > this.STATE_EXPIRY_MS) {
      this.states.delete(state);
      return null;
    }

    // Check if provider matches
    if (stateData.provider !== provider) {
      return null;
    }

    // State is valid, remove it (one-time use) — a second use of the same
    // state (e.g. a duplicate/replayed callback hit) is rejected.
    this.states.delete(state);
    return { role: stateData.role };
  }

  private cleanupExpiredStates(): void {
    const now = new Date();
    for (const [state, data] of this.states.entries()) {
      if (now.getTime() - data.createdAt.getTime() > this.STATE_EXPIRY_MS) {
        this.states.delete(state);
      }
    }
  }
}

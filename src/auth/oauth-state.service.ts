import { VARIABLES } from '@common/constants/variables.constants';
import { Injectable } from '@nestjs/common';
import { randomBytes } from 'node:crypto';

@Injectable()
export class OAuthStateService {
  private readonly states: Map<string, { provider: string; createdAt: Date }> = new Map();
  private readonly STATE_EXPIRY_MS = VARIABLES.STATE_EXPIRY_MS; 

  generateState(provider: string): string {
    const state = randomBytes(32).toString('hex');
    this.states.set(state, { provider, createdAt: new Date() });
    
    // Clean up expired states
    this.cleanupExpiredStates();
    
    return state;
  }

  validateState(state: string, provider: string): boolean {
    const stateData = this.states.get(state);
    
    if (!stateData) {
      return false;
    }

    // Check if state is expired
    const now = new Date();
    if (now.getTime() - stateData.createdAt.getTime() > this.STATE_EXPIRY_MS) {
      this.states.delete(state);
      return false;
    }

    // Check if provider matches
    if (stateData.provider !== provider) {
      return false;
    }

    // State is valid, remove it (one-time use)
    this.states.delete(state);
    return true;
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
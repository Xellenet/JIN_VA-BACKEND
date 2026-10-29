import { VARIABLES } from '@common/constants/variables.constants';
import { Role } from '@common/types/enums';
import { OAuthStateService } from './oauth-state.service';

describe('OAuthStateService', () => {
  let service: OAuthStateService;

  beforeEach(() => {
    jest.useFakeTimers({ now: new Date('2026-01-01T00:00:00Z') });
    service = new OAuthStateService();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('generates an unguessable 64-char hex state, unique per call', () => {
    const a = service.generateState('google');
    const b = service.generateState('google');

    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });

  it('returns the embedded role for a valid state', () => {
    const state = service.generateState('google', Role.ARTISAN);

    expect(service.consumeState(state, 'google')).toEqual({
      role: Role.ARTISAN,
    });
  });

  it('returns an undefined role for a login-initiated state', () => {
    const state = service.generateState('google');

    expect(service.consumeState(state, 'google')).toEqual({ role: undefined });
  });

  it('is one-time use: a replayed callback is rejected', () => {
    const state = service.generateState('google', Role.CUSTOMER);

    expect(service.consumeState(state, 'google')).not.toBeNull();
    expect(service.consumeState(state, 'google')).toBeNull();
  });

  it.each([undefined, ''])('rejects a missing state (%p)', (state) => {
    expect(service.consumeState(state, 'google')).toBeNull();
  });

  it('rejects a tampered state that was never issued', () => {
    const state = service.generateState('google');
    const tampered = state.slice(0, -1) + (state.endsWith('a') ? 'b' : 'a');

    expect(service.consumeState(tampered, 'google')).toBeNull();
  });

  it('rejects an expired state and does not accept it afterwards', () => {
    const state = service.generateState('google', Role.CUSTOMER);
    jest.advanceTimersByTime(VARIABLES.STATE_EXPIRY_MS + 1);

    expect(service.consumeState(state, 'google')).toBeNull();
    // Rewinding the clock must not resurrect it: the entry was dropped.
    jest.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    expect(service.consumeState(state, 'google')).toBeNull();
  });

  it('still accepts a state right at the expiry boundary', () => {
    const state = service.generateState('google');
    jest.advanceTimersByTime(VARIABLES.STATE_EXPIRY_MS);

    expect(service.consumeState(state, 'google')).not.toBeNull();
  });

  // A provider mismatch is rejected but the state is not burned, so the
  // legitimate callback for the right provider can still complete.
  it('rejects a state presented for a different provider without consuming it', () => {
    const state = service.generateState('google', Role.ARTISAN);

    expect(service.consumeState(state, 'facebook')).toBeNull();
    expect(service.consumeState(state, 'google')).toEqual({
      role: Role.ARTISAN,
    });
  });

  it('prunes expired states when a new one is generated', () => {
    service.generateState('google');
    jest.advanceTimersByTime(VARIABLES.STATE_EXPIRY_MS + 1);
    const fresh = service.generateState('google');

    const states = (service as unknown as { states: Map<string, unknown> })
      .states;
    expect([...states.keys()]).toEqual([fresh]);
  });
});

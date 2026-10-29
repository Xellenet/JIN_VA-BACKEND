import { VARIABLES } from '@common/constants/variables.constants';
import { Role } from '@common/types/enums';
import { PendingSocialSignupService } from './pending-social-signup.service';

describe('PendingSocialSignupService', () => {
  let store: PendingSocialSignupService;

  const PROFILE = {
    email: 'new@example.com',
    firstname: 'Ama',
    lastname: 'Owusu',
    provider: 'google',
    providerId: 'google-id-1',
    suggestedRole: Role.ARTISAN,
  };
  const TTL = VARIABLES.PENDING_SOCIAL_SIGNUP_TTL_MS;

  beforeEach(() => {
    jest.useFakeTimers({ now: new Date('2026-10-19T10:00:00Z') });
    store = new PendingSocialSignupService();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('issues a fresh 64-hex-char key per entry', () => {
    const a = store.create(PROFILE);
    const b = store.create(PROFILE);

    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(b).not.toBe(a);
  });

  it('peek returns the entry with its createdAt and leaves it in place', () => {
    const key = store.create(PROFILE);

    expect(store.peek(key)).toEqual({ ...PROFILE, createdAt: new Date() });
    expect(store.peek(key)).not.toBeNull();
  });

  it.each([undefined, '', 'not-a-key'])('peek/take of %p is null', (key) => {
    expect(store.peek(key)).toBeNull();
    expect(store.take(key)).toBeNull();
  });

  it('take is one-time: the second take of the same key is null', () => {
    const key = store.create(PROFILE);

    expect(store.take(key)).toEqual(expect.objectContaining(PROFILE));
    expect(store.take(key)).toBeNull();
    expect(store.peek(key)).toBeNull();
  });

  it('is live right up to the TTL and absent just after it', () => {
    const key = store.create(PROFILE);

    jest.advanceTimersByTime(TTL);
    expect(store.peek(key)).not.toBeNull();

    jest.advanceTimersByTime(1);
    expect(store.peek(key)).toBeNull();
    expect(store.take(key)).toBeNull();
  });

  it('sweeps expired entries lazily when a new one is created', () => {
    const stale = store.create(PROFILE);
    jest.advanceTimersByTime(TTL + 1);

    store.create(PROFILE);

    const entries = (store as unknown as { entries: Map<string, unknown> })
      .entries;
    expect(entries.has(stale)).toBe(false);
    expect(entries.size).toBe(1);
  });

  it('restore puts a taken entry back without extending its lifetime', () => {
    const key = store.create(PROFILE);
    jest.advanceTimersByTime(TTL - 1000);
    const taken = store.take(key)!;

    store.restore(key, taken);
    expect(store.peek(key)).toBe(taken);

    jest.advanceTimersByTime(1001);
    expect(store.peek(key)).toBeNull();
  });

  it('restore of an already-expired entry is a no-op', () => {
    const key = store.create(PROFILE);
    const taken = store.take(key)!;
    jest.advanceTimersByTime(TTL + 1);

    store.restore(key, taken);

    expect(store.peek(key)).toBeNull();
  });

  it('discard removes the entry and is idempotent', () => {
    const key = store.create(PROFILE);

    store.discard(key);
    expect(store.peek(key)).toBeNull();
    expect(() => store.discard(key)).not.toThrow();
    expect(() => store.discard(undefined)).not.toThrow();
  });
});

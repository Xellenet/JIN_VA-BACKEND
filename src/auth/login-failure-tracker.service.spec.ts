import { VARIABLES } from '@common/constants/variables.constants';
import { LoginFailureTracker } from './login-failure-tracker.service';

describe('LoginFailureTracker', () => {
  const window = VARIABLES.LOGIN_FAILURE_WINDOW_MINUTES * 60_000;

  it('asks for a challenge after 3 failures for one email, from any IP', () => {
    const t = new LoginFailureTracker();
    t.recordFailure('Esi@Example.com', '203.0.113.1', 0);
    t.recordFailure('esi@example.com', '203.0.113.2', 1);
    expect(t.requiresChallenge('esi@example.com', '203.0.113.9', 2)).toBe(
      false,
    );
    t.recordFailure('esi@example.com ', '203.0.113.3', 3);
    expect(t.requiresChallenge('esi@example.com', '203.0.113.9', 4)).toBe(true);
  });

  it('asks for a challenge after 3 failures from one IP, for any email', () => {
    const t = new LoginFailureTracker();
    for (const e of ['a@example.com', 'b@example.com', 'c@example.com']) {
      t.recordFailure(e, '198.51.100.7', 0);
    }
    expect(t.requiresChallenge('d@example.com', '198.51.100.7', 1)).toBe(true);
    expect(t.requiresChallenge('d@example.com', '198.51.100.8', 1)).toBe(false);
  });

  it('forgets failures after the window', () => {
    const t = new LoginFailureTracker();
    for (let i = 0; i < 3; i++) t.recordFailure('esi@example.com', null, i);
    expect(t.requiresChallenge('esi@example.com', null, 10)).toBe(true);
    expect(t.requiresChallenge('esi@example.com', null, window + 10)).toBe(
      false,
    );
  });

  it('a success clears the email but not the IP', () => {
    const t = new LoginFailureTracker();
    for (let i = 0; i < 3; i++)
      t.recordFailure('esi@example.com', '203.0.113.1', i);
    t.recordSuccess('esi@example.com');
    expect(t.requiresChallenge('esi@example.com', null, 5)).toBe(false);
    expect(t.requiresChallenge('esi@example.com', '203.0.113.1', 5)).toBe(true);
  });

  it('stays bounded in memory', () => {
    const t = new LoginFailureTracker();
    for (let i = 0; i < 50_010; i++)
      t.recordFailure(`u${i}@example.com`, null, 0);
    expect(t['entries'].size).toBeLessThanOrEqual(50_000);
  });
});

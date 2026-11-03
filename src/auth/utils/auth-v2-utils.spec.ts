import { VARIABLES } from '@common/constants/variables.constants';
import { responseFloorMs, withMinimumDuration } from './response-floor.util';
import { describeUserAgent } from './user-agent.util';

describe('withMinimumDuration (timing-equal answers)', () => {
  function clock() {
    let t = 0;
    const slept: number[] = [];
    return {
      now: () => t,
      advance: (ms: number) => {
        t += ms;
      },
      sleep: (ms: number) => {
        slept.push(ms);
        t += ms;
        return Promise.resolve();
      },
      slept,
    };
  }

  it('pads a fast path and a slow path to the same total', async () => {
    const fast = clock();
    await withMinimumDuration(
      () => {
        fast.advance(20);
        return Promise.resolve('no account');
      },
      400,
      fast.sleep,
      fast.now,
    );
    const slow = clock();
    await withMinimumDuration(
      () => {
        slow.advance(250);
        return Promise.resolve('account');
      },
      400,
      slow.sleep,
      slow.now,
    );
    expect(fast.now()).toBe(400);
    expect(slow.now()).toBe(400);
  });

  it('pads a rejection too, and rethrows it', async () => {
    const c = clock();
    await expect(
      withMinimumDuration(
        () => {
          c.advance(5);
          return Promise.reject(new Error('limited'));
        },
        400,
        c.sleep,
        c.now,
      ),
    ).rejects.toThrow('limited');
    expect(c.now()).toBe(400);
  });

  it('does not sleep when the work already took longer', async () => {
    const c = clock();
    const out = await withMinimumDuration(
      () => {
        c.advance(500);
        return Promise.resolve(7);
      },
      400,
      c.sleep,
      c.now,
    );
    expect(out).toBe(7);
    expect(c.slept).toEqual([]);
  });

  it('really waits with the default timer', async () => {
    const started = Date.now();
    await withMinimumDuration(() => Promise.resolve(), 30);
    expect(Date.now() - started).toBeGreaterThanOrEqual(25);
  });

  it('reads AUTH_RESPONSE_FLOOR_MS, falling back on anything odd', () => {
    expect(responseFloorMs({} as NodeJS.ProcessEnv)).toBe(
      VARIABLES.AUTH_RESPONSE_FLOOR_MS,
    );
    expect(
      responseFloorMs({ AUTH_RESPONSE_FLOOR_MS: '' } as NodeJS.ProcessEnv),
    ).toBe(VARIABLES.AUTH_RESPONSE_FLOOR_MS);
    expect(
      responseFloorMs({ AUTH_RESPONSE_FLOOR_MS: '0' } as NodeJS.ProcessEnv),
    ).toBe(0);
    expect(
      responseFloorMs({ AUTH_RESPONSE_FLOOR_MS: '250.7' } as NodeJS.ProcessEnv),
    ).toBe(250);
    expect(
      responseFloorMs({ AUTH_RESPONSE_FLOOR_MS: '-1' } as NodeJS.ProcessEnv),
    ).toBe(VARIABLES.AUTH_RESPONSE_FLOOR_MS);
    expect(
      responseFloorMs({ AUTH_RESPONSE_FLOOR_MS: 'soon' } as NodeJS.ProcessEnv),
    ).toBe(VARIABLES.AUTH_RESPONSE_FLOOR_MS);
  });
});

describe('describeUserAgent', () => {
  it.each([
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
      'Chrome on Windows',
    ],
    [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
      'Safari on iPhone',
    ],
    [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) Gecko/20100101 Firefox/131.0',
      'Firefox on macOS',
    ],
    [
      'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36 EdgA/130.0',
      'Edge on Android',
    ],
    [
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 OPR/114.0',
      'Opera on Linux',
    ],
    [
      'Mozilla/5.0 (Linux; Android 13; SM-A515F) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0 Mobile Safari/537.36',
      'Samsung Internet on Android',
    ],
    ['Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)', 'a browser on iPad'],
    ['Mozilla/5.0 (X11; CrOS x86_64 14541.0.0)', 'a browser on ChromeOS'],
    ['curl/8.5.0', 'an unknown device'],
    ['SomeBot Chrome/1.0', 'Chrome'],
  ])('%s → %s', (ua, expected) => {
    expect(describeUserAgent(ua)).toBe(expected);
  });

  it('handles a missing user agent', () => {
    expect(describeUserAgent(undefined)).toBe('an unknown device');
    expect(describeUserAgent(null)).toBe('an unknown device');
    expect(describeUserAgent('')).toBe('an unknown device');
  });
});

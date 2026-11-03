import { PlatformAnalyticsCacheService } from './platform-analytics-cache.service';
import type { AdminAnalyticsService } from './admin-analytics.service';

/**
 * The short-TTL memo used by `GET /admin/analytics/insights`. The existing
 * cron-refreshed `get`/`refresh` are covered by
 * `platform-analytics-cache.service.spec.ts` and are not touched by it.
 */
describe('PlatformAnalyticsCacheService.memo', () => {
  const build = jest.fn();
  const service = () =>
    new PlatformAnalyticsCacheService({
      build,
    } as unknown as AdminAnalyticsService);

  beforeEach(() => build.mockReset());

  it('computes once, then serves the cached value until the TTL passes', async () => {
    const cache = service();
    let t = 1_000;
    const now = () => t;
    const compute = jest
      .fn()
      .mockResolvedValueOnce({ v: 1, degraded: [] })
      .mockResolvedValueOnce({ v: 2, degraded: [] });

    await expect(cache.memo('k', 100, 10, compute, now)).resolves.toEqual({
      v: 1,
      degraded: [],
      cached: false,
    });
    t = 1_099;
    await expect(cache.memo('k', 100, 10, compute, now)).resolves.toEqual({
      v: 1,
      degraded: [],
      cached: true,
    });
    t = 1_100;
    await expect(cache.memo('k', 100, 10, compute, now)).resolves.toEqual({
      v: 2,
      degraded: [],
      cached: false,
    });
    expect(compute).toHaveBeenCalledTimes(2);
    // The cron-refreshed rollups are a separate store.
    expect(build).not.toHaveBeenCalled();
  });

  it('keeps a degraded result only for the shorter TTL', async () => {
    const cache = service();
    let t = 0;
    const now = () => t;
    const compute = jest
      .fn()
      .mockResolvedValueOnce({ degraded: ['speed'] })
      .mockResolvedValueOnce({ degraded: [] });
    await cache.memo('k', 1_000, 10, compute, now);
    t = 9;
    expect((await cache.memo('k', 1_000, 10, compute, now)).cached).toBe(true);
    t = 10;
    const healed = await cache.memo('k', 1_000, 10, compute, now);
    expect(healed).toEqual({ degraded: [], cached: false });
  });

  it('shares one build between concurrent callers', async () => {
    const cache = service();
    let release!: (v: { degraded: string[] }) => void;
    const compute = jest.fn(
      () =>
        new Promise<{ degraded: string[] }>((r) => {
          release = r;
        }),
    );
    const a = cache.memo('k', 1_000, 10, compute);
    const b = cache.memo('k', 1_000, 10, compute);
    release({ degraded: [] });
    await Promise.all([a, b]);
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it('does not cache a failure, and keys are independent', async () => {
    const cache = service();
    const failing = jest.fn().mockRejectedValueOnce(new Error('down'));
    await expect(cache.memo('a', 1_000, 10, failing)).rejects.toThrow('down');
    const ok = jest.fn().mockResolvedValue({ degraded: [] });
    await expect(cache.memo('a', 1_000, 10, ok)).resolves.toMatchObject({
      cached: false,
    });
    await expect(cache.memo('b', 1_000, 10, ok)).resolves.toMatchObject({
      cached: false,
    });
    expect(ok).toHaveBeenCalledTimes(2);
  });
});

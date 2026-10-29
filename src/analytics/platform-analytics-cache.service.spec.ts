import { Test, TestingModule } from '@nestjs/testing';
import { PlatformAnalyticsCacheService } from './platform-analytics-cache.service';
import { AdminAnalyticsService } from './admin-analytics.service';
import { AnalyticsRange } from '@common/types/enums';

/**
 * DC2.4/DC2.5: the cache/cron contract around a *partial* rollup.
 *
 * `build()` no longer throws when one sub-query fails — it returns the
 * sections that worked and names the ones that didn't. That makes two new
 * behaviours load-bearing, and both are the reason `GET /admin/analytics` was
 * silently dead for weeks:
 *
 *  - a degraded rollup must never overwrite a complete cached one, or an
 *    admin's screen loses figures it had a minute ago;
 *  - the per-run summary must state failures, at a level that is not `log`.
 *
 * The four ranges' real SQL is exercised against a live database in
 * `test/analytics-admin-disputes.e2e-spec.ts` — a mocked builder cannot catch
 * a SQL syntax error, which is exactly how this shipped.
 */
describe('PlatformAnalyticsCacheService (DC2.4/DC2.5)', () => {
  const RANGES = [
    AnalyticsRange.LAST_7_DAYS,
    AnalyticsRange.LAST_30_DAYS,
    AnalyticsRange.LAST_90_DAYS,
    AnalyticsRange.LAST_YEAR,
  ];

  let service: PlatformAnalyticsCacheService;
  let logSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  const mockAnalytics = { build: jest.fn() };

  /** A stand-in rollup. `degraded` is the only field these tests care about. */
  const rollup = (
    range: AnalyticsRange,
    degraded: string[] = [],
    generatedAt = '2026-09-09T10:00:00.000Z',
  ) => ({
    range,
    bucket: 'day',
    from: null,
    to: '2026-09-09T10:00:00.000Z',
    generatedAt,
    kpis: degraded.includes('kpis') ? null : { totalUsers: 7 },
    previous: null,
    series: { userGrowth: [], bookingVolume: [], revenue: [] },
    topServiceCategories: [],
    topArtisans: degraded.includes('topArtisans') ? null : [],
    disputes: null,
    degraded,
  });

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PlatformAnalyticsCacheService,
        { provide: AdminAnalyticsService, useValue: mockAnalytics },
      ],
    }).compile();

    service = module.get(PlatformAnalyticsCacheService);
    jest.clearAllMocks();
    logSpy = jest.spyOn(service['logger'], 'log').mockImplementation();
    warnSpy = jest.spyOn(service['logger'], 'warn').mockImplementation();
    errorSpy = jest.spyOn(service['logger'], 'error').mockImplementation();
  });

  const summaryFrom = (spy: jest.SpyInstance): string | undefined =>
    spy.mock.calls
      .map(([msg]) => String(msg))
      .find((msg) => msg.startsWith('Platform analytics refresh:'));

  // ─── DC2.5: a cold start caches every range ─────────────────────────────────

  it('caches all four ranges on a cold start, so the first call is served from cache', async () => {
    mockAnalytics.build.mockImplementation((r: AnalyticsRange) =>
      Promise.resolve(rollup(r)),
    );

    await service.onModuleInit();

    expect(mockAnalytics.build).toHaveBeenCalledTimes(4);
    for (const range of RANGES) {
      const served = await service.get(range);
      expect(served.cached).toBe(true);
      expect(served.range).toBe(range);
    }
    // Nothing recomputed on the read path once the cron has landed.
    expect(mockAnalytics.build).toHaveBeenCalledTimes(4);
    expect(summaryFrom(logSpy)).toBe(
      'Platform analytics refresh: ranges=4 cached=4 degraded=0 failed=0',
    );
  });

  it('computes on demand and marks it live when a range has not been cached yet', async () => {
    mockAnalytics.build.mockResolvedValueOnce(
      rollup(AnalyticsRange.LAST_30_DAYS),
    );

    const served = await service.get(AnalyticsRange.LAST_30_DAYS);

    expect(served.cached).toBe(false);
    // …and it is now cached, so the next read does not rebuild.
    const again = await service.get(AnalyticsRange.LAST_30_DAYS);
    expect(again.cached).toBe(true);
    expect(mockAnalytics.build).toHaveBeenCalledTimes(1);
  });

  // ─── DC2.5: the failure mode stops being silent ─────────────────────────────

  it('reports a total failure at error level, not as an informational success', async () => {
    mockAnalytics.build.mockRejectedValue(new Error('boom'));

    await service.refresh();

    expect(summaryFrom(logSpy)).toBeUndefined();
    expect(summaryFrom(errorSpy)).toBe(
      'Platform analytics refresh: ranges=4 cached=0 degraded=0 failed=4 ' +
        'failedRanges=7d,30d,90d,1y',
    );
  });

  it('names the degraded range and its sections, above log level', async () => {
    mockAnalytics.build.mockImplementation((r: AnalyticsRange) =>
      Promise.resolve(
        r === AnalyticsRange.LAST_90_DAYS
          ? rollup(r, ['topArtisans'])
          : rollup(r),
      ),
    );

    await service.refresh();

    expect(summaryFrom(logSpy)).toBeUndefined();
    expect(summaryFrom(warnSpy)).toBe(
      'Platform analytics refresh: ranges=4 cached=4 degraded=1 failed=0 ' +
        'degradedRanges=90d(topArtisans)',
    );
  });

  // ─── DC2.4: a degraded rollup must not displace a complete one ──────────────

  it('keeps serving the previous complete rollup rather than replacing it with a degraded one', async () => {
    mockAnalytics.build.mockImplementation((r: AnalyticsRange) =>
      Promise.resolve(rollup(r, [], '2026-09-09T10:00:00.000Z')),
    );
    await service.refresh();

    // The next tick loses topArtisans for 30d.
    mockAnalytics.build.mockImplementation((r: AnalyticsRange) =>
      Promise.resolve(
        r === AnalyticsRange.LAST_30_DAYS
          ? rollup(r, ['topArtisans'], '2026-09-09T10:10:00.000Z')
          : rollup(r, [], '2026-09-09T10:10:00.000Z'),
      ),
    );
    await service.refresh();

    const served = await service.get(AnalyticsRange.LAST_30_DAYS);
    // The good rollup is still there, with its own honest generatedAt — not
    // overwritten by the partial one.
    expect(served.degraded).toEqual([]);
    expect(served.topArtisans).not.toBeNull();
    expect(served.generatedAt).toBe('2026-09-09T10:00:00.000Z');

    // And the hold-back is stated in the summary, not silent.
    expect(summaryFrom(warnSpy)).toContain('keptPreviousGoodRollupFor=30d');
  });

  it('stores a degraded rollup when nothing better is cached — a partial answer beats a 500', async () => {
    mockAnalytics.build.mockImplementation((r: AnalyticsRange) =>
      Promise.resolve(rollup(r, ['kpis'])),
    );

    await service.refresh();
    const served = await service.get(AnalyticsRange.LAST_7_DAYS);

    expect(served.cached).toBe(true);
    expect(served.degraded).toEqual(['kpis']);
    // The guardrail: an unavailable section is null, never a zero.
    expect(served.kpis).toBeNull();
    expect(summaryFrom(warnSpy)).toContain('cached=4 degraded=4 failed=0');
  });

  it('replaces a degraded entry once the next tick recovers it', async () => {
    mockAnalytics.build.mockImplementation((r: AnalyticsRange) =>
      Promise.resolve(rollup(r, ['topArtisans'])),
    );
    await service.refresh();
    expect((await service.get(AnalyticsRange.LAST_YEAR)).degraded).toEqual([
      'topArtisans',
    ]);

    mockAnalytics.build.mockImplementation((r: AnalyticsRange) =>
      Promise.resolve(rollup(r)),
    );
    await service.refresh();

    expect((await service.get(AnalyticsRange.LAST_YEAR)).degraded).toEqual([]);
  });
});

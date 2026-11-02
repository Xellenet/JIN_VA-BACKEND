import { AnalyticsBucket, AnalyticsRange } from '@common/types/enums';
import { resolveWindow } from './analytics.util';
import { fillEarningsSeries } from './artisan-analytics.service';

const NOW = new Date('2026-10-31T10:00:00.000Z');

describe('artisan analytics: 12m window and zero-filled series (B3)', () => {
  it('12m starts on the 1st of the month 11 months ago, monthly', () => {
    const w = resolveWindow(AnalyticsRange.LAST_12_MONTHS, NOW);
    expect(w.from?.toISOString()).toBe('2025-11-01T00:00:00.000Z');
    expect(w.bucket).toBe(AnalyticsBucket.MONTH);
    expect(w.previous?.from.toISOString()).toBe('2024-11-01T00:00:00.000Z');
  });

  it('fills every month with string money', () => {
    const w = resolveWindow(AnalyticsRange.LAST_12_MONTHS, NOW);
    const filled = fillEarningsSeries(
      [{ bucket: '2026-10-01T00:00:00.000Z', earnings: 1080, payouts: 2 }],
      w,
    );
    expect(filled).toHaveLength(12);
    expect(filled[0]).toEqual({
      bucketStart: '2025-11-01',
      net: '0.00',
      payouts: 0,
    });
    expect(filled[11]).toEqual({
      bucketStart: '2026-10-01',
      net: '1080.00',
      payouts: 2,
    });
  });

  it('fills days for 7d and Monday weeks for 90d', () => {
    const days = fillEarningsSeries(
      [],
      resolveWindow(AnalyticsRange.LAST_7_DAYS, NOW),
    );
    expect(days).toHaveLength(8);
    expect(days[7].bucketStart).toBe('2026-10-31');
    const weeks = fillEarningsSeries(
      [{ bucket: '2026-10-26T00:00:00.000Z', earnings: 5.5, payouts: 1 }],
      resolveWindow(AnalyticsRange.LAST_90_DAYS, NOW),
    );
    expect(weeks.every((p) => new Date(p.bucketStart).getUTCDay() === 1)).toBe(
      true,
    );
    expect(weeks[weeks.length - 1]).toEqual({
      bucketStart: '2026-10-26',
      net: '5.50',
      payouts: 1,
    });
  });

  it('starts "all" at the first payout, empty with none', () => {
    const w = resolveWindow(AnalyticsRange.ALL_TIME, NOW);
    expect(fillEarningsSeries([], w)).toEqual([]);
    const filled = fillEarningsSeries(
      [{ bucket: '2026-08-01T00:00:00.000Z', earnings: 10, payouts: 1 }],
      w,
    );
    expect(filled.map((p) => p.bucketStart)).toEqual([
      '2026-08-01',
      '2026-09-01',
      '2026-10-01',
    ]);
  });
});

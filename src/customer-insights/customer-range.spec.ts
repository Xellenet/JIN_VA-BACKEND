import {
  isoDate,
  monthBucketsBetween,
  resolveCustomerWindow,
  startOfIsoWeek,
} from './customer-range';

const NOW = new Date('2026-10-30T12:00:00.000Z'); // a Friday

describe('resolveCustomerWindow', () => {
  it('BU-4.5 30d: 30 daily buckets ending today, previous 30 days before', () => {
    const w = resolveCustomerWindow('30d', NOW);
    expect(w.bucket).toBe('day');
    expect(w.buckets).toHaveLength(30);
    expect(w.buckets[0]).toBe('2026-10-01');
    expect(w.buckets[29]).toBe('2026-10-30');
    expect(w.from?.toISOString()).toBe('2026-10-01T00:00:00.000Z');
    expect(w.to).toBe(NOW);
    expect(w.previous?.from.toISOString()).toBe('2026-09-01T00:00:00.000Z');
    expect(w.previous?.to.toISOString()).toBe('2026-10-01T00:00:00.000Z');
  });

  it('BU-4.5 90d: Monday weeks covering the window', () => {
    const w = resolveCustomerWindow('90d', NOW);
    expect(w.bucket).toBe('week');
    expect(w.from?.toISOString()).toBe('2026-08-02T00:00:00.000Z');
    expect(w.buckets[0]).toBe('2026-07-27');
    expect(w.buckets[w.buckets.length - 1]).toBe('2026-10-26');
    expect(w.buckets).toHaveLength(14);
    for (const b of w.buckets) {
      expect(new Date(`${b}T00:00:00Z`).getUTCDay()).toBe(1);
    }
    expect(w.previous?.from.toISOString()).toBe('2026-05-04T00:00:00.000Z');
  });

  it('BU-4.5 12m: Nov 2025 to Oct 2026, previous is the 12 months before', () => {
    const w = resolveCustomerWindow('12m', NOW);
    expect(w.bucket).toBe('month');
    expect(w.buckets).toHaveLength(12);
    expect(w.buckets[0]).toBe('2025-11-01');
    expect(w.buckets[11]).toBe('2026-10-01');
    expect(w.previous?.from.toISOString()).toBe('2024-11-01T00:00:00.000Z');
    expect(w.previous?.to.toISOString()).toBe('2025-11-01T00:00:00.000Z');
  });

  it('BU-4.5 all: no start, no previous, buckets come from the first payment', () => {
    const w = resolveCustomerWindow('all', NOW);
    expect(w).toMatchObject({
      from: null,
      previous: null,
      bucket: 'month',
      buckets: [],
    });
    expect(monthBucketsBetween(new Date('2025-12-15T00:00:00Z'), NOW)).toEqual([
      '2025-12-01',
      '2026-01-01',
      '2026-02-01',
      '2026-03-01',
      '2026-04-01',
      '2026-05-01',
      '2026-06-01',
      '2026-07-01',
      '2026-08-01',
      '2026-09-01',
      '2026-10-01',
    ]);
  });

  it('defaults an unknown value to all and uses the real clock when none is given', () => {
    expect(resolveCustomerWindow('x' as never, NOW).range).toBe('all');
    expect(resolveCustomerWindow('30d').to.getTime()).toBeLessThanOrEqual(
      Date.now(),
    );
  });

  it('BU-4.16 Accra is UTC: 23:30Z on 31 Oct is still 31 Oct', () => {
    expect(isoDate(new Date('2026-10-31T23:30:00Z'))).toBe('2026-10-31');
    expect(isoDate(startOfIsoWeek(new Date('2026-11-01T23:30:00Z')))).toBe(
      '2026-10-26',
    );
  });

  it('handles year boundaries', () => {
    const w = resolveCustomerWindow('12m', new Date('2026-01-05T00:00:00Z'));
    expect(w.buckets[0]).toBe('2025-02-01');
    expect(w.buckets[11]).toBe('2026-01-01');
  });
});

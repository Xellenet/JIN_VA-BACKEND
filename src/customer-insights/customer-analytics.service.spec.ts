import {
  CustomerAnalyticsService,
  mapArtisans,
  mapCategories,
  mapChannels,
  MAX_ARTISANS,
} from './customer-analytics.service';
import { qbMock } from './testing/qb-mock';

const NOW = new Date('2026-10-30T12:00:00.000Z');

/** A SpendService double whose `counted()` hands out one qb per aggregate. */
function build(
  rows: {
    categories?: unknown[];
    artisans?: unknown[];
    channels?: unknown[];
    largest?: unknown;
    totals?: Partial<{
      grossCents: number;
      refundedCents: number;
      netCents: number;
      releasedCents: number;
      count: number;
    }>;
    byBucket?: Map<string, { cents: number; count: number }>;
    previous?: number;
    first?: Date | null;
  } = {},
) {
  const qbs = [
    qbMock({ getRawMany: rows.categories ?? [] }),
    qbMock({ getRawMany: rows.artisans ?? [] }),
    qbMock({ getRawMany: rows.channels ?? [] }),
    qbMock({ getRawOne: rows.largest }),
  ];
  let i = 0;
  const spend = {
    counted: jest.fn(() => qbs[i++ % 4]),
    totals: jest.fn().mockResolvedValue({
      grossCents: 0,
      refundedCents: 0,
      netCents: 0,
      releasedCents: 0,
      count: 0,
      ...rows.totals,
    }),
    heldCents: jest.fn().mockResolvedValue(65000),
    hasPaymentsEver: jest.fn().mockResolvedValue(true),
    netByBucket: jest.fn().mockResolvedValue(rows.byBucket ?? new Map()),
    netCentsBetween: jest.fn().mockResolvedValue(rows.previous ?? 0),
    firstPaymentDate: jest.fn().mockResolvedValue(rows.first ?? null),
  };
  return { service: new CustomerAnalyticsService(spend as never), spend, qbs };
}

describe('CustomerAnalyticsService', () => {
  it('BU-4.1 / BU-4.3 maps the shared totals; average is net / count', async () => {
    const { service } = build({
      totals: {
        grossCents: 180000,
        refundedCents: 30000,
        netCents: 150000,
        releasedCents: 100000,
        count: 3,
      },
    });
    const d = await service.build(1, '30d', NOW);
    expect(d.totals).toEqual({
      netSpent: '1500.00',
      grossPaid: '1800.00',
      refunded: '300.00',
      held: '650.00',
      released: '1000.00',
      paymentsCount: 3,
      avgPayment: '500.00',
      previousPeriodNetSpent: '0.00',
    });
    expect(d.series).toHaveLength(30);
    expect(d.period).toEqual({
      from: '2026-10-01T00:00:00.000Z',
      to: NOW.toISOString(),
    });
  });

  it('BU-4.5 fills every bucket from the server, zeros included', async () => {
    const { service } = build({
      byBucket: new Map([['2026-10-01', { cents: 184000, count: 2 }]]),
    });
    const d = await service.build(1, '12m', NOW);
    expect(d.series).toHaveLength(12);
    expect(d.series[0]).toEqual({
      bucketStart: '2025-11-01',
      netSpent: '0.00',
      count: 0,
    });
    expect(d.series[11]).toEqual({
      bucketStart: '2026-10-01',
      netSpent: '1840.00',
      count: 2,
    });
  });

  it('BU-4.7 previous period is the same length before; null for all', async () => {
    const { service, spend } = build({ previous: 930000 });
    const d = await service.build(1, '12m', NOW);
    expect(d.totals.previousPeriodNetSpent).toBe('9300.00');
    expect(spend.netCentsBetween).toHaveBeenCalledWith(
      1,
      new Date('2024-11-01T00:00:00Z'),
      new Date('2025-11-01T00:00:00Z'),
    );
    const all = await build({
      first: new Date('2026-08-12T00:00:00Z'),
    }).service.build(1, 'all', NOW);
    expect(all.totals.previousPeriodNetSpent).toBeNull();
    expect(all.series.map((s) => s.bucketStart)).toEqual([
      '2026-08-01',
      '2026-09-01',
      '2026-10-01',
    ]);
    const never = await build({ first: null }).service.build(1, 'all', NOW);
    expect(never.series).toEqual([]);
  });

  it('BU-4.11 maps the largest payment, or null', async () => {
    const { service } = build({
      largest: {
        id: '4471',
        jobId: '790',
        jobTitle: 'Rewire 3-bedroom flat',
        amount: '2400',
        paidAt: '2026-08-12T14:05:00Z',
      },
    });
    const d = await service.build(1, '12m', NOW);
    expect(d.largestPayment).toEqual({
      id: 4471,
      jobId: 790,
      jobTitle: 'Rewire 3-bedroom flat',
      amount: '2400.00',
      paidAt: '2026-08-12T14:05:00.000Z',
    });
    expect(
      (await build().service.build(1, '12m', NOW)).largestPayment,
    ).toBeNull();
  });

  it('BU-4.11 orders the largest by amount, then most recent date, then id', async () => {
    const { service, qbs } = build();
    await service.build(1, '12m', NOW);
    const largest = qbs[3];
    expect(largest.orderBy).toHaveBeenCalledWith('p.amount', 'DESC');
    expect(largest.addOrderBy).toHaveBeenNthCalledWith(
      1,
      'COALESCE(p.paid_at, p.created_at)',
      'DESC',
    );
  });

  it('BU-4.12 caches per user and range for 60 s', async () => {
    const { service, spend } = build();
    await service.getSpending(1, '12m', NOW);
    await service.getSpending(1, '12m', NOW);
    expect(spend.totals).toHaveBeenCalledTimes(1);
    await service.getSpending(2, '12m', NOW);
    await service.getSpending(1, '30d', NOW);
    expect(spend.totals).toHaveBeenCalledTimes(3);
  });

  it('every aggregate is built from the owner-scoped counted() query', async () => {
    const { service, spend } = build();
    await service.build(77, '90d', NOW);
    expect(spend.counted).toHaveBeenCalledTimes(4);
    for (const call of spend.counted.mock.calls as unknown as unknown[][])
      expect(call[0]).toBe(77);
  });
});

describe('aggregate mappers', () => {
  it('BU-4.8 top 6 categories plus one "Other"; shares sum to 1', () => {
    const rows = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({
      serviceId: n,
      serviceName: `Service ${n}`,
      net: String(n * 100),
      count: '1',
    }));
    const total = rows.reduce((s, r) => s + Number(r.net) * 100, 0);
    const out = mapCategories(rows, total);
    expect(out).toHaveLength(7);
    expect(out[0]).toMatchObject({ serviceId: 8, netSpent: '800.00' });
    expect(out[6]).toEqual({
      serviceId: null,
      serviceName: 'Other',
      netSpent: '300.00',
      count: 2,
      share: 0.083,
    });
    expect(
      Math.abs(out.reduce((s, r) => s + r.share, 0) - 1),
    ).toBeLessThanOrEqual(0.002);
  });

  it('no "Other" when six or fewer, a missing service is "Other", zero net gives zero shares', () => {
    const out = mapCategories(
      [{ serviceId: null, serviceName: null, net: '0', count: 1 }],
      0,
    );
    expect(out).toEqual([
      {
        serviceId: null,
        serviceName: 'Other',
        netSpent: '0.00',
        count: 1,
        share: 0,
      },
    ]);
  });

  it('BU-4.9 / BU-4.8 artisans: deleted are "Former artisan", capped at 50, sorted by net then recency', () => {
    const rows = Array.from({ length: 55 }, (_, i) => ({
      artisanProfileId: i + 1,
      businessName: null,
      firstname: 'Kofi',
      lastname: `Asante ${i}`,
      avatar: null,
      artisanGone: i === 0,
      net: i < 2 ? '500' : '10',
      jobs: '2',
      lastPaidAt: new Date(Date.UTC(2026, 9, i < 2 ? 1 + i : 1)),
    }));
    const out = mapArtisans(rows);
    expect(out).toHaveLength(MAX_ARTISANS);
    expect(out[0].artisanProfileId).toBe(2); // same net, more recent
    expect(out[1]).toEqual({
      artisanProfileId: null,
      displayName: 'Former artisan',
      avatar: null,
      netSpent: '500.00',
      count: 2,
      lastPaidAt: '2026-10-01T00:00:00.000Z',
    });
  });

  it('BU-4.10 channels fold bank_transfer into bank and null into other', () => {
    const out = mapChannels(
      [
        { channel: 'mobile_money', net: '900', count: '3' },
        { channel: 'card', net: '500', count: '1' },
        { channel: 'bank', net: '100', count: 1 },
        { channel: 'bank_transfer', net: '100', count: 1 },
        { channel: null, net: '50', count: 1 },
      ],
      165000,
    );
    expect(out).toEqual([
      { channel: 'mobile_money', netSpent: '900.00', count: 3, share: 0.545 },
      { channel: 'card', netSpent: '500.00', count: 1, share: 0.303 },
      { channel: 'bank', netSpent: '200.00', count: 2, share: 0.121 },
      { channel: 'other', netSpent: '50.00', count: 1, share: 0.03 },
    ]);
  });
});

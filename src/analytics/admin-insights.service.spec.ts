import type { DataSource } from 'typeorm';
import {
  AdminInsightsService,
  INSIGHT_SECTIONS,
} from './admin-insights.service';
import { AnalyticsRange } from '@common/types/enums';

/**
 * Unit tests for the row → figure mapping of each section, with the database
 * mocked. The SQL itself (and the exact numbers on a seeded dataset) is
 * covered by `test/admin-insights.e2e-spec.ts` against a real Postgres.
 *
 * The mock answers by matching a fragment of each query, and feeds the edge
 * cases a real table can produce: NULL groups, unknown values, a folded
 * "Other" row, and sample sizes either side of the minimum.
 */
type Rows = Array<Record<string, unknown>>;

function serviceWith(answer: (sql: string, params: unknown[]) => Rows) {
  const query = jest.fn((sql: string, params: unknown[]) =>
    Promise.resolve(answer(sql, params)),
  );
  return {
    service: new AdminInsightsService({ query } as unknown as DataSource),
    query,
  };
}

const NOW = new Date('2001-06-30T12:00:00.000Z');

/** Rows for every query, keyed on a fragment unique to that query. */
const FIXTURES: Array<[string, Rows]> = [
  [
    'WITH posted AS',
    [{ posted: '0', applied: '0', hired: '0', started: '0', completed: '0' }],
  ],
  [
    'GROUP BY metric',
    [
      { metric: 'firstApplication', n: '7', median: '2.5', p90: '9' },
      { metric: 'payout', n: '2', median: '1', p90: '2' },
    ],
  ],
  [
    'COUNT(j.id) AS jobs',
    [
      {
        id: 1,
        name: 'Fictional Plumbing',
        is_active: true,
        jobs: '4',
        hired: '1',
      },
    ],
  ],
  [
    'COUNT(DISTINCT ap.id) AS artisans',
    [
      { id: 1, name: 'Fictional Plumbing', is_active: true, artisans: '1' },
      { id: 2, name: 'Fictional Masonry', is_active: false, artisans: '3' },
    ],
  ],
  [
    'WITH k AS',
    [
      { area: 'accra', jobs: '3', areas: '1' },
      { area: null, jobs: '5', areas: '7' },
    ],
  ],
  [
    'AS refunded_count',
    [{ gross: '0', net: '0', refunded: '0', paid: '0', refunded_count: '0' }],
  ],
  ['ORDER BY SUM(p.amount) DESC', []],
  [
    'GROUP BY actor',
    [
      { actor: 'client', n: '2' },
      { actor: 'robot', n: '1' },
      { actor: 'unrecorded', n: '1' },
    ],
  ],
  [
    "COUNT(*) FILTER (WHERE j.status IN ('COMPLETED', 'CANCELLED', 'EXPIRED'))",
    [{ terminal: '4', cancelled: '4' }],
  ],
  [
    'GROUP BY c.status, c.method_type',
    [
      { status: 'succeeded', method_type: 'card', n: '3' },
      { status: 'pending', method_type: null, n: '1' },
      { status: 'duplicate', method_type: 'mobile_money', n: '1' },
    ],
  ],
  [
    'GROUP BY p.status, p.payout_hold_reason',
    [
      { status: 'PENDING_TRANSFER', reason: null, n: '2', amount: '20' },
      {
        status: 'PENDING_TRANSFER',
        reason: 'payout_check_pending',
        n: '2',
        amount: '30',
      },
      { status: 'TRANSFER_FAILED', reason: null, n: '1', amount: '10.10' },
      { status: 'TRANSFER_FAILED', reason: null, n: '1', amount: '0.20' },
    ],
  ],
  [
    'GROUP BY c.refund_status',
    [{ refund_status: null, n: '1', amount: '50', refunded: '0' }],
  ],
  [
    'GROUP BY m.type, m.network',
    [
      { type: 'mobile_money', network: null, n: '1' },
      { type: 'mobile_money', network: 'ATL', n: '3' },
      { type: 'card', network: null, n: '2' },
    ],
  ],
  ['AS with_method', [{ customers: '0', with_method: '0' }]],
  [
    'AS suspended_now',
    [{ disputes: '2', completed_jobs: '0', oldest_pending_hours: '-3' }],
  ],
  ['GROUP BY d.category', [{ category: null, n: '2' }]],
  ['GROUP BY d.outcome', [{ outcome: null, n: '1' }]],
  ['GROUP BY m.action', [{ action: null, n: '1' }]],
  ['GROUP BY e.event', [{ event: null, n: '1' }]],
  ['AS fully', [{ total: '0' }]],
  [
    'percentile_cont(0.25)',
    [{ n: '6', q1: '10', median: '20.5', q3: '30', min: '1', max: '99.999' }],
  ],
  ['AS withdrawn', [{ total: '0' }]],
  ['AS repeat_pairs', [{}]],
  [
    'WITH cohort AS',
    [
      { cohort: '2001-06', off: -1, n: '2' },
      { cohort: '2001-06', off: 0, n: '1' },
    ],
  ],
  [
    'AS star',
    [
      { star: 5, n: '2', total: '10' },
      { star: 9, n: '1', total: '4' },
    ],
  ],
  [
    'AS average',
    [
      { bucket: new Date('2001-06-06T00:00:00Z'), average: '4.333', n: '3' },
      { bucket: '2001-06-07T00:00:00Z', average: null, n: '0' },
    ],
  ],
  ['AS reviewed', []],
];

function fixtureAnswer(sql: string): Rows {
  const hit = FIXTURES.find(([frag]) => sql.includes(frag));
  if (!hit) throw new Error(`no fixture for query: ${sql.slice(0, 80)}`);
  return hit[1];
}

describe('AdminInsightsService', () => {
  it('runs a fixed, small number of queries for all nine sections', async () => {
    const { service, query } = serviceWith(fixtureAnswer);
    const out = await service.build(AnalyticsRange.LAST_30_DAYS, NOW);
    expect(out.degraded).toEqual([]);
    expect(query).toHaveBeenCalledTimes(27);
    // Every query is parameterised with the window, never string-built from it.
    for (const [sql] of query.mock.calls) {
      expect(sql).not.toContain('2001-');
    }
    expect(out.from).toBe('2001-05-31T12:00:00.000Z');
  });

  it('maps edge-case rows honestly', async () => {
    const { service } = serviceWith(fixtureAnswer);
    const out = await service.build(AnalyticsRange.LAST_30_DAYS, NOW);

    expect(out.funnel!.overallConversion).toBeNull();
    expect(out.speed!.firstApplication).toEqual({
      n: 7,
      medianHours: 2.5,
      p90Hours: 9,
    });
    expect(out.speed!.payout.medianHours).toBeNull();
    expect(out.speed!.hire).toEqual({
      n: 0,
      medianHours: null,
      p90Hours: null,
    });

    // A service with supply but no demand still appears, after those with demand.
    expect(out.marketplace!.byService).toEqual([
      expect.objectContaining({
        serviceName: 'Fictional Plumbing',
        jobs: 4,
        artisans: 1,
        demandPerArtisan: 4,
        flag: 'few_artisans',
      }),
      expect.objectContaining({
        serviceName: 'Fictional Masonry',
        isActive: false,
        jobs: 0,
        artisans: 3,
        demandPerArtisan: 0,
        flag: null,
      }),
    ]);
    expect(out.marketplace!.byArea).toEqual({
      top: [{ area: 'accra', jobs: 3, share: 37.5 }],
      other: { jobs: 5, areas: 7, share: 62.5 },
      totalJobs: 8,
    });

    expect(out.economics!.averageJobValue).toBeNull();
    expect(out.economics!.takeRate).toBeNull();
    expect(out.economics!.cancellation.byActor).toEqual({
      client: 2,
      artisan: 0,
      admin: 0,
      system: 0,
      unknown: 1,
      unrecorded: 1,
    });

    const p = out.payments!;
    expect(p.attempts).toMatchObject({
      total: 5,
      succeeded: 3,
      inProgress: 1,
      duplicate: 1,
      successRate: 100,
    });
    expect(p.methodMix.map((m) => m.method)).toEqual([
      'card',
      'mobile_money',
      'unknown',
    ]);
    expect(p.payoutsOnHold).toEqual([
      { reason: 'no_payout_method', count: 2, amount: '20.00' },
      { reason: 'payout_check_pending', count: 2, amount: '30.00' },
    ]);
    expect(p.transferFailed).toEqual({ count: 2, amount: '10.30' });
    expect(p.duplicateRefunds.byRefundStatus[0].refundStatus).toBe(
      'not_started',
    );
    expect(p.savedMethods).toMatchObject({
      mobileMoney: 4,
      card: 2,
      momoNetworks: [
        { network: 'ATL', count: 3, share: 75 },
        { network: 'unknown', count: 1, share: 25 },
      ],
      adoptionRate: null,
    });

    const t = out.trust!;
    expect(t.disputes.per100CompletedJobs).toBeNull();
    expect(t.disputes.byCategory).toEqual([{ key: 'UNCATEGORISED', count: 2 }]);
    expect(t.disputes.byOutcome).toEqual([{ key: 'NONE_RECORDED', count: 1 }]);
    expect(t.verifications.approvalRate).toBeNull();
    // A clock skew can't make an age negative.
    expect(t.verifications.oldestPendingHours).toBe(0);
    expect(t.moderationActions).toEqual([{ key: 'UNKNOWN', count: 1 }]);
    expect(t.securityEvents).toEqual([{ key: 'unknown', count: 1 }]);

    expect(out.artisans!.earnings).toEqual({
      n: 6,
      q1: '10.00',
      median: '20.50',
      q3: '30.00',
      min: '1.00',
      max: '100.00',
    });
    expect(out.artisans!.bookingResponse.responseRate).toBeNull();

    expect(out.retention!.repeatClientRate).toBeNull();
    expect(out.retention!.cohorts[5]).toEqual({
      cohort: '2001-06',
      size: 2,
      months: [50, null, null, null, null, null],
    });

    const r = out.reviews!;
    // An out-of-range star is counted in the total but not in a bar.
    expect(r.count).toBe(3);
    expect(r.distribution[4]).toEqual({ star: 5, count: 2 });
    expect(r.averageRating).toBe(4.67);
    expect(r.trend).toEqual([
      { bucket: '2001-06-06T00:00:00.000Z', averageRating: 4.33, count: 3 },
      { bucket: '2001-06-07T00:00:00Z', averageRating: null, count: 0 },
    ]);
    expect(r.reviewRate).toBeNull();
  });

  it('degrades every section independently when every query fails', async () => {
    const { service } = serviceWith(() => {
      throw new Error('fictional outage');
    });
    const out = await service.build(AnalyticsRange.LAST_7_DAYS, NOW);
    expect(out.degraded).toEqual([...INSIGHT_SECTIONS]);
    for (const s of INSIGHT_SECTIONS) expect(out[s]).toBeNull();
  });

  it('degrades only the section whose query failed, and logs a non-Error reason', async () => {
    const { service } = serviceWith((sql) => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      if (sql.includes('GROUP BY metric')) throw 'plain string failure';
      return fixtureAnswer(sql);
    });
    const out = await service.build(AnalyticsRange.LAST_YEAR, NOW);
    expect(out.degraded).toEqual(['speed']);
    expect(out.speed).toBeNull();
    expect(out.funnel).not.toBeNull();
    expect(out.bucket).toBe('month');
  });
});

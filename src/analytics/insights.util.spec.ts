import {
  COHORT_MONTHS,
  FEW_ARTISANS_RATIO,
  MIN_SAMPLE,
  averageMoney,
  buildCohorts,
  durationStat,
  funnelSteps,
  moneyStr,
  monthKey,
  monthStartUtc,
  per100,
  percentileCont,
  rate,
  ratio,
  round,
  supplyFlag,
} from './insights.util';

describe('insights.util', () => {
  describe('durationStat (median / p90 with a minimum sample)', () => {
    it(`withholds both figures below ${MIN_SAMPLE} observations`, () => {
      for (const n of [0, 1, 4]) {
        expect(durationStat({ n: String(n), median: 3, p90: 9 })).toEqual({
          n,
          medianHours: null,
          p90Hours: null,
        });
      }
    });

    it('shows them from exactly the minimum, rounded to 2 decimals', () => {
      expect(
        durationStat({ n: '5', median: '3.14159', p90: 7.600000000000001 }),
      ).toEqual({ n: 5, medianHours: 3.14, p90Hours: 7.6 });
    });

    it('treats an empty table (no row, null percentiles) as no data', () => {
      expect(durationStat({})).toEqual({
        n: 0,
        medianHours: null,
        p90Hours: null,
      });
      expect(durationStat({ n: 9, median: null, p90: null })).toEqual({
        n: 9,
        medianHours: null,
        p90Hours: null,
      });
    });
  });

  describe('percentileCont matches Postgres percentile_cont', () => {
    it('interpolates between ranks', () => {
      expect(percentileCont([1, 2, 3, 4, 10], 0.5)).toBe(3);
      expect(percentileCont([10, 4, 3, 2, 1], 0.9)).toBeCloseTo(7.6, 10);
      expect(percentileCont([1, 2], 0.5)).toBe(1.5);
      expect(percentileCont([5], 0.9)).toBe(5);
    });

    it('is null for no values, and does not reorder the input', () => {
      expect(percentileCont([], 0.5)).toBeNull();
      const input = [3, 1, 2];
      percentileCont(input, 0.5);
      expect(input).toEqual([3, 1, 2]);
    });
  });

  describe('rates never divide by zero', () => {
    it('rate is a 1-decimal %, or null for a 0 denominator', () => {
      expect(rate(1, 3)).toBe(33.3);
      expect(rate(2, 3)).toBe(66.7);
      expect(rate(0, 5)).toBe(0);
      expect(rate(5, 0)).toBeNull();
      expect(rate(0, 0)).toBeNull();
      expect(rate(1, -1)).toBeNull();
      expect(rate(1, Number.NaN)).toBeNull();
    });

    it('per100 and ratio', () => {
      expect(per100(3, 3)).toBe(100);
      expect(per100(1, 0)).toBeNull();
      expect(ratio(6, 2)).toBe(3);
      expect(ratio(1, 3)).toBe(0.33);
      expect(ratio(4, 0)).toBeNull();
    });

    it('round never gives -0', () => {
      expect(Object.is(round(-0.0001), 0)).toBe(true);
      expect(round(1.005, 1)).toBe(1);
    });
  });

  describe('money is a 2-decimal string', () => {
    it('moneyStr', () => {
      expect(moneyStr('750')).toBe('750.00');
      expect(moneyStr(0.1 + 0.2)).toBe('0.30');
      expect(moneyStr(null)).toBe('0.00');
      expect(moneyStr('not a number')).toBe('0.00');
    });

    it('averageMoney is null with nothing to average', () => {
      expect(averageMoney('750', 4)).toBe('187.50');
      expect(averageMoney('750', 0)).toBeNull();
      expect(averageMoney(null, 0)).toBeNull();
    });
  });

  it('funnelSteps adds step-to-step conversion, null for the first and after a 0 step', () => {
    expect(
      funnelSteps([
        ['posted', 8],
        ['applied', 5],
        ['hired', 0],
        ['completed', 0],
      ]),
    ).toEqual([
      { key: 'posted', count: 8, conversionFromPrevious: null },
      { key: 'applied', count: 5, conversionFromPrevious: 62.5 },
      { key: 'hired', count: 0, conversionFromPrevious: 0 },
      { key: 'completed', count: 0, conversionFromPrevious: null },
    ]);
  });

  it('supplyFlag', () => {
    expect(supplyFlag(0, 0)).toBeNull();
    expect(supplyFlag(2, 0)).toBe('no_artisans');
    expect(supplyFlag(FEW_ARTISANS_RATIO * 2, 2)).toBe('few_artisans');
    expect(supplyFlag(5, 2)).toBeNull();
  });

  describe('cohorts', () => {
    const to = new Date('2001-06-30T12:00:00Z');

    it('month helpers work in UTC and across a year boundary', () => {
      expect(monthKey(monthStartUtc(to))).toBe('2001-06');
      expect(monthKey(monthStartUtc(to, 5))).toBe('2001-01');
      expect(monthKey(monthStartUtc(new Date('2001-02-01T00:00:00Z'), 3))).toBe(
        '2000-11',
      );
    });

    it('lists every month, nulls months that have not started and empty cohorts', () => {
      const rows = buildCohorts(
        to,
        [
          { cohort: '2001-04', n: 2 },
          { cohort: '2001-06', n: 4 },
        ],
        [
          { cohort: '2001-04', offset: 1, n: 1 },
          { cohort: '2001-04', offset: 2, n: 2 },
          { cohort: '2001-06', offset: 0, n: 4 },
        ],
      );
      expect(rows).toHaveLength(COHORT_MONTHS);
      expect(rows.map((r) => r.cohort)).toEqual([
        '2001-01',
        '2001-02',
        '2001-03',
        '2001-04',
        '2001-05',
        '2001-06',
      ]);
      expect(rows[0].months).toEqual([null, null, null, null, null, null]);
      expect(rows[3]).toEqual({
        cohort: '2001-04',
        size: 2,
        months: [0, 50, 100, null, null, null],
      });
      expect(rows[5].months).toEqual([100, null, null, null, null, null]);
    });

    it('is all empty on an empty database', () => {
      const rows = buildCohorts(to, [], []);
      expect(rows.every((r) => r.size === 0)).toBe(true);
      expect(rows.every((r) => r.months.every((m) => m === null))).toBe(true);
    });
  });
});

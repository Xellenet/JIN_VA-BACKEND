import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Logger } from '@nestjs/common';
import { PaymentStatus } from '@common/types/enums';
import { qbMock, QbMock } from '../customer-insights/testing/qb-mock';
import {
  ARTISAN_CSV_HEADER,
  ARTISAN_EXPORT_MAX_ROWS,
  artisanCsvRow,
  ArtisanEarningsService,
  artisanStageLabel,
  mapStatementRow,
  StatementRawRow,
} from './artisan-earnings.service';

const NOW = new Date('2026-10-31T10:00:00.000Z');

const raw = (over: Partial<StatementRawRow> = {}): StatementRawRow => ({
  id: '311',
  jobId: '77',
  jobTitle: 'Fix kitchen sink',
  clientFirstname: 'Ama',
  clientLastname: 'Mensah',
  clientGone: false,
  amount: '600.00',
  platformFee: '60.00',
  artisanAmount: '540.00',
  refundedAmount: '0',
  status: PaymentStatus.RELEASED,
  transferStarted: true,
  transferReference: 'TRF-77-1',
  paidAt: '2026-10-20T10:00:00.000Z',
  releasedAt: new Date('2026-10-22T09:00:00.000Z'),
  createdAt: '2026-10-19T16:30:00.000Z',
  earnedAt: '2026-10-22T09:00:00.000Z',
  ...over,
});

/**
 * Builds the service with one fresh query builder per `createQueryBuilder`
 * call, answered in order from `queue` (later calls reuse the last entry).
 */
function build(queue: QbMock[], profile: unknown = { id: '7' }) {
  const made: QbMock[] = [];
  let i = 0;
  const payments = {
    createQueryBuilder: jest.fn(() => {
      const qb = queue[Math.min(i++, queue.length - 1)];
      made.push(qb);
      return qb;
    }),
  };
  const profiles = {
    createQueryBuilder: jest.fn(() =>
      qbMock({ getRawOne: profile ?? undefined }),
    ),
  };
  const security = { recordBestEffort: jest.fn().mockResolvedValue(undefined) };
  const service = new ArtisanEarningsService(
    payments as never,
    profiles as never,
    security as never,
  );
  return { service, payments, security, made };
}

function sink() {
  const out: string[] = [];
  return {
    out,
    headers: {} as Record<string, string>,
    setHeader: jest.fn(function (
      this: { headers: Record<string, string> },
      n: string,
      v: string,
    ) {
      this.headers[n] = v;
    }),
    status: jest.fn(),
    write: jest.fn((c: string) => out.push(c)),
    end: jest.fn(),
  };
}

describe('ArtisanEarningsService (B2)', () => {
  beforeAll(() => jest.spyOn(Logger.prototype, 'error').mockImplementation());
  afterAll(() => jest.restoreAllMocks());

  describe('mapping', () => {
    it('maps a paid row with gross, fee, payout and no internals', () => {
      const item = mapStatementRow(raw());
      expect(item).toEqual({
        paymentId: 311,
        jobId: 77,
        jobTitle: 'Fix kitchen sink',
        clientName: 'Ama Mensah',
        gross: '600.00',
        fee: '60.00',
        net: '540.00',
        refunded: '0.00',
        payout: '540.00',
        status: PaymentStatus.RELEASED,
        stage: 'paid',
        transferReference: 'TRF-77-1',
        failureReason: null,
        holdReason: null,
        paidAt: '2026-10-20T10:00:00.000Z',
        releasedAt: '2026-10-22T09:00:00.000Z',
        createdAt: '2026-10-19T16:30:00.000Z',
        date: '2026-10-22T09:00:00.000Z',
      });
      expect(Object.keys(item)).not.toContain('transferCode');
    });

    it('shows no payout for refunded or unpaid rows, and why money is stuck', () => {
      expect(
        mapStatementRow(raw({ status: PaymentStatus.REFUNDED })).payout,
      ).toBeNull();
      expect(
        mapStatementRow(
          raw({ status: PaymentStatus.PENDING, paidAt: null, jobTitle: null }),
        ),
      ).toMatchObject({ payout: null, paidAt: null, jobTitle: null });
      expect(
        mapStatementRow(
          raw({
            status: PaymentStatus.PENDING_TRANSFER,
            transferReference: null,
            releasedAt: null,
          }),
        ),
      ).toMatchObject({
        stage: 'needs_action',
        failureReason: 'no_payout_method',
        transferReference: null,
        releasedAt: null,
      });
    });

    it('writes a formula-safe CSV line', () => {
      const line = artisanCsvRow(
        mapStatementRow(
          raw({ jobTitle: '=HYPERLINK("x")', clientFirstname: '+Ama' }),
        ),
      );
      expect(line).toBe(
        `2026-10-22 09:00,"'=HYPERLINK(""x"")",'+Ama Mensah,Paid,600.00,60.00,540.00,0.00,TRF-77-1,2026-10-20 10:00,2026-10-22 09:00,\r\n`,
      );
      expect(ARTISAN_CSV_HEADER).toHaveLength(12);
      expect(ARTISAN_CSV_HEADER[11]).toBe('Payout on hold');
    });

    it.each([
      ['payout_name_mismatch', "Payout account name doesn't match"],
      ['payout_account_not_found', 'Payout account not found'],
      ['payout_check_pending', 'Checking your payout account'],
    ] as const)(
      'exposes a %s hold on a needs-action row and in the CSV',
      (holdReason, label) => {
        const item = mapStatementRow(
          raw({
            status: PaymentStatus.PENDING_TRANSFER,
            holdReason,
            transferReference: null,
            releasedAt: null,
          }),
        );
        expect(item).toMatchObject({
          stage: 'needs_action',
          failureReason: 'no_payout_method',
          holdReason,
        });
        expect(artisanCsvRow(item).trimEnd().endsWith(`,${label}`)).toBe(true);
      },
    );

    it('ignores a hold reason on a row that is no longer held, or an unknown one', () => {
      expect(
        mapStatementRow(
          raw({
            status: PaymentStatus.RELEASED,
            holdReason: 'payout_name_mismatch',
          }),
        ).holdReason,
      ).toBeNull();
      expect(
        mapStatementRow(
          raw({ status: PaymentStatus.PENDING_TRANSFER, holdReason: 'other' }),
        ).holdReason,
      ).toBeNull();
    });

    it.each([
      ['awaiting_payment', 'Client has not paid yet'],
      ['held', 'Paid by client, waiting for sign-off'],
      ['on_the_way', 'On its way'],
      ['needs_action', 'Needs your action'],
      ['paid', 'Paid'],
      ['refunded', 'Refunded to client'],
      ['not_paid', 'Not paid'],
    ] as const)('labels %s', (stage, label) => {
      expect(artisanStageLabel(stage)).toBe(label);
      expect(label.toLowerCase()).not.toMatch(/escrow|withheld/);
    });
  });

  describe('getStatement', () => {
    it('returns summary, balances, zero-filled months and a page, all owner-bound', async () => {
      const summary = qbMock({
        getRawOne: {
          gross: '1200',
          fee: '120',
          net: '1080',
          jobs: '2',
          paid: '540',
          refunded: '90',
          refundedCount: '1',
        },
      });
      const balances = qbMock({
        getRawOne: {
          held: '10',
          onTheWay: 0,
          needsAction: 0,
          needsActionCount: 0,
          paidThisMonth: '540',
        },
      });
      const months = qbMock({
        getRawMany: [
          { month: '2026-10', gross: '1200', fee: '120', net: '1080', jobs: 2 },
        ],
      });
      const count = qbMock({ getCount: 21 });
      const rows = qbMock({ getRawMany: [raw()] });
      const { service, made } = build([summary, balances, months, count, rows]);

      const res = await service.getStatement(
        5,
        { period: '90d', stage: ['paid'], page: 2, limit: 20 },
        NOW,
      );

      expect(res.pagination).toEqual({
        page: 2,
        limit: 20,
        total: 21,
        totalPages: 2,
      });
      expect(res.data.summary).toEqual({
        gross: '1200.00',
        fee: '120.00',
        net: '1080.00',
        jobs: 2,
        paid: '540.00',
        refunded: '90.00',
        refundedCount: 1,
      });
      expect(res.data.balances.paidThisMonth).toBe('540.00');
      expect(res.data.months.map((m) => m.month)).toEqual([
        '2026-08',
        '2026-09',
        '2026-10',
      ]);
      expect(res.data.months[0]).toEqual({
        month: '2026-08',
        gross: '0.00',
        fee: '0.00',
        net: '0.00',
        jobs: 0,
      });
      expect(res.data.months[2].net).toBe('1080.00');
      expect(res.data.items).toHaveLength(1);
      expect(res.data.period).toEqual({
        key: '90d',
        from: '2026-08-03T00:00:00.000Z',
        to: NOW.toISOString(),
      });
      for (const qb of made) {
        const p = qb.params();
        expect(p.profileId ?? p.artisanProfileId).toBe(7);
      }
      // The stage filter narrows the list only, not the totals.
      expect(count.params()).toMatchObject({ stages: ['paid'] });
      expect(rows.params()).toMatchObject({ stages: ['paid'] });
      expect(summary.params()).not.toHaveProperty('stages');
      expect(rows.offset).toHaveBeenCalledWith(20);
    });

    it('defaults to 12m, page 1 of 20; "all" months start at the first payment', async () => {
      const { service } = build([qbMock({ getRawOne: undefined })]);
      const res = await service.getStatement(5, {}, NOW);
      expect(res.data.period.key).toBe('12m');
      expect(res.data.months).toHaveLength(12);
      expect(res.pagination).toMatchObject({ page: 1, limit: 20, total: 0 });

      const empty = build([qbMock()]);
      const all = await empty.service.getStatement(5, { period: 'all' }, NOW);
      expect(all.data.months).toEqual([]);
      expect(all.data.period.from).toBeNull();

      const some = build([
        qbMock(),
        qbMock(),
        qbMock({
          getRawMany: [
            { month: '2026-09', gross: '1', fee: '0', net: '1', jobs: 1 },
          ],
        }),
        qbMock(),
      ]);
      const res2 = await some.service.getStatement(5, { period: 'all' }, NOW);
      expect(res2.data.months.map((m) => m.month)).toEqual([
        '2026-09',
        '2026-10',
      ]);
    });

    it('is 404 without an artisan profile', async () => {
      const { service } = build([qbMock()], null);
      await expect(service.getStatement(5, {}, NOW)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('streamExport', () => {
    it('refuses before streaming when over the row cap', async () => {
      const { service } = build([
        qbMock({ getCount: ARTISAN_EXPORT_MAX_ROWS + 1 }),
      ]);
      const s = sink();
      await expect(
        service.streamExport(5, {}, s as never, {}, NOW),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(s.write).not.toHaveBeenCalled();
    });

    it('streams the CSV with BOM and headers and records the export', async () => {
      const { service, security } = build([
        qbMock({ getCount: 1 }),
        qbMock({
          getRawMany: [{ ...raw(), sortKey: '2026-10-22 09:00:00+00' }],
        }),
      ]);
      const s = sink();
      const n = await service.streamExport(
        5,
        { period: '30d', stage: ['paid'] },
        s as never,
        { ip: '203.0.113.1', userAgent: 'UA' },
        NOW,
      );
      expect(n).toBe(1);
      expect(s.status).toHaveBeenCalledWith(200);
      expect(s.setHeader).toHaveBeenCalledWith(
        'Content-Disposition',
        'attachment; filename="jinva-earnings-2026-10-31.csv"',
      );
      expect(s.out[0].startsWith('\ufeffDate,Job,Client')).toBe(true);
      expect(s.out[1]).toContain('Fix kitchen sink');
      expect(security.recordBestEffort).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 5,
          event: 'spending_report.exported',
          details: {
            report: 'artisan_earnings',
            range: '30d',
            statuses: ['paid'],
            rowCount: 1,
          },
        }),
      );
      expect(s.end).toHaveBeenCalled();
    });

    it('pages in keyset batches until a short batch', async () => {
      const full = Array.from({ length: 500 }, (_, k) => ({
        ...raw({ id: String(1000 - k) }),
        sortKey: '2026-10-22 09:00:00+00',
      }));
      const second = qbMock({ getRawMany: [{ ...raw(), sortKey: 'x' }] });
      const { service } = build([
        qbMock({ getCount: 501 }),
        qbMock({ getRawMany: full }),
        second,
      ]);
      const s = sink();
      await expect(
        service.streamExport(5, {}, s as never, {}, NOW),
      ).resolves.toBe(501);
      expect(second.params()).toMatchObject({ afterId: 501 });
    });

    it('ends a truncated file without an audit row when a batch fails', async () => {
      const { service, security } = build([
        qbMock({ getCount: 1 }),
        qbMock({ error: new Error('boom') }),
      ]);
      const s = sink();
      await expect(
        service.streamExport(5, {}, s as never, {}, NOW),
      ).resolves.toBe(0);
      expect(s.end).toHaveBeenCalled();
      expect(security.recordBestEffort).not.toHaveBeenCalled();
    });
  });
});

import { BadRequestException, Logger } from '@nestjs/common';
import { PaymentStatus } from '@common/types/enums';
import {
  csvDateTime,
  csvRow,
  CustomerPaymentHistoryService,
  customerStatusLabel,
  EXPORT_BATCH_SIZE,
  HistoryRawRow,
  mapHistoryRow,
  methodLabel,
} from './customer-payment-history.service';
import {
  qbMock,
  QbMock,
  QbMockResults,
} from '../customer-insights/testing/qb-mock';

const NOW = new Date('2026-10-30T12:00:00.000Z');

const raw = (
  over: Partial<HistoryRawRow> & Record<string, unknown> = {},
): HistoryRawRow =>
  ({
    id: '4471',
    reference: 'JINVA-7F3K2Q',
    jobId: '790',
    jobTitle: 'Rewire 3-bedroom flat',
    bookingId: null,
    serviceId: '5',
    serviceName: 'Electrical',
    artisanProfileId: '57',
    businessName: null,
    firstname: 'Kofi',
    lastname: 'Asante',
    avatar: '/uploads/avatars/57.webp',
    artisanGone: false,
    amount: '2400.00',
    refundedAmount: '0.00',
    currency: 'GHS',
    channel: 'card',
    status: PaymentStatus.RELEASED,
    paidAt: new Date('2026-08-12T14:05:00Z'),
    releasedAt: '2026-08-15T09:00:00Z',
    createdAt: new Date('2026-08-12T14:03:10Z'),
    ...over,
  }) as HistoryRawRow;

function build(results: QbMockResults[]) {
  const qbs: QbMock[] = results.map((r) => qbMock(r));
  let i = 0;
  const repo = {
    createQueryBuilder: jest.fn(() => qbs[Math.min(i++, qbs.length - 1)]),
  };
  const security = { recordBestEffort: jest.fn().mockResolvedValue(undefined) };
  const service = new CustomerPaymentHistoryService(
    repo as never,
    security as never,
  );
  return { service, qbs, security, repo };
}

const sink = () => {
  const out = {
    chunks: [] as string[],
    headers: {} as Record<string, string>,
    code: 0,
    ended: false,
  };
  return {
    out,
    sink: {
      setHeader: (k: string, v: string) => (out.headers[k] = v),
      status: (c: number) => (out.code = c),
      write: (s: string) => out.chunks.push(s),
      end: () => (out.ended = true),
    },
  };
};

describe('mapHistoryRow (BU-4.14)', () => {
  it('returns only the documented keys, with net = amount − refunded', () => {
    const row = mapHistoryRow(
      raw({
        amount: '800',
        refundedAmount: '200',
        platformFee: '80',
        artisanAmount: '720',
        transferCode: 'TRF_x',
        accessCode: 'ACC_x',
        authorizationUrl: 'https://x',
        fraudFlagged: true,
      }),
    );
    expect(Object.keys(row).sort()).toEqual(
      [
        'amount',
        'artisan',
        'bookingId',
        'channel',
        'currency',
        'date',
        'id',
        'job',
        'jobId',
        'netAmount',
        'paidAt',
        'reference',
        'refundedAmount',
        'releasedAt',
        'service',
        'status',
      ].sort(),
    );
    expect(row).toMatchObject({
      id: 4471,
      jobId: 790,
      job: { id: 790, title: 'Rewire 3-bedroom flat' },
      amount: '800.00',
      refundedAmount: '200.00',
      netAmount: '600.00',
      service: { id: 5, name: 'Electrical' },
      artisan: {
        id: 57,
        displayName: 'Kofi Asante',
        avatar: '/uploads/avatars/57.webp',
      },
      paidAt: '2026-08-12T14:05:00.000Z',
      releasedAt: '2026-08-15T09:00:00.000Z',
      date: '2026-08-12T14:03:10.000Z',
    });
  });

  it('handles missing service, booking link, deleted artisan and unpaid rows', () => {
    const row = mapHistoryRow(
      raw({
        serviceId: null,
        serviceName: null,
        bookingId: '12',
        artisanGone: true,
        paidAt: null,
        releasedAt: null,
        refundedAmount: null,
        jobTitle: null,
        channel: null,
      }),
    );
    expect(row).toMatchObject({
      service: { id: null, name: 'Other' },
      bookingId: 12,
      artisan: { id: null, displayName: 'Former artisan', avatar: null },
      paidAt: null,
      releasedAt: null,
      refundedAmount: '0.00',
      job: { title: null },
      channel: null,
    });
  });
});

describe('CSV labels', () => {
  it('uses customer status labels and never "escrow"', () => {
    expect(customerStatusLabel('PENDING')).toBe('Awaiting payment');
    for (const s of ['HELD', 'PENDING_TRANSFER', 'TRANSFER_FAILED'])
      expect(customerStatusLabel(s)).toBe('Withheld');
    expect(customerStatusLabel('RELEASED')).toBe('Paid Out');
    expect(customerStatusLabel('REFUNDED')).toBe('Refunded');
    expect(customerStatusLabel('CANCELLED')).toBe('Cancelled');
    expect(customerStatusLabel('FAILED')).toBe('Failed');
    expect(customerStatusLabel('NEW')).toBe('NEW');
  });

  it('names methods, and an unpaid payment has none yet', () => {
    expect(methodLabel('mobile_money', 'x')).toBe('Mobile money');
    expect(methodLabel('card', 'x')).toBe('Card');
    expect(methodLabel('bank_transfer', 'x')).toBe('Bank');
    expect(methodLabel('bank', 'x')).toBe('Bank');
    expect(methodLabel('ussd', 'x')).toBe('Other');
    expect(methodLabel(null, 'x')).toBe('Other');
    expect(methodLabel(null, null)).toBe('Not paid yet');
  });

  it('writes Accra dates and a formula-safe row', () => {
    expect(csvDateTime(null)).toBe('');
    expect(csvDateTime('2026-08-12T14:05:59Z')).toBe('2026-08-12 14:05');
    const line = csvRow(
      mapHistoryRow(raw({ jobTitle: '=SUM(1+1)', businessName: '@Ace, Ltd' })),
    );
    expect(line).toBe(
      `2026-08-12 14:05,JINVA-7F3K2Q,'=SUM(1+1),Electrical,"'@Ace, Ltd",Card,Paid Out,2400.00,0.00,2400.00,2026-08-15 09:00\r\n`,
    );
  });
});

describe('CustomerPaymentHistoryService', () => {
  afterEach(() => jest.restoreAllMocks());

  it("legacy form keeps today's message and created_at order", async () => {
    const { service, qbs } = build([{ getRawMany: [raw()] }]);
    const res = await service.getLegacyHistory(9);
    expect(res.message).toBe('Payment history retrieved.');
    expect(res.data).toHaveLength(1);
    expect(qbs[0].orderBy).toHaveBeenCalledWith('p.created_at', 'DESC');
    expect(qbs[0].where).toHaveBeenCalledWith('p.customer_id = :me', { me: 9 });
  });

  it('paginated form: newest paid first, offset/limit and pagination meta', async () => {
    const { service, qbs } = build([{ getCount: 45 }, { getRawMany: [raw()] }]);
    const res = await service.getHistoryPage(9, { page: 3, limit: 20 }, NOW);
    expect(res.pagination).toEqual({
      page: 3,
      limit: 20,
      total: 45,
      totalPages: 3,
    });
    expect(qbs[1].orderBy).toHaveBeenCalledWith(
      'COALESCE(p.paid_at, p.created_at)',
      'DESC',
    );
    expect(qbs[1].offset).toHaveBeenCalledWith(40);
    expect(qbs[1].limit).toHaveBeenCalledWith(20);
    const defaults = build([{ getCount: 0 }, { getRawMany: [] }]);
    expect(
      (await defaults.service.getHistoryPage(9, {}, NOW)).pagination,
    ).toEqual({ page: 1, limit: 20, total: 0, totalPages: 0 });
  });

  it('applies every filter as a bound narrowing clause (SEC-3)', () => {
    const { service } = build([{}]);
    const qb = qbMock();
    service.applyFilters(
      qb as never,
      {
        status: [PaymentStatus.HELD],
        range: '30d',
        serviceId: 3,
        artisanProfileId: 57,
        search: '50%_x',
      },
      NOW,
    );
    expect(qb.params()).toMatchObject({
      statuses: ['HELD'],
      rangeFrom: new Date('2026-10-01T00:00:00Z'),
      rangeTo: NOW,
      serviceId: 3,
      artisanProfileId: 57,
    });
    const dated = qbMock();
    service.applyFilters(
      dated as never,
      { from: '2026-01-01', to: '2026-01-31', range: 'all' },
      NOW,
    );
    expect(dated.params()).toMatchObject({
      dateFrom: new Date('2026-01-01T00:00:00Z'),
      dateTo: new Date('2026-02-01T00:00:00Z'),
    });
  });

  it('builds the search with escaped wildcards and ESCAPE', () => {
    const { service } = build([{}]);
    const qb = qbMock();
    service.applyFilters(qb as never, { search: '50%_x' }, NOW);
    const brackets = (qb.andWhere.mock.calls as unknown[][])[0][0] as {
      whereFactory: (w: unknown) => void;
    };
    const inner = qbMock();
    brackets.whereFactory(inner);
    expect(inner.sql()).toContain("j.title ILIKE :searchPattern ESCAPE '\\'");
    expect(inner.sql()).toContain(
      "p.reference ILIKE :searchPattern ESCAPE '\\'",
    );
    expect(inner.params()).toEqual({ searchPattern: '%50\\%\\_x%' });
  });

  it('B3f: distinct services and live artisans', async () => {
    const { service, qbs } = build([
      { getRawMany: [{ id: '5', name: 'Electrical' }] },
      {
        getRawMany: [
          { id: '57', displayName: 'Kofi Asante' },
          { id: 58, displayName: '' },
        ],
      },
    ]);
    const res = await service.getFilterOptions(9);
    expect(res).toEqual({
      message: 'Payment history filters retrieved',
      data: {
        services: [{ id: 5, name: 'Electrical' }],
        artisans: [
          { id: 57, displayName: 'Kofi Asante' },
          { id: 58, displayName: 'Artisan' },
        ],
      },
    });
    expect(qbs[1].sql()).toContain('u.deleted_at IS NULL');
  });

  describe('export (B10)', () => {
    it('refuses a span over 24 months before streaming', async () => {
      const { service } = build([
        { getRawOne: { first: '2023-01-01T00:00:00Z' } },
      ]);
      const err = await service
        .assertExportable(9, {}, NOW)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect((err as BadRequestException).getResponse()).toEqual({
        errorCode: 'EXPORT_RANGE_TOO_LARGE',
        message:
          'Narrow the date range to 24 months or less, then download again.',
      });
    });

    it('refuses more than 10,000 rows', async () => {
      const { service } = build([{ getCount: 10_001 }]);
      const err = await service
        .assertExportable(9, { range: '12m' }, NOW)
        .catch((e: unknown) => e);
      expect((err as BadRequestException).getResponse()).toMatchObject({
        errorCode: 'EXPORT_TOO_MANY_ROWS',
      });
    });

    it('allows an explicit window and a customer with no payments', async () => {
      const explicit = build([{ getCount: 3 }]);
      await expect(
        explicit.service.assertExportable(
          9,
          { from: '2025-01-01', to: '2026-10-30' },
          NOW,
        ),
      ).resolves.toBe(3);
      const empty = build([{ getRawOne: { first: null } }, { getCount: 0 }]);
      await expect(empty.service.assertExportable(9, {}, NOW)).resolves.toBe(0);
    });

    it('streams headers, BOM, rows in keyset batches, then audits flags only', async () => {
      const full = Array.from({ length: EXPORT_BATCH_SIZE }, (_, i) =>
        raw({ id: i + 1, sortKey: `2026-08-12 14:05:00+00` }),
      );
      const { service, qbs, security } = build([
        { getCount: EXPORT_BATCH_SIZE + 1 }, // assertExportable count (range given → no MIN query)
        { getRawMany: full },
        { getRawMany: [raw({ id: 9999 })] },
      ]);
      const { out, sink: s } = sink();
      const count = await service.streamExport(
        9,
        {
          range: '12m',
          status: [PaymentStatus.RELEASED],
          search: 'kitchen',
          serviceId: 3,
        },
        s,
        { ip: '198.51.100.4', userAgent: 'agent' },
        NOW,
      );
      expect(count).toBe(EXPORT_BATCH_SIZE + 1);
      expect(out.code).toBe(200);
      expect(out.headers).toEqual({
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition':
          'attachment; filename="jinva-payments-2026-10-30.csv"',
        'Cache-Control': 'no-store',
      });
      expect(
        out.chunks[0].startsWith(
          '﻿Date paid,Reference,Job,Service,Artisan,Method,Status,Amount (GHS),Refunded (GHS),Net (GHS),Paid to artisan\r\n',
        ),
      ).toBe(true);
      expect(out.ended).toBe(true);
      expect(qbs[2].params()).toMatchObject({
        afterKey: '2026-08-12 14:05:00+00',
        afterId: EXPORT_BATCH_SIZE,
      });
      expect(security.recordBestEffort).toHaveBeenCalledWith({
        userId: 9,
        event: 'spending_report.exported',
        details: {
          range: '12m',
          statuses: ['RELEASED'],
          hasServiceFilter: true,
          hasArtisanFilter: false,
          hasSearch: true,
          hasDateRange: false,
          rowCount: EXPORT_BATCH_SIZE + 1,
        },
        ip: '198.51.100.4',
        userAgent: 'agent',
      });
      expect(
        JSON.stringify(security.recordBestEffort.mock.calls),
      ).not.toContain('kitchen');
    });

    it('an empty export still writes the header and audits zero rows', async () => {
      const { service, security } = build([
        { getCount: 0 },
        { getRawMany: [] },
      ]);
      const { out, sink: s } = sink();
      await service.streamExport(9, { from: '2026-01-01' }, s, {}, NOW);
      expect(out.chunks).toHaveLength(1);
      expect(
        (security.recordBestEffort.mock.calls as unknown[][])[0][0],
      ).toMatchObject({
        ip: null,
        userAgent: null,
        details: { rowCount: 0, hasDateRange: true, range: null, statuses: [] },
      });
    });

    it('a failure mid-stream ends the file, logs without PII and writes no audit row', async () => {
      const log = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation(() => undefined);
      const { service, security } = build([
        { getCount: 1 },
        { error: new Error('connection lost for ama.owusu@example.com') },
      ]);
      const { out, sink: s } = sink();
      await expect(
        service.streamExport(9, { range: '30d' }, s, {}, NOW),
      ).resolves.toBe(0);
      expect(out.ended).toBe(true);
      expect(security.recordBestEffort).not.toHaveBeenCalled();
      expect(JSON.stringify(log.mock.calls)).not.toContain('ama.owusu');
    });

    it('a refusal happens before any header is written', async () => {
      const { service } = build([{ getCount: 10_001 }]);
      const { out, sink: s } = sink();
      await expect(
        service.streamExport(9, { range: '12m' }, s, {}, NOW),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(out.code).toBe(0);
      expect(out.chunks).toHaveLength(0);
    });
  });
});

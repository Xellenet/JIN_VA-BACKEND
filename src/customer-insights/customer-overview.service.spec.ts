import { Logger } from '@nestjs/common';
import {
  artisanRef,
  calendarDate,
  CustomerOverviewService,
  hhmm,
  NextBookingRow,
} from './customer-overview.service';
import { qbMock, QbMockResults } from './testing/qb-mock';

const NOW = new Date('2026-10-30T12:00:00.000Z');

interface Fixture {
  completions?: QbMockResults;
  payments?: QbMockResults;
  applications?: QbMockResults;
  conversations?: QbMockResults;
  bookings?: QbMockResults;
  spend?: Partial<{
    netByBucket: jest.Mock;
    heldCents: jest.Mock;
    hasPaymentsEver: jest.Mock;
  }>;
}

function build(f: Fixture = {}) {
  const qbs = {
    jobs: qbMock(
      f.completions ?? {
        getRawOne: { count: '0', jobs: '0', jobId: null, jobTitle: null },
      },
    ),
    payments: qbMock(f.payments ?? { getRawOne: { count: '0', jobs: '0' } }),
    applications: qbMock(
      f.applications ?? { getRawOne: { count: 0, jobs: 0 } },
    ),
    conversations: qbMock(f.conversations ?? { getRawOne: { count: '0' } }),
    bookings: qbMock(f.bookings ?? { getRawOne: undefined }),
  };
  const repo = (qb: unknown) => ({ createQueryBuilder: jest.fn(() => qb) });
  const spend = {
    netByBucket: jest.fn().mockResolvedValue(new Map()),
    heldCents: jest.fn().mockResolvedValue(0),
    hasPaymentsEver: jest.fn().mockResolvedValue(false),
    ...f.spend,
  };
  const service = new CustomerOverviewService(
    repo(qbs.jobs) as never,
    repo(qbs.applications) as never,
    repo(qbs.payments) as never,
    repo(qbs.bookings) as never,
    repo(qbs.conversations) as never,
    spend as never,
  );
  return { service, qbs, spend };
}

const bookingRow = (over: Partial<NextBookingRow> = {}): NextBookingRow => ({
  id: '301',
  scheduledDate: '2026-11-04',
  startTime: '09:00:00',
  endTime: '11:00:00',
  status: 'CONFIRMED',
  serviceId: '3',
  serviceName: 'Plumbing',
  artisanProfileId: '57',
  businessName: null,
  firstname: 'Kofi',
  lastname: 'Asante',
  avatar: '/uploads/avatars/57.webp',
  artisanGone: false,
  ...over,
});

describe('CustomerOverviewService', () => {
  afterEach(() => jest.restoreAllMocks());

  it('BU-2.1 builds the action items, linking a job only when exactly one is involved', async () => {
    const { service } = build({
      completions: {
        getRawOne: {
          count: '1',
          jobs: '1',
          jobId: 812,
          jobTitle: 'Fix leaking kitchen sink',
        },
      },
      payments: {
        getRawOne: {
          count: '1',
          jobs: '1',
          jobId: '815',
          jobTitle: 'Rewire consumer unit',
        },
      },
      applications: {
        getRawOne: { count: '4', jobs: '2', jobId: 816, jobTitle: 'A' },
      },
      conversations: { getRawOne: { count: '2' } },
    });
    const data = await service.getOverview(9, NOW);
    expect(data.actionItems).toEqual({
      completionsToConfirm: {
        count: 1,
        jobId: 812,
        jobTitle: 'Fix leaking kitchen sink',
      },
      paymentsDue: { count: 1, jobId: 815, jobTitle: 'Rewire consumer unit' },
      applicationsToReview: { count: 4, jobId: null, jobTitle: null },
      unreadMessages: 2,
    });
    expect(data.failedSections).toEqual([]);
  });

  it('BU-2.2 two completions on two jobs give no jobId; four applications on one job link it', async () => {
    const { service } = build({
      completions: {
        getRawOne: { count: 2, jobs: 2, jobId: 1, jobTitle: 'x' },
      },
      applications: {
        getRawOne: { count: 4, jobs: 1, jobId: 77, jobTitle: 'One job' },
      },
    });
    const items = await service.buildActionItems(9);
    expect(items.completionsToConfirm).toEqual({
      count: 2,
      jobId: null,
      jobTitle: null,
    });
    expect(items.applicationsToReview).toEqual({
      count: 4,
      jobId: 77,
      jobTitle: 'One job',
    });
  });

  it('scopes each action query to the caller with a bound parameter (SEC-1)', async () => {
    const { service, qbs } = build();
    await service.buildActionItems(31);
    for (const qb of [
      qbs.jobs,
      qbs.payments,
      qbs.applications,
      qbs.conversations,
    ]) {
      expect(qb.params()).toMatchObject({ me: 31 });
      expect(qb.sql()).not.toMatch(/\b31\b/);
    }
    expect(qbs.jobs.sql()).toContain('completion_requested_at IS NOT NULL');
    expect(qbs.conversations.sql()).toContain(
      'm.sender_id <> :me AND m.is_read = false',
    );
  });

  it('BU-2.3 asks for the earliest upcoming PENDING/CONFIRMED booking against the Accra clock', async () => {
    const { service, qbs } = build({
      bookings: {
        getRawOne: bookingRow({
          status: 'PENDING',
          startTime: '14:00:00',
          endTime: '15:00:00',
          scheduledDate: '2026-10-30',
        }),
      },
    });
    const next = await service.buildNextBooking(9, NOW);
    expect(next).toMatchObject({
      scheduledDate: '2026-10-30',
      startTime: '14:00',
      status: 'PENDING',
    });
    expect(qbs.bookings.params()).toMatchObject({
      upcoming: ['PENDING', 'CONFIRMED'],
      nowLocal: '2026-10-30 12:00:00',
      me: 9,
    });
    expect(qbs.bookings.orderBy).toHaveBeenCalledWith(
      'b.scheduled_date',
      'ASC',
    );
    expect(qbs.bookings.limit).toHaveBeenCalledWith(1);
  });

  it('maps the next booking explicitly', () => {
    expect(CustomerOverviewService.mapNextBooking(bookingRow())).toEqual({
      id: 301,
      scheduledDate: '2026-11-04',
      startTime: '09:00',
      endTime: '11:00',
      status: 'CONFIRMED',
      service: { id: 3, name: 'Plumbing' },
      artisan: {
        id: 57,
        displayName: 'Kofi Asante',
        avatar: '/uploads/avatars/57.webp',
      },
    });
  });

  it('BU-2.4 a booking with no times keeps its date with null times', () => {
    const mapped = CustomerOverviewService.mapNextBooking(
      bookingRow({
        startTime: null,
        endTime: null,
        scheduledDate: new Date('2026-11-04T00:00:00Z'),
        serviceId: null,
      }),
    );
    expect(mapped).toMatchObject({
      scheduledDate: '2026-11-04',
      startTime: null,
      endTime: null,
      service: null,
    });
  });

  it('a deleted artisan is "Former artisan" with no link or avatar', () => {
    expect(
      artisanRef({
        artisanProfileId: 5,
        businessName: 'Ace',
        firstname: 'A',
        lastname: 'B',
        avatar: 'x',
        artisanGone: true,
      }),
    ).toEqual({
      id: null,
      displayName: 'Former artisan',
      avatar: null,
    });
    expect(
      artisanRef({
        artisanProfileId: 5,
        businessName: '  Ace Plumbing ',
        firstname: 'A',
        lastname: 'B',
        avatar: null,
        artisanGone: false,
      }).displayName,
    ).toBe('Ace Plumbing');
    expect(
      artisanRef({
        artisanProfileId: 5,
        businessName: null,
        firstname: null,
        lastname: null,
        avatar: null,
        artisanGone: false,
      }).displayName,
    ).toBe('Artisan');
    expect(hhmm(undefined)).toBeNull();
    expect(calendarDate('2026-11-04T00:00:00')).toBe('2026-11-04');
  });

  it('returns no booking when none is upcoming', async () => {
    const { service } = build();
    expect(await service.buildNextBooking(9, NOW)).toBeNull();
  });

  it('BU-2.5 / BU-2.6 / BU-2.7 spend comes from the shared helper, six months, zeros filled', async () => {
    const netByBucket = jest.fn().mockResolvedValue(
      new Map([
        ['2026-05-01', { cents: 90000, count: 1 }],
        ['2026-09-01', { cents: 142000, count: 2 }],
        ['2026-10-01', { cents: 184000, count: 3 }],
      ]),
    );
    const { service } = build({
      spend: {
        netByBucket,
        heldCents: jest.fn().mockResolvedValue(65000),
        hasPaymentsEver: jest.fn().mockResolvedValue(true),
      },
    });
    const spend = await service.buildSpend(9, NOW);
    expect(netByBucket).toHaveBeenCalledWith(
      9,
      'month',
      new Date('2026-05-01T00:00:00Z'),
      NOW,
    );
    expect(spend).toEqual({
      currency: 'GHS',
      hasPaymentsEver: true,
      thisMonth: '1840.00',
      lastMonth: '1420.00',
      held: '650.00',
      last6Months: [
        { month: '2026-05', netSpent: '900.00' },
        { month: '2026-06', netSpent: '0.00' },
        { month: '2026-07', netSpent: '0.00' },
        { month: '2026-08', netSpent: '0.00' },
        { month: '2026-09', netSpent: '1420.00' },
        { month: '2026-10', netSpent: '1840.00' },
      ],
    });
  });

  it('BU-2.9 a failing section is null and listed; the rest still render; the log has no personal data', async () => {
    const log = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const failing = jest
      .fn()
      .mockRejectedValue(new Error('select failed for ama.owusu@example.com'));
    const { service } = build({
      spend: { netByBucket: failing },
      bookings: { getRawOne: bookingRow() },
    });
    const data = await service.getOverview(9, NOW);
    expect(data.spend).toBeNull();
    expect(data.failedSections).toEqual(['spend']);
    expect(data.actionItems).not.toBeNull();
    expect(data.nextBooking).not.toBeNull();
    const logged = JSON.stringify(log.mock.calls);
    expect(logged).not.toContain('ama.owusu');
    expect(logged).not.toContain('9');
  });

  it('lists every failed section in a stable order', async () => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const boom = new Error('x');
    const { service } = build({
      completions: { error: boom },
      bookings: { error: boom },
      spend: { heldCents: jest.fn().mockRejectedValue(boom) },
    });
    const data = await service.getOverview(9, NOW);
    expect(data).toEqual({
      actionItems: null,
      nextBooking: null,
      spend: null,
      failedSections: ['actionItems', 'nextBooking', 'spend'],
    });
  });

  it('caches a complete answer per user for 30 s, never a partial one', async () => {
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const ok = build();
    await ok.service.getOverview(1, NOW);
    await ok.service.getOverview(1, NOW);
    expect(ok.spend.heldCents).toHaveBeenCalledTimes(1);
    await ok.service.getOverview(2, NOW);
    expect(ok.spend.heldCents).toHaveBeenCalledTimes(2);

    const bad = build({ bookings: { error: new Error('x') } });
    await bad.service.getOverview(1, NOW);
    await bad.service.getOverview(1, NOW);
    expect(bad.spend.heldCents).toHaveBeenCalledTimes(2);
  });
});

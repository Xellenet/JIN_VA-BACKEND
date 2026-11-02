import { Logger, NotFoundException } from '@nestjs/common';
import { BookingStatus } from '@common/types/enums';
import {
  qbMock,
  QbMock,
  QbMockResults,
} from '../customer-insights/testing/qb-mock';
import {
  ArtisanOverviewService,
  BookingRow,
  mapOverviewBooking,
  mapPendingRequest,
} from './artisan-overview.service';

const NOW = new Date('2026-10-31T12:00:00.000Z');

const row = (over: Partial<BookingRow> = {}): BookingRow => ({
  id: '42',
  status: BookingStatus.PENDING,
  scheduledDate: '2026-11-04',
  startTime: '09:00:00',
  endTime: '11:00:00',
  notes: 'Kitchen sink leaking',
  artisanNotes: null,
  createdAt: '2026-10-31T08:00:00.000Z',
  serviceId: '3',
  serviceName: 'Plumbing',
  jobId: null,
  jobLocation: null,
  clientFirstname: 'Ama',
  clientLastname: 'Mensah',
  clientGone: false,
  ...over,
});

interface Fixture {
  jobs?: QbMockResults;
  applications?: QbMockResults;
  bookings?: QbMockResults[];
  payments?: QbMockResults;
  profile?: unknown;
  payout?: QbMockResults;
  disputes?: QbMockResults;
}

function build(f: Fixture = {}) {
  const queue = (list: QbMockResults[]) => {
    let i = 0;
    const made: QbMock[] = [];
    return {
      made,
      createQueryBuilder: jest.fn(() => {
        const qb = qbMock(list[Math.min(i++, list.length - 1)] ?? {});
        made.push(qb);
        return qb;
      }),
    };
  };
  const repos = {
    jobs: queue([
      f.jobs ?? {
        getRawOne: {
          toStart: '1',
          inProgress: '2',
          awaitingClient: '1',
          done: '14',
          closed: '3',
          total: '21',
        },
      },
    ]),
    applications: queue([f.applications ?? { getCount: 4 }]),
    bookings: queue(f.bookings ?? [{}]),
    payments: queue([f.payments ?? {}]),
    profiles: queue([
      { getRawOne: f.profile === undefined ? { id: 7 } : f.profile },
      f.payout ?? { getRawOne: { has: true } },
    ]),
    disputes: queue([f.disputes ?? { getCount: 1 }]),
  };
  const service = new ArtisanOverviewService(
    repos.jobs as never,
    repos.applications as never,
    repos.bookings as never,
    repos.payments as never,
    repos.profiles as never,
    repos.disputes as never,
  );
  return { service, repos };
}

describe('ArtisanOverviewService (B1)', () => {
  beforeAll(() => jest.spyOn(Logger.prototype, 'error').mockImplementation());
  afterAll(() => jest.restoreAllMocks());

  it('maps a pending request with respondBy 24 h after it was made', () => {
    expect(mapPendingRequest(row())).toEqual({
      bookingId: 42,
      clientName: 'Ama Mensah',
      service: { id: 3, name: 'Plumbing' },
      scheduledDate: '2026-11-04',
      startTime: '09:00',
      endTime: '11:00',
      location: null,
      notes: 'Kitchen sink leaking',
      createdAt: '2026-10-31T08:00:00.000Z',
      respondBy: '2026-11-01T08:00:00.000Z',
    });
  });

  it('maps a confirmed booking with its job, location and a gone client', () => {
    expect(
      mapOverviewBooking(
        row({
          status: BookingStatus.CONFIRMED,
          jobId: '77',
          jobLocation: '12 Ring Road, Accra',
          serviceId: null,
          notes: null,
          clientGone: true,
        }),
      ),
    ).toMatchObject({
      status: BookingStatus.CONFIRMED,
      jobId: 77,
      location: '12 Ring Road, Accra',
      service: null,
      notes: null,
      clientName: 'Former client',
    });
  });

  it('builds every section, each bound to the caller', async () => {
    const { service, repos } = build({
      bookings: [
        { getCount: 3 },
        { getRawMany: [row()] },
        {
          getRawOne: row({ status: BookingStatus.CONFIRMED, jobId: 9 }),
        },
        { getRawMany: [row({ status: BookingStatus.CONFIRMED })] },
      ],
      payments: {
        getRawOne: {
          held: '450',
          onTheWay: '300',
          needsAction: '120',
          needsActionCount: '1',
          paidThisMonth: '1840',
        },
      },
    });
    const res = await service.getOverview(5, NOW);

    expect(res.failedSections).toEqual([]);
    expect(res.stageCounts).toEqual({
      toStart: 1,
      inProgress: 2,
      awaitingClient: 1,
      done: 14,
      closed: 3,
      total: 21,
      applied: 4,
    });
    expect(res.pendingRequests?.total).toBe(3);
    expect(res.pendingRequests?.items).toHaveLength(1);
    expect(res.nextBooking?.jobId).toBe(9);
    expect(res.todayBookings).toHaveLength(1);
    expect(res.earnings).toEqual({
      currency: 'GHS',
      heldForSignOff: '450.00',
      onTheWay: '300.00',
      needsAction: '120.00',
      needsActionCount: 1,
      paidThisMonth: '1840.00',
      hasPayoutMethod: true,
    });
    expect(res.disputesNeedingResponse).toBe(1);

    expect(repos.jobs.made[0].params()).toMatchObject({ me: 5 });
    expect(repos.applications.made[0].params()).toMatchObject({ me: 5 });
    expect(repos.disputes.made[0].params()).toMatchObject({ me: 5 });
    for (const qb of repos.bookings.made) {
      expect(qb.params()).toMatchObject({ profileId: 7 });
    }
    expect(repos.bookings.made[3].params()).toMatchObject({
      today: '2026-10-31',
    });
    expect(repos.bookings.made[2].params()).toMatchObject({
      nowLocal: '2026-10-31 12:00:00',
    });
  });

  it('has no next booking when none is ahead', async () => {
    const { service } = build({
      bookings: [{ getCount: 0 }, { getRawMany: [] }, {}, { getRawMany: [] }],
      payout: { getRawOne: undefined },
    });
    const res = await service.getOverview(5, NOW);
    expect(res.nextBooking).toBeNull();
    expect(res.todayBookings).toEqual([]);
    expect(res.earnings?.hasPayoutMethod).toBe(false);
  });

  it('isolates a failing section', async () => {
    const { service } = build({
      jobs: { error: new Error('db') },
      disputes: { error: new Error('db') },
    });
    const res = await service.getOverview(5, NOW);
    expect(res.stageCounts).toBeNull();
    expect(res.disputesNeedingResponse).toBeNull();
    expect(res.failedSections).toEqual(['stageCounts', 'disputes']);
    expect(res.earnings).not.toBeNull();
  });

  it('nulls both booking fields when the bookings section fails', async () => {
    const { service } = build({
      bookings: [
        { getCount: 0 },
        { getRawMany: [] },
        { error: new Error('x') },
      ],
    });
    const res = await service.getOverview(5, NOW);
    expect(res.nextBooking).toBeNull();
    expect(res.todayBookings).toBeNull();
    expect(res.failedSections).toEqual(['bookings']);
  });

  it('is 404 without an artisan profile', async () => {
    const { service } = build({ profile: null });
    await expect(service.getOverview(5, NOW)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

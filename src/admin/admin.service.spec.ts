import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Brackets } from 'typeorm';
import {
  AdminActionTarget,
  AdminActionType,
  AdminUserStatus,
  DisputeCategory,
  Role,
  Token,
} from '@common/types/enums';
import type { User } from '@users/entities/user.entity';
import { AdminService } from './admin.service';

type Qb = Record<string, jest.Mock>;

function makeQb(rows: unknown[] = [], total = rows.length): Qb {
  const qb: Qb = {};
  for (const m of [
    'where',
    'andWhere',
    'orWhere',
    'orderBy',
    'skip',
    'take',
    'withDeleted',
    'leftJoinAndSelect',
    'innerJoinAndSelect',
  ]) {
    qb[m] = jest.fn(() => qb);
  }
  qb.getManyAndCount = jest.fn().mockResolvedValue([rows, total]);
  qb.getMany = jest.fn().mockResolvedValue(rows);
  return qb;
}

const repo = () => ({
  createQueryBuilder: jest.fn(),
  findOne: jest.fn(),
  save: jest.fn((v: unknown) => Promise.resolve(v)),
  delete: jest.fn(),
  count: jest.fn(),
});

function makeUser(overrides: Partial<User> = {}): User {
  return {
    id: 20,
    email: 'ama@example.com',
    firstname: 'Ama',
    lastname: 'Mensah',
    role: Role.CUSTOMER,
    password: 'hashed',
    isBanned: false,
    isSuspended: false,
    ...overrides,
  } as User;
}

describe('AdminService', () => {
  let service: AdminService;
  const usersRepo = repo();
  const profileRepo = repo();
  const jobsRepo = repo();
  const verificationsRepo = repo();
  const bookingsRepo = repo();
  const disputesRepo = repo();
  const tokensRepo = repo();
  const jobsService = { expireJob: jest.fn() };
  const auditService = { record: jest.fn() };
  const paymentsService = { getPlatformFeePercent: jest.fn(() => 5) };
  const config = { get: jest.fn() };
  const admin = makeUser({
    id: 1,
    email: 'admin@example.com',
    firstname: 'Kofi',
    lastname: 'Admin',
    role: Role.ADMIN,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    service = new AdminService(
      usersRepo as never,
      profileRepo as never,
      jobsRepo as never,
      repo() as never,
      verificationsRepo as never,
      bookingsRepo as never,
      disputesRepo as never,
      tokensRepo as never,
      jobsService as never,
      auditService as never,
      paymentsService as never,
      config as never,
    );
  });

  const conditions = (qb: Qb) =>
    qb.andWhere.mock.calls.map((c: unknown[]) => c[0]);

  describe('listUsers', () => {
    it('defaults to page 1 / 20 and strips the password hash', async () => {
      const qb = makeQb([makeUser({ isBanned: true, isSuspended: true })], 41);
      usersRepo.createQueryBuilder.mockReturnValue(qb);

      const res = await service.listUsers({});

      expect(qb.skip).toHaveBeenCalledWith(0);
      expect(qb.take).toHaveBeenCalledWith(20);
      expect(qb.andWhere).not.toHaveBeenCalled();
      expect(res.data[0]).not.toHaveProperty('password');
      // BANNED wins over SUSPENDED when both flags are set.
      expect(res.data[0].accountStatus).toBe(AdminUserStatus.BANNED);
      expect(res.pagination).toEqual({
        total: 41,
        page: 1,
        limit: 20,
        totalPages: 3,
      });
    });

    it('offsets by page and limit', async () => {
      const qb = makeQb([], 0);
      usersRepo.createQueryBuilder.mockReturnValue(qb);

      const res = await service.listUsers({ page: 3, limit: 10 });

      expect(qb.skip).toHaveBeenCalledWith(20);
      expect(qb.take).toHaveBeenCalledWith(10);
      expect(res.pagination.totalPages).toBe(0);
    });

    it.each([
      [AdminUserStatus.BANNED, ['u.isBanned = true']],
      [
        AdminUserStatus.SUSPENDED,
        ['u.isSuspended = true', 'u.isBanned = false'],
      ],
      [AdminUserStatus.ACTIVE, ['u.isBanned = false', 'u.isSuspended = false']],
    ])('filters status %s', async (status, expected) => {
      const qb = makeQb();
      usersRepo.createQueryBuilder.mockReturnValue(qb);

      await service.listUsers({ status, isBanned: false });

      // `status` takes precedence over the legacy `isBanned` flag.
      expect(conditions(qb)).toEqual(expected);
    });

    it('falls back to the legacy isBanned filter without a status', async () => {
      const qb = makeQb();
      usersRepo.createQueryBuilder.mockReturnValue(qb);

      await service.listUsers({ isBanned: false, role: Role.ARTISAN });

      expect(qb.andWhere).toHaveBeenCalledWith('u.role = :role', {
        role: Role.ARTISAN,
      });
      expect(qb.andWhere).toHaveBeenCalledWith('u.isBanned = :isBanned', {
        isBanned: false,
      });
    });

    it('treats a bare joinedTo date as inclusive of the whole day', async () => {
      const qb = makeQb();
      usersRepo.createQueryBuilder.mockReturnValue(qb);

      await service.listUsers({
        joinedFrom: '2026-08-01',
        joinedTo: '2026-08-31',
      });

      expect(qb.andWhere).toHaveBeenCalledWith('u.createdAt >= :joinedFrom', {
        joinedFrom: new Date('2026-08-01T00:00:00.000Z'),
      });
      expect(qb.andWhere).toHaveBeenCalledWith('u.createdAt <= :joinedTo', {
        joinedTo: new Date('2026-08-31T23:59:59.999Z'),
      });
    });

    it('keeps an explicit joinedTo timestamp as given', async () => {
      const qb = makeQb();
      usersRepo.createQueryBuilder.mockReturnValue(qb);

      await service.listUsers({ joinedTo: '2026-08-31T12:00:00.000Z' });

      expect(qb.andWhere).toHaveBeenCalledWith('u.createdAt <= :joinedTo', {
        joinedTo: new Date('2026-08-31T12:00:00.000Z'),
      });
    });

    const runSearch = async (search: string) => {
      const qb = makeQb();
      usersRepo.createQueryBuilder.mockReturnValue(qb);
      await service.listUsers({ search });
      const [[brackets]] = qb.andWhere.mock.calls as [[Brackets]];
      expect(brackets).toBeInstanceOf(Brackets);
      const w = { where: jest.fn(), orWhere: jest.fn() };
      brackets.whereFactory(w as never);
      return w;
    };

    it('searches name/email case-insensitively without a phone clause for short digit runs', async () => {
      const w = await runSearch('  Ama 1 ');

      expect(w.where).toHaveBeenCalledWith(expect.any(String), {
        like: '%ama 1%',
      });
      expect(w.orWhere).not.toHaveBeenCalled();
    });

    it('matches phone digits with the local leading zero dropped', async () => {
      const w = await runSearch('024 412');

      expect(w.orWhere).toHaveBeenCalledWith(expect.any(String), {
        digits: '%24412%',
      });
    });

    it('ignores a whitespace-only search', async () => {
      const qb = makeQb();
      usersRepo.createQueryBuilder.mockReturnValue(qb);

      await service.listUsers({ search: '   ' });

      expect(qb.andWhere).not.toHaveBeenCalled();
    });
  });

  describe('getUser', () => {
    it('throws when the user does not exist', async () => {
      usersRepo.findOne.mockResolvedValueOnce(null);
      await expect(service.getUser(5)).rejects.toThrow(NotFoundException);
    });

    it('returns the sanitized user with a derived status', async () => {
      usersRepo.findOne.mockResolvedValueOnce(makeUser({ isSuspended: true }));

      const res = await service.getUser(20);

      expect(res.data).not.toHaveProperty('password');
      expect(res.data.accountStatus).toBe(AdminUserStatus.SUSPENDED);
    });
  });

  describe('banUser', () => {
    it('refuses to let an admin ban themselves', async () => {
      await expect(service.banUser(admin, admin.id)).rejects.toThrow(
        'You cannot ban yourself.',
      );
      expect(usersRepo.findOne).not.toHaveBeenCalled();
    });

    it('throws for an unknown user', async () => {
      usersRepo.findOne.mockResolvedValueOnce(null);
      await expect(service.banUser(admin, 99)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('refuses an already-banned user', async () => {
      usersRepo.findOne.mockResolvedValueOnce(makeUser({ isBanned: true }));
      await expect(service.banUser(admin, 20)).rejects.toThrow(
        'User is already banned.',
      );
      expect(usersRepo.save).not.toHaveBeenCalled();
    });

    it('bans, attributes, ends sessions and audits with the reason', async () => {
      usersRepo.findOne.mockResolvedValueOnce(makeUser());

      const res = await service.banUser(admin, 20, { reason: 'Fraud' });

      expect(usersRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          isBanned: true,
          bannedById: 1,
          bannedAt: expect.any(Date) as Date,
        }),
      );
      expect(tokensRepo.delete).toHaveBeenCalledWith({
        user: { id: 20 },
        type: Token.REFRESH,
      });
      expect(auditService.record).toHaveBeenCalledWith({
        action: AdminActionType.USER_BAN,
        targetType: AdminActionTarget.USER,
        targetId: 20,
        targetLabel: 'Ama Mensah (ama@example.com)',
        reason: 'Fraud',
        actorId: 1,
        actorName: 'Kofi Admin',
        actorEmail: 'admin@example.com',
        metadata: { role: Role.CUSTOMER },
      });
      expect(res.message).toBe('User ama@example.com has been banned.');
    });

    it('audits a null reason when none is given', async () => {
      usersRepo.findOne.mockResolvedValueOnce(makeUser());
      await service.banUser(admin, 20);
      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({ reason: null }),
      );
    });
  });

  describe('unbanUser', () => {
    it('refuses a user who is not banned', async () => {
      usersRepo.findOne.mockResolvedValueOnce(makeUser());
      await expect(service.unbanUser(admin, 20)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('clears the ban with nulls so save() actually writes them', async () => {
      usersRepo.findOne.mockResolvedValueOnce(
        makeUser({ isBanned: true, bannedAt: new Date(), bannedById: 1 }),
      );

      await service.unbanUser(admin, 20);

      expect(usersRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          isBanned: false,
          bannedAt: null,
          bannedById: null,
        }),
      );
      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: AdminActionType.USER_UNBAN }),
      );
    });
  });

  describe('suspendUser', () => {
    const dto = { reason: 'Chargebacks' };

    it('refuses self-suspension', async () => {
      await expect(service.suspendUser(admin, admin.id, dto)).rejects.toThrow(
        'You cannot suspend yourself.',
      );
    });

    it('refuses an already-suspended user', async () => {
      usersRepo.findOne.mockResolvedValueOnce(makeUser({ isSuspended: true }));
      await expect(service.suspendUser(admin, 20, dto)).rejects.toThrow(
        'User is already suspended.',
      );
    });

    it('refuses to downgrade a banned user to a suspension', async () => {
      usersRepo.findOne.mockResolvedValueOnce(makeUser({ isBanned: true }));
      await expect(service.suspendUser(admin, 20, dto)).rejects.toThrow(
        /permanently banned/,
      );
      expect(usersRepo.save).not.toHaveBeenCalled();
    });

    it('suspends with attribution and reason', async () => {
      usersRepo.findOne.mockResolvedValueOnce(makeUser());

      await service.suspendUser(admin, 20, dto);

      expect(usersRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          isSuspended: true,
          suspendedById: 1,
          suspensionReason: 'Chargebacks',
          suspendedAt: expect.any(Date) as Date,
        }),
      );
      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AdminActionType.USER_SUSPEND,
          reason: 'Chargebacks',
        }),
      );
    });
  });

  describe('activateUser', () => {
    it('refuses a user who is not suspended', async () => {
      usersRepo.findOne.mockResolvedValueOnce(makeUser());
      await expect(service.activateUser(admin, 20)).rejects.toThrow(
        'User is not currently suspended.',
      );
    });

    it('clears every trace of the suspension', async () => {
      usersRepo.findOne.mockResolvedValueOnce(
        makeUser({
          isSuspended: true,
          suspendedAt: new Date(),
          suspendedById: 1,
          suspensionReason: 'Chargebacks',
        }),
      );

      await service.activateUser(admin, 20);

      expect(usersRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          isSuspended: false,
          suspendedAt: null,
          suspendedById: null,
          suspensionReason: null,
        }),
      );
      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: AdminActionType.USER_ACTIVATE }),
      );
    });
  });

  describe('jobs and bookings', () => {
    it('listJobs includes soft-deleted jobs and filters by status', async () => {
      const qb = makeQb([{ id: 1 }], 1);
      jobsRepo.createQueryBuilder.mockReturnValue(qb);

      const res = await service.listJobs({ status: 'OPEN' as never });

      expect(qb.withDeleted).toHaveBeenCalled();
      expect(qb.andWhere).toHaveBeenCalledWith('j.status = :status', {
        status: 'OPEN',
      });
      expect(res.pagination).toEqual({
        total: 1,
        page: 1,
        limit: 20,
        totalPages: 1,
      });
    });

    it('listJobs applies no status filter when none is given', async () => {
      const qb = makeQb();
      jobsRepo.createQueryBuilder.mockReturnValue(qb);
      await service.listJobs({ page: 2, limit: 5 });
      expect(qb.andWhere).not.toHaveBeenCalled();
      expect(qb.skip).toHaveBeenCalledWith(5);
    });

    it('forceExpireJob delegates to JobsService', async () => {
      const res = await service.forceExpireJob(8);
      expect(jobsService.expireJob).toHaveBeenCalledWith(8);
      expect(res.message).toBe('Job 8 has been expired.');
    });

    it('listBookings filters on the raw relation columns', async () => {
      const qb = makeQb();
      bookingsRepo.createQueryBuilder.mockReturnValue(qb);

      await service.listBookings({
        status: 'CONFIRMED' as never,
        artisanProfileId: 4,
        customerId: 9,
      });

      expect(qb.andWhere).toHaveBeenCalledWith('b.status = :status', {
        status: 'CONFIRMED',
      });
      expect(qb.andWhere).toHaveBeenCalledWith(
        'b.artisan_profile_id = :artisanProfileId',
        { artisanProfileId: 4 },
      );
      expect(qb.andWhere).toHaveBeenCalledWith('b.customer_id = :customerId', {
        customerId: 9,
      });
    });

    it('listBookings applies no filters by default', async () => {
      const qb = makeQb();
      bookingsRepo.createQueryBuilder.mockReturnValue(qb);
      await service.listBookings({});
      expect(qb.andWhere).not.toHaveBeenCalled();
    });

    it('getBooking throws when missing and returns it when found', async () => {
      bookingsRepo.findOne.mockResolvedValueOnce(null);
      await expect(service.getBooking(3)).rejects.toThrow(NotFoundException);

      bookingsRepo.findOne.mockResolvedValueOnce({ id: 3 });
      await expect(service.getBooking(3)).resolves.toEqual({
        message: 'Booking retrieved.',
        data: { id: 3 },
      });
    });
  });

  describe('listArtisans', () => {
    it('works with no query and tags each profile with its account status', async () => {
      const qb = makeQb(
        [
          { id: 1, user: makeUser({ isSuspended: true }) },
          { id: 2, user: makeUser() },
        ],
        2,
      );
      profileRepo.createQueryBuilder.mockReturnValue(qb);

      const res = await service.listArtisans();

      expect(qb.andWhere).not.toHaveBeenCalled();
      expect(res.data.map((p) => p.accountStatus)).toEqual([
        AdminUserStatus.SUSPENDED,
        AdminUserStatus.ACTIVE,
      ]);
    });

    it.each([
      [AdminUserStatus.BANNED, ['user.isBanned = true']],
      [
        AdminUserStatus.SUSPENDED,
        ['user.isSuspended = true', 'user.isBanned = false'],
      ],
      [
        AdminUserStatus.ACTIVE,
        ['user.isBanned = false', 'user.isSuspended = false'],
      ],
    ])('filters status %s', async (status, expected) => {
      const qb = makeQb();
      profileRepo.createQueryBuilder.mockReturnValue(qb);
      await service.listArtisans({ status });
      expect(conditions(qb)).toEqual(expected);
    });

    it('searches with a lower-cased, trimmed term', async () => {
      const qb = makeQb();
      profileRepo.createQueryBuilder.mockReturnValue(qb);

      await service.listArtisans({ search: '  Plumbing ' });

      expect(qb.andWhere).toHaveBeenCalledWith(expect.any(String), {
        like: '%plumbing%',
      });
    });
  });

  it('getStats maps each count to its bucket', async () => {
    usersRepo.count
      .mockResolvedValueOnce(10)
      .mockResolvedValueOnce(4)
      .mockResolvedValueOnce(5)
      .mockResolvedValueOnce(1);
    jobsRepo.count.mockResolvedValueOnce(7).mockResolvedValueOnce(3);
    verificationsRepo.count.mockResolvedValueOnce(2).mockResolvedValueOnce(6);
    bookingsRepo.count.mockResolvedValueOnce(9).mockResolvedValueOnce(8);

    const res = await service.getStats();

    expect(res.data).toEqual({
      users: { total: 10, artisans: 4, customers: 5, banned: 1 },
      jobs: { total: 7, open: 3 },
      verifications: { pending: 2, approved: 6 },
      bookings: { total: 9, confirmed: 8 },
    });
  });

  describe('search', () => {
    let usersQb: Qb;
    let jobsQb: Qb;
    let disputesQb: Qb;

    const wire = (users: unknown[], jobs: unknown[], disputes: unknown[]) => {
      usersQb = makeQb(users);
      jobsQb = makeQb(jobs);
      disputesQb = makeQb(disputes);
      usersRepo.createQueryBuilder.mockReturnValue(usersQb);
      jobsRepo.createQueryBuilder.mockReturnValue(jobsQb);
      disputesRepo.createQueryBuilder.mockReturnValue(disputesQb);
    };

    it('reports no matches for a text term and skips id lookups', async () => {
      wire([], [], []);

      const res = await service.search({ q: '  Nobody ' });

      expect(res.message).toBe('No users, jobs or disputes match that search.');
      expect(res.data.query).toBe('Nobody');
      expect(usersQb.where).toHaveBeenCalledWith(expect.any(String), {
        like: '%nobody%',
      });
      expect(usersQb.orWhere).not.toHaveBeenCalled();
      expect(jobsQb.orWhere).not.toHaveBeenCalled();
      expect(disputesQb.orWhere).not.toHaveBeenCalled();
      expect(usersQb.take).toHaveBeenCalledWith(5);
      expect(res.data.counts).toEqual({ users: 0, jobs: 0, disputes: 0 });
    });

    it('also matches ids (and dispute booking ids) for a numeric term', async () => {
      wire([], [], []);

      await service.search({ q: '42', limit: 10 });

      expect(usersQb.orWhere).toHaveBeenCalledWith('u.id = :numeric', {
        numeric: 42,
      });
      expect(jobsQb.orWhere).toHaveBeenCalledWith('j.id = :numeric', {
        numeric: 42,
      });
      expect(disputesQb.orWhere).toHaveBeenCalledWith(
        'd.booking_id = :numeric',
        {
          numeric: 42,
        },
      );
      expect(jobsQb.take).toHaveBeenCalledWith(10);
    });

    it('shapes results and tolerates missing relations', async () => {
      const created = new Date('2026-01-01T00:00:00Z');
      wire(
        [makeUser({ isBanned: true, createdAt: created })],
        [
          {
            id: 5,
            status: 'OPEN',
            location: 'Accra',
            service: { id: 2, name: 'Plumbing' },
            customer: { id: 20, firstname: 'Ama', lastname: 'Mensah' },
            deletedAt: created,
            createdAt: created,
          },
          { id: 6, title: 'Fix sink', status: 'OPEN', location: 'Tema' },
        ],
        [
          {
            id: 9,
            bookingId: 3,
            status: 'OPEN',
            raisedBy: { id: 20, firstname: 'Ama', lastname: 'Mensah' },
            createdAt: created,
          },
          {
            id: 10,
            bookingId: 4,
            status: 'RESOLVED',
            category: DisputeCategory.OTHER,
            outcome: 'REFUND',
          },
        ],
      );

      const res = await service.search({ q: 'ama' });

      expect(res.message).toBe('Search results retrieved.');
      expect(res.data.users[0]).toEqual({
        id: 20,
        name: 'Ama Mensah',
        email: 'ama@example.com',
        role: Role.CUSTOMER,
        status: AdminUserStatus.BANNED,
        createdAt: created,
      });
      expect(res.data.jobs[0]).toMatchObject({
        title: null,
        service: { id: 2, name: 'Plumbing' },
        customer: { id: 20, name: 'Ama Mensah' },
        deletedAt: created,
      });
      expect(res.data.jobs[1]).toMatchObject({
        title: 'Fix sink',
        service: null,
        customer: null,
        deletedAt: null,
      });
      expect(res.data.disputes[0]).toMatchObject({
        category: DisputeCategory.OTHER,
        outcome: null,
        raisedBy: { id: 20, name: 'Ama Mensah' },
      });
      expect(res.data.disputes[1]).toMatchObject({
        outcome: 'REFUND',
        raisedBy: null,
      });
      expect(res.data.counts).toEqual({ users: 1, jobs: 2, disputes: 2 });
    });
  });

  describe('getPlatformConfig', () => {
    it('reports the fee the backend applies, read-only', () => {
      config.get.mockReturnValueOnce('support@example.com');

      const res = service.getPlatformConfig();

      expect(res.data.platformFeePercent).toBe(5);
      expect(res.data.platformFeeEditable).toBe(false);
      expect(res.data.supportEmail).toBe('support@example.com');
      expect(config.get).toHaveBeenCalledWith('SUPPORT_EMAIL', '');
    });

    it('reports a null support email when none is configured', () => {
      config.get.mockReturnValueOnce('');
      expect(service.getPlatformConfig().data.supportEmail).toBeNull();
    });
  });
});

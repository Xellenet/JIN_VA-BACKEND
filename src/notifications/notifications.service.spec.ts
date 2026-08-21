import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotificationsService } from './notifications.service';
import { Notification } from './entities/notification.entity';
import { NotificationPreferences } from './entities/notification-preferences.entity';
import { User } from '@users/entities/user.entity';
import { NotificationType, Role } from '@common/types/enums';
import { formatGhs } from '@common/utils/currency.util';

/**
 * Covers PR3 (the admin-shaped preference DTO and its role-scoped write
 * boundary), PD5 (the new payment/dispute triggers going through the same
 * preference gating as everything else), and the admin fan-out.
 */
describe('NotificationsService', () => {
  let service: NotificationsService;

  /**
   * The subset of a persisted notification these tests assert on. Declared so
   * the mocks are typed rather than `any` — `create.mock.calls[0][0]` is how we
   * read back the notification the service tried to persist.
   */
  type NotificationRow = {
    user: { id: number };
    type: string;
    title: string;
    body: string;
    payload?: Record<string, unknown>;
  };

  let notificationsRepo: {
    save: jest.Mock<Promise<NotificationRow>, [NotificationRow]>;
    create: jest.Mock<NotificationRow, [NotificationRow]>;
    findOne: jest.Mock;
    count: jest.Mock;
    createQueryBuilder: jest.Mock;
  };
  let prefsRepo: {
    findOne: jest.Mock;
    save: jest.Mock<
      Promise<NotificationPreferences>,
      [NotificationPreferences]
    >;
    create: jest.Mock<NotificationPreferences, [NotificationPreferences]>;
  };
  let usersRepo: { find: jest.Mock };

  /** A prefs row with every flag on, for a user of the given role. */
  const prefsFor = (role: Role, overrides: Record<string, boolean> = {}) =>
    ({
      id: 1,
      user: { id: 99, role },
      emailEnabled: true,
      smsEnabled: false,
      pushEnabled: true,
      paymentReceipts: true,
      paymentReleased: true,
      artisanJobUpdates: true,
      disputeFiled: true,
      paymentTransferFailed: true,
      verificationSubmitted: true,
      reviewFlagged: true,
      artisanRegistered: true,
      ...overrides,
    }) as unknown as NotificationPreferences;

  beforeEach(async () => {
    notificationsRepo = {
      save: jest.fn((n: NotificationRow) => Promise.resolve(n)),
      create: jest.fn((n: NotificationRow) => n),
      findOne: jest.fn(),
      count: jest.fn(),
      createQueryBuilder: jest.fn(),
    };
    prefsRepo = {
      findOne: jest.fn(),
      save: jest.fn((p: NotificationPreferences) => Promise.resolve(p)),
      create: jest.fn((p: NotificationPreferences) => p),
    };
    usersRepo = { find: jest.fn().mockResolvedValue([]) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationsService,
        {
          provide: getRepositoryToken(Notification),
          useValue: notificationsRepo,
        },
        {
          provide: getRepositoryToken(NotificationPreferences),
          useValue: prefsRepo,
        },
        { provide: getRepositoryToken(User), useValue: usersRepo },
      ],
    }).compile();

    service = module.get<NotificationsService>(NotificationsService);
  });

  describe('preferences shape by role (PR3)', () => {
    it('returns the admin shape — the five real platform toggles — for an ADMIN', async () => {
      prefsRepo.findOne.mockResolvedValue(prefsFor(Role.ADMIN));

      const { data } = await service.getPreferences(99);

      expect(data).toEqual(
        expect.objectContaining({
          disputeFiled: true,
          paymentTransferFailed: true,
          verificationSubmitted: true,
          reviewFlagged: true,
          artisanRegistered: true,
          emailEnabled: true,
          pushEnabled: true,
        }),
      );
      // Customer-only toggles must not leak into an admin's payload.
      expect(data).not.toHaveProperty('paymentReceipts');
      expect(data).not.toHaveProperty('bookingConfirmations');
    });

    it('still returns the customer shape for a CUSTOMER', async () => {
      prefsRepo.findOne.mockResolvedValue(prefsFor(Role.CUSTOMER));

      const { data } = await service.getPreferences(99);

      expect(data).toHaveProperty('paymentReceipts');
      expect(data).not.toHaveProperty('disputeFiled');
    });
  });

  describe('preference writes are role-scoped (PR3)', () => {
    it('lets an admin set an admin toggle', async () => {
      const prefs = prefsFor(Role.ADMIN);
      prefsRepo.findOne.mockResolvedValue(prefs);

      await service.updatePreferences(99, { disputeFiled: false });

      expect(prefs.disputeFiled).toBe(false);
    });

    it('ignores a customer-only flag sent by an admin', async () => {
      const prefs = prefsFor(Role.ADMIN);
      prefsRepo.findOne.mockResolvedValue(prefs);

      await service.updatePreferences(99, { paymentReceipts: false });

      expect(prefs.paymentReceipts).toBe(true);
    });

    it('ignores an admin-only flag sent by a customer', async () => {
      const prefs = prefsFor(Role.CUSTOMER);
      prefsRepo.findOne.mockResolvedValue(prefs);

      await service.updatePreferences(99, { disputeFiled: false });

      expect(prefs.disputeFiled).toBe(true);
    });
  });

  describe('payment notifications (PD1–PD3, PD5)', () => {
    it('renders the customer receipt amount as GH₵ via the shared helper', async () => {
      prefsRepo.findOne.mockResolvedValue(prefsFor(Role.CUSTOMER));

      await service.handlePaymentReceipt({
        customerId: 99,
        jobId: 3,
        jobTitle: 'Kitchen Sink Repair',
        amount: 850,
        reference: 'jinva-3-99-1',
      });

      const saved = notificationsRepo.create.mock.calls[0][0];
      expect(saved.type).toBe(NotificationType.PAYMENT_RECEIPT);
      expect(saved.body).toContain(formatGhs(850));
      expect(saved.body).toContain('GH₵');
      expect(saved.body).not.toContain('$');
    });

    it("respects the customer's paymentReceipts toggle — the toggle that had no trigger before", async () => {
      prefsRepo.findOne.mockResolvedValue(
        prefsFor(Role.CUSTOMER, { paymentReceipts: false }),
      );

      await service.handlePaymentReceipt({
        customerId: 99,
        jobId: 3,
        jobTitle: 'Kitchen Sink Repair',
        amount: 850,
        reference: 'jinva-3-99-1',
      });

      expect(notificationsRepo.save).not.toHaveBeenCalled();
    });

    it("respects the artisan's paymentReleased toggle for a payout", async () => {
      prefsRepo.findOne.mockResolvedValue(
        prefsFor(Role.ARTISAN, { paymentReleased: false }),
      );

      await service.handlePayoutReleased({
        artisanUserId: 99,
        jobId: 3,
        jobTitle: 'Kitchen Sink Repair',
        artisanAmount: 807.5,
      });

      expect(notificationsRepo.save).not.toHaveBeenCalled();
    });

    it('no longer suppresses JOB_COMPLETED when the artisan mutes payment notifications', async () => {
      prefsRepo.findOne.mockResolvedValue(
        prefsFor(Role.ARTISAN, { paymentReleased: false }),
      );

      await service.handleJobCompleted({
        artisanId: 99,
        jobTitle: 'Kitchen Sink Repair',
        jobId: 3,
      });

      expect(notificationsRepo.save).toHaveBeenCalled();
    });

    it('no longer claims payment was released in the JOB_COMPLETED body', async () => {
      prefsRepo.findOne.mockResolvedValue(prefsFor(Role.ARTISAN));

      await service.handleJobCompleted({
        artisanId: 99,
        jobTitle: 'Kitchen Sink Repair',
        jobId: 3,
      });

      const saved = notificationsRepo.create.mock.calls[0][0];
      expect(saved.body).not.toContain('has been released');
    });
  });

  describe('dispute outcome (PD4)', () => {
    it('persists one notification per party, de-duplicated', async () => {
      prefsRepo.findOne.mockResolvedValue(prefsFor(Role.CUSTOMER));

      await service.handleDisputeResolved({
        disputeId: 5,
        bookingId: 77,
        raisedByUserId: 10,
        counterpartyUserId: 20,
        outcome: 'RESOLVED',
        resolution: 'Refund issued.',
      });

      expect(notificationsRepo.save).toHaveBeenCalledTimes(2);
    });

    it('does not double-notify when both ids resolve to the same user', async () => {
      prefsRepo.findOne.mockResolvedValue(prefsFor(Role.CUSTOMER));

      await service.handleDisputeResolved({
        disputeId: 5,
        bookingId: 77,
        raisedByUserId: 10,
        counterpartyUserId: 10,
        outcome: 'RESOLVED',
      });

      expect(notificationsRepo.save).toHaveBeenCalledTimes(1);
    });
  });

  describe('admin fan-out (PR3)', () => {
    it('notifies every admin account', async () => {
      usersRepo.find.mockResolvedValue([{ id: 1 }, { id: 2 }, { id: 3 }]);
      prefsRepo.findOne.mockResolvedValue(prefsFor(Role.ADMIN));

      await service.handleDisputeFiled({
        disputeId: 5,
        bookingId: 77,
        raisedByName: 'Ama Mensah',
        raisedByRole: Role.CUSTOMER,
      });

      expect(usersRepo.find).toHaveBeenCalledWith(
        expect.objectContaining({ where: { role: Role.ADMIN } }),
      );
      expect(notificationsRepo.save).toHaveBeenCalledTimes(3);
    });

    it('gates each admin independently — one muting the type does not mute the others', async () => {
      usersRepo.find.mockResolvedValue([{ id: 1 }, { id: 2 }]);
      prefsRepo.findOne
        .mockResolvedValueOnce(prefsFor(Role.ADMIN, { reviewFlagged: false }))
        .mockResolvedValueOnce(prefsFor(Role.ADMIN));

      await service.handleReviewFlagged({
        reviewId: 8,
        flaggedByName: 'Kofi Owusu',
        reason: 'Looks fake.',
        artisanName: 'Yaw Boateng',
      });

      expect(notificationsRepo.save).toHaveBeenCalledTimes(1);
    });

    it('does not throw when no admin accounts exist', async () => {
      usersRepo.find.mockResolvedValue([]);

      await expect(
        service.handleArtisanRegistered({
          artisanUserId: 42,
          artisanName: 'Efua Asare',
        }),
      ).resolves.not.toThrow();
      expect(notificationsRepo.save).not.toHaveBeenCalled();
    });
  });
});

describe('formatGhs', () => {
  it('always renders GH₵ with two decimals, never a bare number or a dollar sign', () => {
    expect(formatGhs(850)).toContain('GH₵');
    expect(formatGhs(850)).toContain('850.00');
    expect(formatGhs('807.5')).toContain('807.50');
    expect(formatGhs(0)).toContain('0.00');
  });

  it('degrades safely on a non-numeric amount rather than emitting NaN', () => {
    expect(formatGhs('not-a-number')).toBe('GH₵ 0.00');
  });
});

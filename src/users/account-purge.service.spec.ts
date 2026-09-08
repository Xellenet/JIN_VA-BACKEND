import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { getRepositoryToken } from '@nestjs/typeorm';
import { FindOperator } from 'typeorm';
import { addDays, subDays } from 'date-fns';
import { AccountPurgeService } from './account-purge.service';
import { User } from './entities/user.entity';
import { ArtisanVerification } from '../verification/entities/artisan-verification.entity';
import { KycMediaService } from '../uploads/kyc-media.service';
import { VARIABLES } from '@common/constants/variables.constants';
import { Role } from '@common/types/enums';

/**
 * C1.7/C1.8 verification. Four properties here are the ones a mistake would be
 * catastrophic and irreversible on, so they are asserted rather than reasoned
 * about:
 *
 * 1. the candidate query can never match a live account (`deleted_at IS NULL`);
 * 2. an account at exactly the retention boundary is never purged;
 * 3. reruns are idempotent, and a meanwhile-restored account is skipped;
 * 4. log-only mode — the default — writes absolutely nothing.
 */
/**
 * Typed accessors for what a mock was called with. `jest.Mock.mock.calls` is
 * `any[][]`, which the repo's type-safety lint rules (rightly) refuse.
 */
const callArg = <T>(mock: jest.Mock, callIndex: number, argIndex: number): T =>
  (mock.mock.calls as unknown[][])[callIndex][argIndex] as T;

const allArgs = <T>(mock: jest.Mock, argIndex: number): T[] =>
  (mock.mock.calls as unknown[][]).map((call) => call[argIndex] as T);

describe('AccountPurgeService (C1.7/C1.8)', () => {
  let service: AccountPurgeService;

  const mockTransactionalRepo = {
    findOne: jest.fn(),
    update: jest.fn(),
  };
  /** C1.7: KYC rows are read (for their media references) then scrubbed. */
  const mockVerificationsRepo = {
    find: jest.fn(),
    update: jest.fn(),
  };
  const mockQueryBuilder = {
    update: jest.fn().mockReturnThis(),
    delete: jest.fn().mockReturnThis(),
    from: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    execute: jest.fn().mockResolvedValue({ affected: 1 }),
  };
  const mockManager = {
    getRepository: (entity: unknown) =>
      entity === ArtisanVerification
        ? mockVerificationsRepo
        : mockTransactionalRepo,
    createQueryBuilder: () => mockQueryBuilder,
  };
  const mockKycMedia = {
    deleteByReference: jest.fn(),
  };
  const mockUsersRepository = {
    find: jest.fn(),
    manager: {
      transaction: jest.fn((cb: (m: unknown) => unknown): unknown =>
        cb(mockManager),
      ),
    },
  };
  const mockConfig = {
    get: jest.fn(),
  };

  const deletedUser = {
    id: 7,
    role: Role.ARTISAN,
    email: 'gone@example.com',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AccountPurgeService,
        { provide: getRepositoryToken(User), useValue: mockUsersRepository },
        { provide: ConfigService, useValue: mockConfig },
        { provide: KycMediaService, useValue: mockKycMedia },
      ],
    }).compile();

    service = module.get(AccountPurgeService);
    jest.clearAllMocks();
    mockVerificationsRepo.find.mockResolvedValue([]);
    mockKycMedia.deleteByReference.mockResolvedValue(true);
    mockQueryBuilder.update.mockReturnThis();
    mockQueryBuilder.delete.mockReturnThis();
    mockQueryBuilder.from.mockReturnThis();
    mockQueryBuilder.set.mockReturnThis();
    mockQueryBuilder.where.mockReturnThis();
    mockQueryBuilder.execute.mockResolvedValue({ affected: 1 });
    mockUsersRepository.manager.transaction.mockImplementation(
      (cb: (m: unknown) => unknown): unknown => cb(mockManager),
    );
    // Unset by default, in every environment — log-only.
    mockConfig.get.mockReturnValue(undefined);
  });

  describe('mode gating', () => {
    it('is log-only when ACCOUNT_PURGE_MODE is unset', () => {
      expect(service.isDestructiveModeEnabled()).toBe(false);
    });

    it('is log-only for any value other than the exact opt-in string', () => {
      for (const value of ['', 'true', '1', 'yes', 'DESTROY', 'log-only']) {
        mockConfig.get.mockReturnValue(value);
        expect(service.isDestructiveModeEnabled()).toBe(false);
      }
    });

    it('is destructive only for the exact opt-in string', () => {
      mockConfig.get.mockReturnValue(
        VARIABLES.ACCOUNT_PURGE_MODE_DESTRUCTIVE.toUpperCase(),
      );
      expect(service.isDestructiveModeEnabled()).toBe(true);
    });
  });

  describe('findPurgeCandidateIds', () => {
    /**
     * The catastrophic-bug guard. Eligibility is a `deleted_at < cutoff`
     * comparison, and in SQL no comparison against NULL is ever true — so a
     * live account is structurally unable to appear in the candidate list. If
     * this predicate is ever changed to something that could match a NULL
     * (`Not(IsNull())` alone, an `IN`, a raw string with an `OR`), this
     * assertion fails.
     */
    it('selects on deleted_at < cutoff, which can never match a live (NULL) row', async () => {
      mockUsersRepository.find.mockResolvedValueOnce([]);
      const now = new Date('2026-09-07T12:00:00.000Z');

      await service.findPurgeCandidateIds(now);

      const options = callArg<{
        where: {
          deletedAt: FindOperator<Date>;
          purgedAt: FindOperator<unknown>;
        };
        withDeleted: boolean;
      }>(mockUsersRepository.find, 0, 0);
      expect(options.where.deletedAt.type).toBe('lessThan');
      expect(options.where.deletedAt.value).toEqual(
        subDays(now, VARIABLES.SOFT_DELETE_RETENTION_DAYS),
      );
      // Already-purged rows are excluded, which is what makes reruns cheap
      // and idempotent.
      expect(options.where.purgedAt.type).toBe('isNull');
      expect(options.withDeleted).toBe(true);
    });

    it('returns the ids it found', async () => {
      mockUsersRepository.find.mockResolvedValueOnce([{ id: 3 }, { id: 9 }]);
      await expect(service.findPurgeCandidateIds()).resolves.toEqual([3, 9]);
    });
  });

  describe('purgeAccount — eligibility re-check under the row lock', () => {
    it('locks the row for write, so a concurrent restore cannot interleave', async () => {
      mockTransactionalRepo.findOne.mockResolvedValueOnce({
        ...deletedUser,
        deletedAt: subDays(new Date(), 40),
      });

      await service.purgeAccount(deletedUser.id);

      expect(mockTransactionalRepo.findOne).toHaveBeenCalledWith(
        expect.objectContaining({
          withDeleted: true,
          lock: { mode: 'pessimistic_write' },
        }),
      );
    });

    /**
     * Defence in depth behind the candidate query: even handed an id
     * explicitly, a live account is never purged.
     */
    it('never purges an account with deletedAt IS NULL, even if handed its id', async () => {
      mockConfig.get.mockReturnValue(VARIABLES.ACCOUNT_PURGE_MODE_DESTRUCTIVE);
      mockTransactionalRepo.findOne.mockResolvedValueOnce({
        ...deletedUser,
        deletedAt: null,
      });

      await expect(service.purgeAccount(deletedUser.id)).resolves.toBe(
        'skipped',
      );
      expect(mockTransactionalRepo.update).not.toHaveBeenCalled();
      expect(mockQueryBuilder.execute).not.toHaveBeenCalled();
    });

    // C1.7's boundary rule: purge strictly *after* day 30. Time is frozen
    // because "exactly 30 days ago" is a single instant.
    it('never purges an account at exactly the retention boundary', async () => {
      const frozenNow = new Date('2026-09-07T12:00:00.000Z');
      mockConfig.get.mockReturnValue(VARIABLES.ACCOUNT_PURGE_MODE_DESTRUCTIVE);
      mockTransactionalRepo.findOne.mockResolvedValueOnce({
        ...deletedUser,
        deletedAt: subDays(frozenNow, VARIABLES.SOFT_DELETE_RETENTION_DAYS),
      });

      await expect(
        service.purgeAccount(deletedUser.id, frozenNow),
      ).resolves.toBe('skipped');
      expect(mockTransactionalRepo.update).not.toHaveBeenCalled();
    });

    // The purge-vs-restore race, restore winning: the row is live again by
    // the time the purge holds the lock, so the purge does nothing at all.
    it('skips an account that was restored during the window', async () => {
      mockConfig.get.mockReturnValue(VARIABLES.ACCOUNT_PURGE_MODE_DESTRUCTIVE);
      mockTransactionalRepo.findOne.mockResolvedValueOnce({
        ...deletedUser,
        deletedAt: undefined,
        purgedAt: null,
      });

      await expect(service.purgeAccount(deletedUser.id)).resolves.toBe(
        'skipped',
      );
      expect(mockTransactionalRepo.update).not.toHaveBeenCalled();
    });

    // Idempotency across reruns and overlapping runs.
    it('skips an already-purged account without touching it again', async () => {
      mockConfig.get.mockReturnValue(VARIABLES.ACCOUNT_PURGE_MODE_DESTRUCTIVE);
      mockTransactionalRepo.findOne.mockResolvedValueOnce({
        ...deletedUser,
        deletedAt: subDays(new Date(), 60),
        purgedAt: subDays(new Date(), 30),
      });

      await expect(service.purgeAccount(deletedUser.id)).resolves.toBe(
        'skipped',
      );
      expect(mockTransactionalRepo.update).not.toHaveBeenCalled();
    });

    it('skips a candidate whose row no longer exists', async () => {
      mockTransactionalRepo.findOne.mockResolvedValueOnce(null);
      await expect(service.purgeAccount(999)).resolves.toBe('skipped');
    });
  });

  describe('purgeAccount — log-only mode', () => {
    it('reports an eligible account and writes absolutely nothing', async () => {
      mockTransactionalRepo.findOne.mockResolvedValueOnce({
        ...deletedUser,
        deletedAt: subDays(new Date(), 45),
      });

      await expect(service.purgeAccount(deletedUser.id)).resolves.toBe(
        'reported',
      );
      expect(mockTransactionalRepo.update).not.toHaveBeenCalled();
      expect(mockQueryBuilder.execute).not.toHaveBeenCalled();
    });

    // Log-only has to be inert in *storage* too, not just in the database —
    // deleting a KYC document is every bit as irreversible as scrubbing a row.
    it('does not read or delete any KYC media', async () => {
      mockTransactionalRepo.findOne.mockResolvedValueOnce({
        ...deletedUser,
        deletedAt: subDays(new Date(), 45),
      });

      await service.purgeAccount(deletedUser.id);

      expect(mockVerificationsRepo.find).not.toHaveBeenCalled();
      expect(mockKycMedia.deleteByReference).not.toHaveBeenCalled();
      expect(mockVerificationsRepo.update).not.toHaveBeenCalled();
    });
  });

  describe('purgeAccount — destructive mode', () => {
    const runPurge = async () => {
      mockConfig.get.mockReturnValue(VARIABLES.ACCOUNT_PURGE_MODE_DESTRUCTIVE);
      mockTransactionalRepo.findOne.mockResolvedValueOnce({
        ...deletedUser,
        deletedAt: subDays(new Date(), 45),
      });
      return service.purgeAccount(deletedUser.id);
    };

    it('scrubs every directly-identifying field on the user row', async () => {
      await expect(runPurge()).resolves.toBe('purged');

      const criteria = callArg<{ id: number }>(
        mockTransactionalRepo.update,
        0,
        0,
      );
      const payload = callArg<Record<string, unknown>>(
        mockTransactionalRepo.update,
        0,
        1,
      );
      expect(criteria).toEqual({ id: deletedUser.id });

      // Non-authenticable, three independent ways.
      expect(payload.password).toBeNull();
      expect(payload.email).toBe(
        `deleted-user-${deletedUser.id}@${VARIABLES.PURGED_EMAIL_DOMAIN}`,
      );
      expect(payload.email).not.toContain('gone@example.com');
      expect(payload.purgedAt).toBeInstanceOf(Date);

      // Renders as "Deleted User" wherever a counterparty joins this row —
      // never blank, never null.
      expect(payload.firstname).toBe(VARIABLES.PURGED_FIRSTNAME);
      expect(payload.lastname).toBe(VARIABLES.PURGED_LASTNAME);

      for (const field of [
        'username',
        'phoneNumber',
        'dateOfBirth',
        'gender',
        'profilePicture',
        'socialProvider',
        'socialProviderId',
      ]) {
        expect(payload[field]).toBeNull();
      }
    });

    // The email placeholder must be derived from the row id alone: it carries
    // no trace of the original address (so it is not reversible) and it is
    // stable across reruns (so re-purging is a no-op rather than a new value).
    it('derives the email placeholder from the id, with no trace of the original', async () => {
      await runPurge();
      const payload = callArg<{ email: string }>(
        mockTransactionalRepo.update,
        0,
        1,
      );
      expect(payload.email).toBe(
        `deleted-user-${deletedUser.id}@${VARIABLES.PURGED_EMAIL_DOMAIN}`,
      );
      expect(payload.email.endsWith('.invalid')).toBe(true);
    });

    it('clears the artisan payout details and forces the profile out of search', async () => {
      await runPurge();

      const setPayloads = allArgs<Record<string, unknown>>(
        mockQueryBuilder.set,
        0,
      );
      const profilePayload = setPayloads.find((p) => 'payoutType' in p);
      expect(profilePayload).toBeDefined();
      for (const field of [
        'bio',
        'businessName',
        'location',
        'cancellationPolicy',
        'payoutType',
        'paystackRecipientCode',
        'payoutAccountName',
        'payoutAccountNumber',
        'payoutBankCode',
      ]) {
        expect(profilePayload![field]).toBeNull();
      }
      expect(profilePayload!.isProfileComplete).toBe(false);
    });

    it('deletes the residual tokens and saved addresses', async () => {
      await runPurge();
      expect(mockQueryBuilder.delete).toHaveBeenCalledTimes(2);
    });

    /**
     * C1.7's "all directly identifying personal data is irreversibly
     * scrubbed" has to reach `artisan_verifications`, which the purge
     * otherwise never touched because it hangs off the artisan profile rather
     * than the user row. Left alone, a purged ex-artisan stayed fully
     * re-identifiable: Ghana Card / passport number, legal name, date of
     * birth, the KYC provider payload, and the stored ID scans and selfie —
     * still streamable by any admin through `GET /uploads/kyc/...`, which has
     * no notion of a purged account.
     */
    describe('KYC identity data (C1.7)', () => {
      const verificationRow = {
        id: 55,
        idNumber: 'GHA-000111222-3',
        fullLegalName: 'Yaw Mensah',
        dateOfBirth: '1990-04-01',
        documentFrontUrl: '/uploads/documents/front-uuid.jpg',
        documentBackUrl: '/uploads/documents/back-uuid.jpg',
        selfieUrl: '/uploads/selfies/selfie-uuid.jpg',
      };

      const runPurgeWithVerification = async () => {
        mockVerificationsRepo.find.mockResolvedValue([verificationRow]);
        return runPurge();
      };

      it('clears every identifying column, keeping only the moderation trail', async () => {
        await runPurgeWithVerification();

        const [criteria, payload] = (
          mockVerificationsRepo.update.mock.calls as unknown[][]
        )[0] as [{ id: unknown }, Record<string, unknown>];

        expect(criteria.id).toBeDefined();
        for (const field of [
          'idNumber',
          'fullLegalName',
          'dateOfBirth',
          'additionalNotes',
          'providerRawResponse',
          'documentFrontUrl',
          'documentBackUrl',
          'selfieUrl',
        ]) {
          expect(payload[field]).toBeNull();
        }

        // Who reviewed what, and when, is not personal data of the departing
        // artisan and has to survive them leaving.
        expect(payload).not.toHaveProperty('status');
        expect(payload).not.toHaveProperty('reviewedAt');
        expect(payload).not.toHaveProperty('reviewedById');
      });

      it('deletes the stored documents and selfie from storage', async () => {
        await runPurgeWithVerification();

        const references = (
          mockKycMedia.deleteByReference.mock.calls as unknown[][]
        ).map((call) => call[0]);
        expect(references).toEqual([
          verificationRow.documentFrontUrl,
          verificationRow.documentBackUrl,
          verificationRow.selfieUrl,
        ]);
      });

      // The reference is the only way to find the file, so clearing it first
      // would orphan the media permanently and undetectably.
      it('deletes the objects before clearing the references that locate them', async () => {
        await runPurgeWithVerification();

        const deleteOrder = mockKycMedia.deleteByReference.mock
          .invocationCallOrder as number[];
        const updateOrder = mockVerificationsRepo.update.mock
          .invocationCallOrder as number[];
        expect(Math.max(...deleteOrder)).toBeLessThan(Math.min(...updateOrder));
      });

      it('still scrubs the row when a file could not be resolved in storage', async () => {
        mockKycMedia.deleteByReference.mockResolvedValue(false);

        await runPurgeWithVerification();

        // Leaving the ID number in place because one filename was unparseable
        // would be the worse failure; the operator gets an error log instead.
        expect(mockVerificationsRepo.update).toHaveBeenCalled();
      });

      it('is a no-op for an account with no verification rows', async () => {
        mockVerificationsRepo.find.mockResolvedValue([]);

        await runPurge();

        expect(mockKycMedia.deleteByReference).not.toHaveBeenCalled();
        expect(mockVerificationsRepo.update).not.toHaveBeenCalled();
      });
    });

    // C1.7: financial, audit and counterparty-integrity records stay attached
    // to the anonymized row. Nothing in the purge may reach them.
    it('never touches payments, disputes, jobs or bookings', async () => {
      await runPurge();

      const touchedEntities = [
        ...allArgs<{ name: string } | undefined>(mockQueryBuilder.update, 0),
        ...allArgs<{ name: string } | undefined>(mockQueryBuilder.from, 0),
      ]
        .filter((entity): entity is { name: string } => !!entity)
        .map((entity) => entity.name);

      expect(touchedEntities).not.toContain('Payment');
      expect(touchedEntities).not.toContain('Dispute');
      expect(touchedEntities).not.toContain('Job');
      expect(touchedEntities).not.toContain('Booking');
      expect(touchedEntities.sort()).toEqual([
        'Address',
        'ArtisanProfile',
        'UserToken',
      ]);
    });

    // C1.8: `deletedAt` deliberately stays set, so the row remains invisible
    // to every ordinary query, and `purgedAt` is what makes restore refuse.
    it('leaves the row soft-deleted rather than resurrecting it', async () => {
      await runPurge();
      const payload = callArg<Record<string, unknown>>(
        mockTransactionalRepo.update,
        0,
        1,
      );
      expect(payload).not.toHaveProperty('deletedAt');
    });
  });

  describe('purge candidacy vs. the restore window', () => {
    /**
     * The two boundaries must be exact complements: anything the restore path
     * still accepts must not be a purge candidate, and vice versa. A
     * mismatch either purges an account the UI just promised was recoverable,
     * or strands a row nothing will ever clean up.
     */
    it('cutoff and restore deadline meet exactly at the retention boundary', async () => {
      mockUsersRepository.find.mockResolvedValueOnce([]);
      const now = new Date('2026-09-07T12:00:00.000Z');

      await service.findPurgeCandidateIds(now);

      const cutoff = callArg<{
        where: { deletedAt: FindOperator<Date> };
      }>(mockUsersRepository.find, 0, 0).where.deletedAt.value;

      // An account deleted at the cutoff is restorable until exactly `now`,
      // and `deleted_at < cutoff` excludes it — so day 30 belongs to the user.
      expect(addDays(cutoff, VARIABLES.SOFT_DELETE_RETENTION_DAYS)).toEqual(
        now,
      );
    });
  });
});

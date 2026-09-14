import { Test, TestingModule } from '@nestjs/testing';
import { UsersService } from './users.service';
import { getRepositoryToken } from '@nestjs/typeorm';
import { User } from './entities/user.entity';
import { ArtisanProfile } from './entities/artisan-profile.entity';
import { CustomerProfile } from './entities/customer-profile.entity';
import { Address } from './entities/address.entity';
import { ServiceEntity } from '@services/entities/service.entity';
import { UserTokenService } from './token.service';
import { AccountCommitmentsService } from './account-commitments.service';
import { CreateUserDto } from './dto/create-user.dto';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { UserAlreadyExists } from '@common/exceptions/user-already-exists.exception';
import { Role } from '@common/types/enums';
import { SUCCESS_MESSAGES } from '@common/constants/success-messages.constants';
import { VARIABLES } from '@common/constants/variables.constants';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { MailEvent } from 'mail/events/mail.events';
import { AccountNotRestorableException } from '@common/exceptions/account-not-restorable.exception';
import { addDays, subDays } from 'date-fns';
import type { FindOperator } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { hashEmailForLog } from '@common/utils/log-identifier.util';

describe('UsersService', () => {
  let service: UsersService;

  const mockUser = {
    id: 1,
    email: 'test@example.com',
    password: 'hashed',
    firstname: 'Test',
    role: Role.CUSTOMER,
  } as User;

  /**
   * Transaction callbacks in this service take an `EntityManager` and use
   * `manager.getRepository(User)`. The mock hands back one shared repository
   * so a test can drive the locked read and assert the write.
   */
  const mockTransactionalRepo = {
    findOne: jest.fn(),
    restore: jest.fn(),
    update: jest.fn(),
  };

  const mockUsersRepository = {
    create: jest.fn(),
    save: jest.fn(),
    find: jest.fn(),
    findOne: jest.fn(),
    update: jest.fn(),
    delete: jest.fn(),
    softDelete: jest.fn(),
    manager: {
      transaction: jest.fn((cb: (m: unknown) => unknown): unknown =>
        cb({ getRepository: () => mockTransactionalRepo }),
      ),
    },
  };
  const mockArtisanProfilesRepository = {
    create: jest.fn(),
    save: jest.fn(),
    findOne: jest.fn(),
  };
  const mockCustomerProfilesRepository = {
    create: jest.fn(),
    save: jest.fn(),
    findOne: jest.fn(),
  };
  const mockAddressesRepository = {
    create: jest.fn(),
    save: jest.fn(),
    findOne: jest.fn(),
    remove: jest.fn(),
  };
  const mockServicesRepository = {
    findBy: jest.fn(),
  };
  const mockUserTokenService = {
    revokeRefreshTokenForUser: jest.fn(),
  };
  const mockAccountCommitments = {
    assertDeletable: jest.fn(),
  };
  const mockEmitter = {
    emit: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: getRepositoryToken(User), useValue: mockUsersRepository },
        {
          provide: getRepositoryToken(ArtisanProfile),
          useValue: mockArtisanProfilesRepository,
        },
        {
          provide: getRepositoryToken(CustomerProfile),
          useValue: mockCustomerProfilesRepository,
        },
        {
          provide: getRepositoryToken(Address),
          useValue: mockAddressesRepository,
        },
        {
          provide: getRepositoryToken(ServiceEntity),
          useValue: mockServicesRepository,
        },
        { provide: UserTokenService, useValue: mockUserTokenService },
        {
          provide: AccountCommitmentsService,
          useValue: mockAccountCommitments,
        },
        { provide: EventEmitter2, useValue: mockEmitter },
      ],
    }).compile();

    service = module.get<UsersService>(UsersService);
    jest.clearAllMocks();
    // Default to "nothing outstanding" so the pre-existing deleteMe tests
    // don't each have to know about the C1.1 guard.
    mockAccountCommitments.assertDeletable.mockResolvedValue(undefined);
    mockUsersRepository.manager.transaction.mockImplementation(
      (cb: (m: unknown) => unknown): unknown =>
        cb({ getRepository: () => mockTransactionalRepo }),
    );
  });

  describe('createUser', () => {
    it('should throw BadRequestException if email is missing', async () => {
      await expect(
        service.createUser({ password: 'pass' } as CreateUserDto),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw UserAlreadyExists if user already exists', async () => {
      mockUsersRepository.findOne.mockResolvedValueOnce(mockUser);
      const dto: CreateUserDto = {
        email: mockUser.email,
        password: 'pass',
      } as CreateUserDto;
      await expect(service.createUser(dto)).rejects.toThrow(UserAlreadyExists);
    });

    it('should create and save a CUSTOMER user with an auto-provisioned customer profile', async () => {
      const dto: CreateUserDto = {
        email: 'new@example.com',
        password: 'pass',
        role: Role.CUSTOMER,
      } as CreateUserDto;
      const created = { ...dto, id: 2, password: 'hashed' };
      mockUsersRepository.findOne.mockResolvedValueOnce(null); // no existing user
      mockUsersRepository.create.mockReturnValueOnce(created);
      mockUsersRepository.save.mockResolvedValueOnce(created);
      mockCustomerProfilesRepository.create.mockReturnValueOnce({
        user: created,
      });
      mockCustomerProfilesRepository.save.mockResolvedValueOnce({});

      const result = await service.createUser(dto);

      expect(mockUsersRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ email: dto.email }),
      );
      expect(mockUsersRepository.save).toHaveBeenCalledWith(created);
      expect(mockCustomerProfilesRepository.save).toHaveBeenCalled();
      expect(result).toEqual({
        message: SUCCESS_MESSAGES.USER.CREATED,
        data: created,
      });
    });
  });

  describe('findUserByEmail', () => {
    it('should throw NotFoundException if email is missing', async () => {
      await expect(
        service.findUserByEmail(undefined as unknown as string),
      ).rejects.toThrow(NotFoundException);
    });

    it('should return the user if found', async () => {
      mockUsersRepository.findOne.mockResolvedValueOnce(mockUser);
      const result = await service.findUserByEmail(mockUser.email);

      expect(mockUsersRepository.findOne).toHaveBeenCalledWith({
        where: { email: mockUser.email },
      });
      expect(result).toEqual(mockUser);
    });

    it('should return null if user not found', async () => {
      mockUsersRepository.findOne.mockResolvedValueOnce(null);
      const result = await service.findUserByEmail('notfound@example.com');
      expect(result).toBeNull();
    });

    /**
     * Item 5 (security `M5`): `JwtStrategy.validate()` resolves the caller
     * through this method on every authenticated request, which made this one
     * line the highest-volume source of email addresses in the log store — and
     * a log line outlives the purge that scrubs the address from the database.
     *
     * The second assertion is the one that matters most: the line must be
     * *identical* whether or not a row was found, or log read access becomes
     * an account-enumeration oracle on the busiest line in the application.
     */
    it('logs a correlation hash instead of the address, identically found or not', async () => {
      const email = 'log-hygiene@example.com';
      const loggerSpy = jest
        .spyOn(service['logger'], 'log')
        .mockImplementation(() => {});
      const readLines = () =>
        (loggerSpy.mock.calls as unknown[][]).map((call) => String(call[0]));

      mockUsersRepository.findOne.mockResolvedValueOnce(mockUser);
      await service.findUserByEmail(email);
      const whenFound = readLines();

      loggerSpy.mockClear();
      mockUsersRepository.findOne.mockResolvedValueOnce(null);
      await service.findUserByEmail(email);
      const whenMissing = readLines();

      for (const line of [...whenFound, ...whenMissing]) {
        expect(line).not.toContain(email);
        expect(line).not.toContain('log-hygiene');
        expect(line).not.toContain('example.com');
      }
      expect(whenFound).toContain(
        `Finding user by email hash ${hashEmailForLog(email)}`,
      );
      expect(whenMissing).toEqual(whenFound);

      loggerSpy.mockRestore();
    });
  });

  describe('findMe', () => {
    it('should throw NotFoundException when the user does not exist', async () => {
      mockUsersRepository.findOne.mockResolvedValueOnce(null);
      await expect(service.findMe(999)).rejects.toThrow(NotFoundException);
    });

    it('should return the wrapped user profile when found', async () => {
      mockUsersRepository.findOne.mockResolvedValueOnce(mockUser);
      const result = await service.findMe(mockUser.id);
      expect(result.message).toBe(SUCCESS_MESSAGES.USER.RETRIEVED);
      expect(result.data.id).toBe(mockUser.id);
    });
  });

  describe('deleteMe', () => {
    const deletedAt = new Date('2026-09-07T10:15:00.000Z');

    it('should throw NotFoundException when the user does not exist', async () => {
      mockUsersRepository.findOne.mockResolvedValueOnce(null);
      await expect(service.deleteMe(999)).rejects.toThrow(NotFoundException);
    });

    it('should revoke refresh tokens and soft-delete the user', async () => {
      mockUsersRepository.findOne
        .mockResolvedValueOnce(mockUser)
        .mockResolvedValueOnce({ ...mockUser, deletedAt });

      const result = await service.deleteMe(mockUser.id);

      expect(
        mockUserTokenService.revokeRefreshTokenForUser,
      ).toHaveBeenCalledWith(mockUser.id);
      expect(mockUsersRepository.softDelete).toHaveBeenCalledWith({
        id: mockUser.id,
      });
      expect(result.message).toBe(SUCCESS_MESSAGES.USER.DELETED);
    });

    // C1.2: the client must never compute the deadline itself.
    it('returns the server-computed purge date, deletedAt + the retention window', async () => {
      mockUsersRepository.findOne
        .mockResolvedValueOnce(mockUser)
        .mockResolvedValueOnce({ ...mockUser, deletedAt });

      const { data } = await service.deleteMe(mockUser.id);

      expect(data.deletedAt).toEqual(deletedAt);
      expect(data.purgeAt).toEqual(
        addDays(deletedAt, VARIABLES.SOFT_DELETE_RETENTION_DAYS),
      );
      expect(data.retentionDays).toBe(VARIABLES.SOFT_DELETE_RETENTION_DAYS);
    });

    // C1.5: unconditional, and carries the same purge date the response does.
    it('emits the deletion-confirmation email with the purge date', async () => {
      mockUsersRepository.findOne
        .mockResolvedValueOnce(mockUser)
        .mockResolvedValueOnce({ ...mockUser, deletedAt });

      await service.deleteMe(mockUser.id);

      expect(mockEmitter.emit).toHaveBeenCalledWith(
        MailEvent.ACCOUNT_DELETED,
        expect.objectContaining({
          email: mockUser.email,
          deletedAt,
          purgeAt: addDays(deletedAt, VARIABLES.SOFT_DELETE_RETENTION_DAYS),
        }),
      );
    });

    // C1.1: the refusal must leave the account completely untouched — no
    // soft-delete, and crucially no token revocation, or a refused deletion
    // would still log the user out of every device.
    it('refuses deletion and touches nothing when the account has live commitments', async () => {
      mockUsersRepository.findOne.mockResolvedValueOnce(mockUser);
      mockAccountCommitments.assertDeletable.mockRejectedValueOnce(
        new ConflictException('blocked'),
      );

      await expect(service.deleteMe(mockUser.id)).rejects.toThrow(
        ConflictException,
      );

      expect(mockUsersRepository.softDelete).not.toHaveBeenCalled();
      expect(
        mockUserTokenService.revokeRefreshTokenForUser,
      ).not.toHaveBeenCalled();
      expect(mockEmitter.emit).not.toHaveBeenCalled();
    });
  });

  describe('isEmailRegistered (C1.6)', () => {
    it('should throw NotFoundException if email is missing', async () => {
      await expect(
        service.isEmailRegistered(undefined as unknown as string),
      ).rejects.toThrow(NotFoundException);
    });

    // The point of the method: registration must see soft-deleted rows, so a
    // deleted address is rejected by the app's own `UserAlreadyExists` rather
    // than falling through to the unique constraint (which produced a
    // *different* 409 and leaked the deleted state).
    it('looks past the soft-delete filter', async () => {
      mockUsersRepository.findOne.mockResolvedValueOnce(null);

      await service.isEmailRegistered('gone@example.com');

      const options = (
        mockUsersRepository.findOne.mock.calls as unknown[][]
      )[0][0] as { where: { email: string }; withDeleted: boolean };
      expect(options.withDeleted).toBe(true);
      expect(options.where.email).toBe('gone@example.com');
      // No `deletedAt` predicate: live *and* deleted rows both count as taken.
      expect(options.where).not.toHaveProperty('deletedAt');
    });

    it('reports taken for a soft-deleted row and free for no row', async () => {
      mockUsersRepository.findOne.mockResolvedValueOnce({ id: 42 });
      await expect(service.isEmailRegistered('gone@example.com')).resolves.toBe(
        true,
      );

      mockUsersRepository.findOne.mockResolvedValueOnce(null);
      await expect(service.isEmailRegistered('free@example.com')).resolves.toBe(
        false,
      );
    });

    // Nothing about the account may reach an unauthenticated caller — the
    // answer is a boolean, and only the id is even selected.
    it('returns a boolean and loads nothing but the id', async () => {
      mockUsersRepository.findOne.mockResolvedValueOnce({ id: 42 });

      const result = await service.isEmailRegistered('gone@example.com');

      expect(typeof result).toBe('boolean');
      const options = (
        mockUsersRepository.findOne.mock.calls as unknown[][]
      )[0][0] as { select: string[] };
      expect(options.select).toEqual(['id']);
    });
  });

  /**
   * C1.4: the timing half of "these outcomes must be indistinguishable".
   * `bcrypt.compare` used to run only where a hash was found, so a branch with
   * no account (or a social-only account) returned in single-digit
   * milliseconds against ~half a second — a clean, repeatable signal from one
   * unauthenticated request. Every path now costs exactly one comparison.
   */
  describe('constant-cost password checks (C1.4)', () => {
    /**
     * A bcrypt comparison at `SALT_OR_ROUNDS` (12) takes hundreds of
     * milliseconds on any machine this runs on, while skipping it takes
     * microseconds — the gap the finding measured was ~60–80x. 25ms is far
     * below the real cost and far above scheduling noise, so "did this path
     * actually do the work" is a stable question to ask.
     *
     * `bcrypt` is a native binding whose exports cannot be redefined, so this
     * is asserted by cost rather than by spying on `compare`.
     */
    const MIN_BCRYPT_MS = 25;

    const elapsed = async (run: () => Promise<unknown>): Promise<number> => {
      const started = Date.now();
      await run();
      return Date.now() - started;
    };

    it('spendPasswordCheckCost actually performs a comparison', async () => {
      const cost = await elapsed(() =>
        service.spendPasswordCheckCost('whatever-was-submitted'),
      );
      expect(cost).toBeGreaterThan(MIN_BCRYPT_MS);
    });

    it('tolerates a missing password without throwing (a rejection path must never 500)', async () => {
      await expect(
        service.spendPasswordCheckCost(undefined as unknown as string),
      ).resolves.toBeUndefined();
    });

    // The row exists but has no stored hash (a soft-deleted Google-only
    // account). It must still cost a comparison, and must never report a match.
    it('still costs a comparison for an account with no stored hash', async () => {
      mockUsersRepository.findOne.mockResolvedValueOnce({ password: null });

      let result: { hasPassword: boolean; isValid: boolean } | undefined;
      const cost = await elapsed(async () => {
        result = await service.getSoftDeletedPasswordCheckResult('pw', 1);
      });

      expect(result).toEqual({ hasPassword: false, isValid: false });
      expect(cost).toBeGreaterThan(MIN_BCRYPT_MS);
    });

    // The property that closes the oracle: a wrong password against a real
    // hash and a check with no hash at all cost the same order of magnitude.
    it('costs the same order of magnitude with and without a stored hash', async () => {
      const realHash = await bcrypt.hash('correct', VARIABLES.SALT_OR_ROUNDS);

      mockUsersRepository.findOne.mockResolvedValueOnce({
        password: realHash,
      });
      const withHash = await elapsed(() =>
        service.getSoftDeletedPasswordCheckResult('wrong', 1),
      );

      mockUsersRepository.findOne.mockResolvedValueOnce({ password: null });
      const withoutHash = await elapsed(() =>
        service.getSoftDeletedPasswordCheckResult('wrong', 1),
      );

      const ratio =
        Math.max(withHash, withoutHash) /
        Math.max(1, Math.min(withHash, withoutHash));
      expect(ratio).toBeLessThan(3);
    });
  });

  describe('findSoftDeletedUserByEmail (C1.4)', () => {
    // The safety property: this lookup is structurally incapable of returning
    // a live account or a purged one, so widening login's visibility cannot
    // make soft-deleted users authenticable anywhere else.
    it('constrains the query to rows that are deleted and not purged', async () => {
      mockUsersRepository.findOne.mockResolvedValueOnce(null);

      await service.findSoftDeletedUserByEmail('gone@example.com');

      // `jest.Mock.mock.calls` is `any[][]`, which the repo's type-safety
      // lint rules refuse — narrow it once, explicitly.
      const options = (
        mockUsersRepository.findOne.mock.calls as unknown[][]
      )[0][0] as {
        where: {
          email: string;
          deletedAt: FindOperator<unknown>;
          purgedAt: FindOperator<unknown>;
        };
        withDeleted: boolean;
      };
      expect(options.withDeleted).toBe(true);
      expect(options.where.email).toBe('gone@example.com');
      // `deletedAt IS NOT NULL` — not merely `withDeleted: true`, which alone
      // would also match live rows.
      expect(options.where.deletedAt.type).toBe('not');
      expect(options.where.deletedAt.child?.type).toBe('isNull');
      // `purged_at IS NULL` — a purged account is never resolvable by email.
      expect(options.where.purgedAt.type).toBe('isNull');
    });
  });

  describe('restoreAccountById (C1.4/C1.7/C1.8)', () => {
    it('clears deletedAt for an account inside its window', async () => {
      const user = { ...mockUser, deletedAt: subDays(new Date(), 3) };
      mockTransactionalRepo.findOne
        .mockResolvedValueOnce(user)
        .mockResolvedValueOnce({ ...mockUser, deletedAt: undefined });

      const restored = await service.restoreAccountById(mockUser.id);

      expect(mockTransactionalRepo.restore).toHaveBeenCalledWith({
        id: mockUser.id,
      });
      expect(restored.deletedAt).toBeUndefined();
    });

    it('takes a write lock on the row so a concurrent purge cannot interleave', async () => {
      const user = { ...mockUser, deletedAt: subDays(new Date(), 3) };
      mockTransactionalRepo.findOne
        .mockResolvedValueOnce(user)
        .mockResolvedValueOnce({ ...mockUser, deletedAt: undefined });

      await service.restoreAccountById(mockUser.id);

      expect(mockTransactionalRepo.findOne).toHaveBeenCalledWith(
        expect.objectContaining({
          withDeleted: true,
          lock: { mode: 'pessimistic_write' },
        }),
      );
    });

    // C1.8: this is the "restore after purge is impossible by construction"
    // guarantee. It is checked inside the same lock the purge takes, so there
    // is no window in which it could succeed — and it is a clean 410, not a
    // 500 and not a half-anonymized-but-authenticable account.
    it('refuses a purged account permanently, and never writes', async () => {
      mockTransactionalRepo.findOne.mockResolvedValueOnce({
        ...mockUser,
        deletedAt: subDays(new Date(), 45),
        purgedAt: subDays(new Date(), 15),
      });

      await expect(service.restoreAccountById(mockUser.id)).rejects.toThrow(
        AccountNotRestorableException,
      );
      expect(mockTransactionalRepo.restore).not.toHaveBeenCalled();
    });

    it('refuses an account past its recovery window, and never writes', async () => {
      mockTransactionalRepo.findOne.mockResolvedValueOnce({
        ...mockUser,
        deletedAt: subDays(
          new Date(),
          VARIABLES.SOFT_DELETE_RETENTION_DAYS + 1,
        ),
      });

      await expect(service.restoreAccountById(mockUser.id)).rejects.toThrow(
        AccountNotRestorableException,
      );
      expect(mockTransactionalRepo.restore).not.toHaveBeenCalled();
    });

    // The boundary favours the user: exactly at the retention limit is still
    // restorable, and is not a purge candidate either (see
    // account-purge.service.spec.ts). Time is frozen because "exactly 30 days
    // ago" is a single instant — without it the few milliseconds the test
    // itself takes would push the account past the edge and the assertion
    // would be testing day 30-plus-epsilon instead.
    it('still restores an account at exactly the retention boundary', async () => {
      const frozenNow = new Date('2026-09-07T12:00:00.000Z');
      jest.useFakeTimers({ now: frozenNow });
      try {
        const deletedAt = subDays(
          frozenNow,
          VARIABLES.SOFT_DELETE_RETENTION_DAYS,
        );
        mockTransactionalRepo.findOne
          .mockResolvedValueOnce({ ...mockUser, deletedAt })
          .mockResolvedValueOnce({ ...mockUser, deletedAt: undefined });

        await expect(
          service.restoreAccountById(mockUser.id),
        ).resolves.toBeDefined();
        expect(mockTransactionalRepo.restore).toHaveBeenCalled();
      } finally {
        jest.useRealTimers();
      }
    });

    it('is idempotent — restoring an already-active account is a no-op', async () => {
      mockTransactionalRepo.findOne.mockResolvedValueOnce({
        ...mockUser,
        deletedAt: undefined,
      });

      await expect(
        service.restoreAccountById(mockUser.id),
      ).resolves.toBeDefined();
      expect(mockTransactionalRepo.restore).not.toHaveBeenCalled();
    });
  });

  /**
   * C2: the two bugs behind the profile-completeness gate. `missingFields`
   * was absent from both of these routes' responses, and the PATCH — the one
   * both the Profile page and the Settings page save through — never
   * recomputed `isProfileComplete`, so an artisan could fill in every
   * required field, save successfully, and stay invisible in search.
   */
  describe('artisan profile completeness (C2)', () => {
    const completeProfile = {
      id: 5,
      bio: 'Ten years of plumbing across Accra.',
      hourlyRate: 80,
      location: 'Accra',
      services: [{ id: 1, name: 'Plumbing' }],
      isProfileComplete: true,
      user: { id: 1, addresses: [] },
    };

    describe('findArtisanProfileByUserId', () => {
      it('returns an empty missingFields array — present, not absent — for a complete profile', async () => {
        mockArtisanProfilesRepository.findOne.mockResolvedValueOnce(
          completeProfile,
        );

        const { data } = await service.findArtisanProfileByUserId(1);

        expect(data.missingFields).toEqual([]);
        expect(data.isProfileComplete).toBe(true);
      });

      it('lists exactly the missing required fields for an incomplete profile', async () => {
        mockArtisanProfilesRepository.findOne.mockResolvedValueOnce({
          ...completeProfile,
          bio: '   ',
          hourlyRate: null,
          isProfileComplete: false,
        });

        const { data } = await service.findArtisanProfileByUserId(1);

        expect(data.missingFields).toEqual(['bio', 'hourlyRate']);
        expect(data.isProfileComplete).toBe(false);
      });

      it('reports a missing service when none are linked', async () => {
        mockArtisanProfilesRepository.findOne.mockResolvedValueOnce({
          ...completeProfile,
          services: [],
          isProfileComplete: false,
        });

        const { data } = await service.findArtisanProfileByUserId(1);
        expect(data.missingFields).toEqual(['services']);
      });
    });

    describe('updateArtisanProfile', () => {
      // The C2.2 bug: this used to save without recomputing, leaving the
      // artisan flagged incomplete and hidden from search forever.
      it('flips isProfileComplete to true and persists it when the last field is filled in', async () => {
        const incomplete = {
          ...completeProfile,
          bio: '',
          isProfileComplete: false,
        };
        mockArtisanProfilesRepository.findOne
          .mockResolvedValueOnce(incomplete)
          .mockResolvedValueOnce({
            ...incomplete,
            bio: 'A real bio.',
            isProfileComplete: true,
          });
        mockArtisanProfilesRepository.save.mockImplementation(
          (p: unknown): unknown => Promise.resolve(p),
        );

        const { data } = await service.updateArtisanProfile(1, {
          bio: 'A real bio.',
        });

        expect(mockArtisanProfilesRepository.save).toHaveBeenCalledWith(
          expect.objectContaining({ isProfileComplete: true }),
        );
        expect(data.isProfileComplete).toBe(true);
        expect(data.missingFields).toEqual([]);
      });

      it('flips isProfileComplete to false when a required field is cleared', async () => {
        mockArtisanProfilesRepository.findOne
          .mockResolvedValueOnce({ ...completeProfile })
          .mockResolvedValueOnce({
            ...completeProfile,
            location: '',
            isProfileComplete: false,
          });
        mockArtisanProfilesRepository.save.mockImplementation(
          (p: unknown): unknown => Promise.resolve(p),
        );

        const { data } = await service.updateArtisanProfile(1, {
          location: '',
        });

        expect(mockArtisanProfilesRepository.save).toHaveBeenCalledWith(
          expect.objectContaining({ isProfileComplete: false }),
        );
        expect(data.missingFields).toEqual(['location']);
      });

      /**
       * The settings page and the profile page PATCH this same route with
       * different field subsets. Completeness must be judged on the post-merge
       * profile, or a payload that only mentions `location` would look
       * incomplete purely because it didn't also restate the bio and rate.
       */
      it('computes against the post-merge profile, not the request body alone', async () => {
        mockArtisanProfilesRepository.findOne
          .mockResolvedValueOnce({ ...completeProfile })
          .mockResolvedValueOnce({ ...completeProfile, location: 'Kumasi' });
        mockArtisanProfilesRepository.save.mockImplementation(
          (p: unknown): unknown => Promise.resolve(p),
        );

        // A settings-page-shaped payload: only the one field it owns.
        await service.updateArtisanProfile(1, { location: 'Kumasi' });

        expect(mockArtisanProfilesRepository.save).toHaveBeenCalledWith(
          expect.objectContaining({
            isProfileComplete: true,
            location: 'Kumasi',
            bio: completeProfile.bio,
            hourlyRate: completeProfile.hourlyRate,
          }),
        );
      });

      it('recomputes after a serviceIds replacement, not just field edits', async () => {
        mockArtisanProfilesRepository.findOne
          .mockResolvedValueOnce({ ...completeProfile })
          .mockResolvedValueOnce({
            ...completeProfile,
            services: [],
            isProfileComplete: false,
          });
        mockArtisanProfilesRepository.save.mockImplementation(
          (p: unknown): unknown => Promise.resolve(p),
        );

        const { data } = await service.updateArtisanProfile(1, {
          serviceIds: [],
        });

        expect(mockArtisanProfilesRepository.save).toHaveBeenCalledWith(
          expect.objectContaining({ isProfileComplete: false }),
        );
        expect(data.missingFields).toEqual(['services']);
      });
    });
  });

  describe('findOne', () => {
    it('should query by id, selecting only the password column', async () => {
      mockUsersRepository.findOne.mockResolvedValueOnce(mockUser);
      const result = await service.findOne(mockUser.id);

      expect(mockUsersRepository.findOne).toHaveBeenCalledWith({
        where: { id: mockUser.id },
        select: ['password'],
      });
      expect(result).toEqual(mockUser);
    });
  });

  describe('remove', () => {
    it('should delete the user by id', async () => {
      await service.remove(mockUser.id);
      expect(mockUsersRepository.delete).toHaveBeenCalledWith(mockUser.id);
    });
  });
});

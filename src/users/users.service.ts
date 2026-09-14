import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { UpdateMeDto } from './dto/update-me.dto';
import { UserResponseDto } from './dto/user-response.dto';
import { InjectRepository } from '@nestjs/typeorm';
import { User } from './entities/user.entity';
import { EntityManager, In, IsNull, Not, Repository } from 'typeorm';
import { UserAlreadyExists } from '@common/exceptions/user-already-exists.exception';
import { ERROR_MESSAGES } from '@common/constants/error-messages.constants';
import { SUCCESS_MESSAGES } from '@common/constants/success-messages.constants';
import * as bcrypt from 'bcrypt';
import { VARIABLES } from '@common/constants/variables.constants';
import { ArtisanProfile } from './entities/artisan-profile.entity';
import { CustomerProfile } from './entities/customer-profile.entity';
import { Address } from './entities/address.entity';
import { UpdateArtisanProfileDto } from './dto/update-artisan-profile.dto';
import { UpdateCustomerProfileDto } from './dto/update-customer-profile.dto';
import { CreateAddressDto } from './dto/create-address.dto';
import { UpdateAddressDto } from './dto/update-address.dto';
import { AddressResponseDto } from './dto/address-response.dto';
import { Role } from '@common/types/enums';
import { plainToInstance } from 'class-transformer';
import { ArtisanProfileResponseDto } from './dto/artisan-profile-response.dto';
import { CustomerProfileResponseDto } from './dto/customer-profile-response.dto';
import { ServiceEntity } from '@services/entities/service.entity';
import { UserTokenService } from './token.service';
import { computeProfileCompleteness } from '@artisans/artisans.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { MailEvent } from 'mail/events/mail.events';
import type { AccountDeletedPayload } from 'mail/events/mail.events';
import { AccountCommitmentsService } from './account-commitments.service';
import { DeleteAccountResponseDto } from './dto/delete-account-response.dto';
import { AccountNotRestorableException } from '@common/exceptions/account-not-restorable.exception';
import {
  isWithinRecoveryWindow,
  purgeDateFor,
} from '@common/utils/account-recovery.util';
import { randomUUID } from 'node:crypto';
import { hashEmailForLog } from '@common/utils/log-identifier.util';

/**
 * A real bcrypt hash, at the application's configured cost factor, of a random
 * value that is never stored anywhere and can therefore never be submitted.
 *
 * It exists so that a credential check with **no hash to compare against**
 * (no such account, or a social-only account) still costs the same ~half
 * second as one that does. Without it, `bcrypt.compare` ran only on the
 * branches where a matching row was found, and the response time alone
 * separated "this address is registered" (and, on the restore endpoint,
 * "this address has a deleted account still inside its recovery window") from
 * "this address is unknown" — a ~60–80x signal that needed one unauthenticated
 * request per address to read.
 *
 * Generated rather than hardcoded so it always tracks `SALT_OR_ROUNDS`;
 * kicked off eagerly at module load (not awaited — bcrypt's async form runs on
 * the thread pool) so no request ever pays for producing it, and memoized so
 * exactly one is ever made per process.
 *
 * Matching it is worthless by construction: the comparison's result is
 * discarded and the caller is told `hasPassword: false, isValid: false`
 * regardless.
 */
let dummyPasswordHash: Promise<string> | null = null;
function getDummyPasswordHash(): Promise<string> {
  dummyPasswordHash ??= bcrypt.hash(randomUUID(), VARIABLES.SALT_OR_ROUNDS);
  return dummyPasswordHash;
}
void getDummyPasswordHash();

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);
  constructor(
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
    @InjectRepository(ArtisanProfile)
    private readonly artisanProfilesRepository: Repository<ArtisanProfile>,
    @InjectRepository(CustomerProfile)
    private readonly customerProfilesRepository: Repository<CustomerProfile>,
    @InjectRepository(Address)
    private readonly addressesRepository: Repository<Address>,
    @InjectRepository(ServiceEntity)
    private readonly servicesRepository: Repository<ServiceEntity>,
    private readonly userTokenService: UserTokenService,
    private readonly accountCommitments: AccountCommitmentsService,
    private readonly emitter: EventEmitter2,
  ) {}

  /**
   * Creates a new user account and auto-provisions the matching role profile
   * (artisan or customer). Password is bcrypt-hashed before persistence.
   *
   * @param createUserDto - Required fields for the new user.
   * @returns `{ message, data: User }` — callers that need the raw `User` entity
   *   (e.g. `AuthService`) should destructure: `const { data: user } = await createUser(dto)`.
   * @throws {BadRequestException} When no email is provided.
   * @throws {UserAlreadyExists} When a user with the same email already exists.
   */
  async createUser(
    createUserDto: CreateUserDto,
  ): Promise<{ message: string; data: User }> {
    const email = createUserDto.email;
    if (!email) {
      throw new BadRequestException('Provide User Email!');
    }

    const existingUser = await this.findUserByEmail(email);
    if (existingUser) {
      throw new UserAlreadyExists(
        ERROR_MESSAGES.USER.EMAIL_ALREADY_EXISTS(email),
      );
    }
    // G5: social signups (AuthService.registerSocialUser) call this with no
    // `password` — leave it null rather than hashing `undefined` (which
    // bcrypt rejects). Regular self-registration always supplies a password
    // (enforced by CreateUserDto's validators on the public register route).
    const hashedPassword = createUserDto.password
      ? await bcrypt.hash(createUserDto.password, VARIABLES.SALT_OR_ROUNDS)
      : null;
    const user = this.usersRepository.create({
      ...createUserDto,
      password: hashedPassword,
    });

    this.logger.log(`Created user with id: ${user.id}`);

    const savedUser = await this.usersRepository.save(user);

    if (savedUser.role === Role.ARTISAN) {
      const artisanProfile = this.artisanProfilesRepository.create({
        user: savedUser,
        bio: '',
        experienceYears: undefined,
        hourlyRate: undefined,
        businessName: '',
        averageRating: 0,
        totalReviews: 0,
        availabilityStatus: 'AVAILABLE',
        services: [],
      });
      await this.artisanProfilesRepository.save(artisanProfile);
    }

    if (savedUser.role === Role.CUSTOMER) {
      const customerProfile = this.customerProfilesRepository.create({
        user: savedUser,
        bio: '',
        preferredServices: [],
        budgetMin: undefined,
        budgetMax: undefined,
      });
      await this.customerProfilesRepository.save(customerProfile);
    }

    return { message: SUCCESS_MESSAGES.USER.CREATED, data: savedUser };
  }

  /**
   * Returns the full profile of the authenticated user, including their addresses.
   *
   * @param userId - The ID of the authenticated user (from `req.user.id`).
   * @returns `{ message, data: UserResponseDto }` with addresses populated.
   * @throws {NotFoundException} When no user with the given ID exists.
   */
  async findMe(
    userId: number,
  ): Promise<{ message: string; data: UserResponseDto }> {
    const user = await this.usersRepository.findOne({
      where: { id: userId },
      relations: ['addresses'],
    });

    if (!user) {
      throw new NotFoundException(`User with ID ${userId} not found`);
    }

    return {
      message: SUCCESS_MESSAGES.USER.RETRIEVED,
      data: plainToInstance(UserResponseDto, user, {
        excludeExtraneousValues: true,
      }),
    };
  }

  /**
   * Applies a partial update to the authenticated user's own base profile.
   * Email, password, and role changes are intentionally excluded — they each
   * require dedicated, security-sensitive flows.
   *
   * @param userId - The ID of the authenticated user (from `req.user.id`).
   * @param updateMeDto - Fields to update (all optional).
   * @returns `{ message, data: UserResponseDto }` reflecting the saved state.
   * @throws {NotFoundException} When no user with the given ID exists.
   */
  async updateMe(
    userId: number,
    updateMeDto: UpdateMeDto,
  ): Promise<{ message: string; data: UserResponseDto }> {
    const user = await this.usersRepository.findOne({
      where: { id: userId },
      relations: ['addresses'],
    });

    if (!user) {
      throw new NotFoundException(`User with ID ${userId} not found`);
    }

    Object.assign(user, updateMeDto);
    const saved = await this.usersRepository.save(user);
    this.logger.log(`User ${userId} updated their own profile`);

    return {
      message: SUCCESS_MESSAGES.USER.UPDATED,
      data: plainToInstance(UserResponseDto, saved, {
        excludeExtraneousValues: true,
      }),
    };
  }

  /**
   * Soft-deletes the authenticated user's account and revokes all active refresh tokens.
   * The record is retained in the database with a non-null `deletedAt` timestamp.
   *
   * C1.1: refused with a 409 while the account still has live commitments —
   * a pending/confirmed booking, an open or in-progress job, a payment still
   * in flight, or an unresolved dispute. A marketplace counterparty must not
   * be able to be abandoned mid-job, and money in flight must never be
   * stranded on an account that is going to be purged.
   *
   * C1.6: nothing about the account's data is modified, anonymized or
   * cascaded here beyond the one `deleted_at` stamp. That is precisely what
   * makes the 30-day restore meaningful — the record set is frozen exactly as
   * it was, so restoring is a single column going back to `NULL`.
   *
   * @param userId - The ID of the authenticated user (from `req.user.id`).
   * L4: also refused with a distinct 409 when the caller is an ADMIN and no
   * other usable admin account remains — the one deletion here that resolving
   * something cannot clear, and the one that is genuinely unrecoverable
   * (ADMIN is seed-only and there is no admin-side restore tooling).
   *
   * @returns `{ message, data }` carrying `deletedAt` and the server-computed
   *   purge date, so the client never computes the deadline itself.
   * @throws {NotFoundException} When no active user with the given ID exists.
   * @throws {ConflictException} When the account has live commitments (C1.1),
   *   or is the platform's last usable administrator (L4).
   */
  async deleteMe(
    userId: number,
  ): Promise<{ message: string; data: DeleteAccountResponseDto }> {
    const user = await this.usersRepository.findOne({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException(`User with ID ${userId} not found`);
    }

    // C1.1 + L4: checked before anything is mutated, so a refusal leaves the
    // account completely untouched (tokens included) and — per item 2 — the
    // controller clears no cookie. The role comes from the row just loaded,
    // never from the caller's token: the token is the thing an attacker would
    // hold, and this decides whether the last-administrator guard applies.
    await this.accountCommitments.assertDeletable(userId, user.role);

    await this.userTokenService.revokeRefreshTokenForUser(userId);
    await this.usersRepository.softDelete({ id: userId });
    this.logger.log(`User ${userId} soft-deleted their account`);

    // Read back the timestamp Postgres actually wrote rather than assuming
    // `new Date()`: the purge job compares against this exact value, and the
    // date we promise the user must be the date it enforces.
    const deleted = await this.usersRepository.findOne({
      where: { id: userId },
      withDeleted: true,
    });
    const deletedAt = deleted?.deletedAt ?? new Date();
    const purgeAt = purgeDateFor(deletedAt);

    // C1.5: unconditional — this email is the security notice for someone
    // whose account was deleted by another party, so it is not conditional on
    // any preference. Fire-and-forget: the listener log-and-swallows its own
    // failures, so a mail outage can never fail the deletion request.
    this.emitter.emit(MailEvent.ACCOUNT_DELETED, {
      email: user.email,
      firstname: user.firstname,
      deletedAt,
      purgeAt,
    } satisfies AccountDeletedPayload);

    return {
      message: SUCCESS_MESSAGES.USER.DELETED,
      data: plainToInstance(
        DeleteAccountResponseDto,
        {
          deletedAt,
          purgeAt,
          retentionDays: VARIABLES.SOFT_DELETE_RETENTION_DAYS,
        },
        { excludeExtraneousValues: true },
      ),
    };
  }

  /**
   * Stores an uploaded avatar filename and updates the user's `profilePicture` field
   * to the publicly accessible path `/uploads/avatars/<filename>`.
   *
   * @param userId - The ID of the authenticated user (from `req.user.id`).
   * @param filename - The filename assigned by Multer disk storage.
   * @returns `{ message, data: UserResponseDto }` with the updated profile picture URL.
   * @throws {NotFoundException} When no user with the given ID exists.
   */
  async updateAvatar(
    userId: number,
    url: string,
  ): Promise<{ message: string; data: UserResponseDto }> {
    const user = await this.usersRepository.findOne({
      where: { id: userId },
      relations: ['addresses'],
    });
    if (!user) {
      throw new NotFoundException(`User with ID ${userId} not found`);
    }
    user.profilePicture = url;
    const saved = await this.usersRepository.save(user);
    this.logger.log(`User ${userId} updated their avatar`);
    return {
      message: SUCCESS_MESSAGES.USER.AVATAR_UPLOADED,
      data: plainToInstance(UserResponseDto, saved, {
        excludeExtraneousValues: true,
      }),
    };
  }

  async findUserById(id: number): Promise<User | null> {
    if (!id) {
      throw new NotFoundException('User ID required');
    }
    this.logger.log(`Finding user with id ${id}`);
    return this.usersRepository.findOne({ where: { id } });
  }

  /**
   * Resolves a **live** account by email. Soft-deleted rows are excluded by
   * TypeORM's soft-delete filter, which is load-bearing well beyond login:
   * `JwtStrategy.validate()` resolves the caller through this method, so a
   * soft-deleted user's still-unexpired access token already fails closed.
   *
   * C1.4 deliberately did **not** widen this. The one place that needs to see
   * soft-deleted rows uses {@link findSoftDeletedUserByEmail} instead.
   */
  async findUserByEmail(email: string): Promise<User | null> {
    if (!email) {
      throw new NotFoundException('Email required');
    }
    // M5: this was the single highest-volume source of email addresses in the
    // log store — `JwtStrategy.validate()` resolves the caller through here on
    // *every* authenticated request — and a line in the log store outlives the
    // C1.7 purge that scrubs the address from the database, so "no recoverable
    // PII after purge" was true of the database only. There is no id to log
    // yet (the id is what this lookup is for), so the address is replaced with
    // a deterministic hash of it: support can still follow one account across
    // a request, and an operator who already knows an address can recompute
    // the key.
    //
    // Emitted before the lookup, and identically whether or not a row is
    // found. A found/not-found split on a line every request writes would hand
    // log readers an enumeration oracle that the response bodies deliberately
    // are not.
    this.logger.log(`Finding user by email hash ${hashEmailForLog(email)}`);
    return this.usersRepository.findOne({ where: { email } });
  }

  /**
   * C1.6: whether the address is already taken by **any** account — live or
   * soft-deleted. Registration's existence check, and nothing else.
   *
   * Deliberately not `findUserByEmail` (which excludes soft-deleted rows):
   * relying on that made a soft-deleted address fall through the application's
   * own `UserAlreadyExists` and get rejected by the `users.email` unique
   * constraint instead, which `TypeOrmFilter` renders with a *different*
   * message and no `meta.error`. One register probe could therefore classify
   * any address as live / deleted / free, which C1.6 forbids.
   *
   * Returns a boolean, not an entity: the caller must not be able to base
   * anything but "taken or not" on the answer, and nothing about a
   * soft-deleted account should be loaded by an unauthenticated request.
   *
   * A **purged** row is not a match — its email was overwritten with the
   * `deleted-user-<id>@deleted.invalid` placeholder, so the original address is
   * genuinely free again (Open Question 2's resolved behaviour).
   */
  async isEmailRegistered(email: string): Promise<boolean> {
    if (!email) {
      throw new NotFoundException('Email required');
    }
    const existing = await this.usersRepository.findOne({
      where: { email },
      withDeleted: true,
      select: ['id'],
    });
    return !!existing;
  }

  /**
   * C1.4: resolves a **soft-deleted, not-yet-purged** account by email — the
   * only lookup in the application that can see past the soft-delete filter.
   *
   * Two properties make this safe to add without soft-deleted accounts
   * becoming authenticable anywhere else:
   *
   * 1. It can *only* return a deleted row. `deletedAt: Not(IsNull())` is part
   *    of the predicate, not just `withDeleted: true`, so it is structurally
   *    incapable of resolving a live user and can never be mistaken for (or
   *    quietly substituted into) a general-purpose lookup.
   * 2. It excludes purged rows (`purgedAt: IsNull()`), so a purged account is
   *    never found here either — combined with the purge's scrubbed email and
   *    nulled password, that is what makes it indistinguishable from an
   *    address that was never registered (C1.7).
   *
   * Its two callers — the post-password-check branch of `loginUser()` and
   * `restoreAccount()` — both verify credentials before acting on the result.
   * Nothing here authenticates anybody.
   */
  async findSoftDeletedUserByEmail(email: string): Promise<User | null> {
    if (!email) {
      throw new NotFoundException('Email required');
    }
    return this.usersRepository.findOne({
      where: { email, deletedAt: Not(IsNull()), purgedAt: IsNull() },
      withDeleted: true,
    });
  }

  /**
   * C1.4: password check for a soft-deleted account, used to prove ownership
   * before either the pending-deletion login rejection or a restore is
   * allowed to happen.
   *
   * A separate, explicitly-named method rather than a `withDeleted` flag on
   * {@link getPasswordCheckResult}: like {@link findSoftDeletedUserByEmail},
   * it constrains itself to `deletedAt IS NOT NULL AND purged_at IS NULL`, so
   * it cannot be repurposed to authenticate a live or purged account even by
   * accident. A purged row also has a null password hash, so it would fail
   * here regardless.
   */
  async getSoftDeletedPasswordCheckResult(
    password: string,
    userId: number,
  ): Promise<{ hasPassword: boolean; isValid: boolean }> {
    const user = await this.usersRepository.findOne({
      where: { id: userId, deletedAt: Not(IsNull()), purgedAt: IsNull() },
      withDeleted: true,
      select: ['password'],
    });
    return this.comparePasswordHash(password, user?.password ?? null);
  }

  /**
   * C1.4/C1.7: clears `deletedAt` on a soft-deleted account, under a row lock
   * so that this and a concurrent purge of the same account cannot both
   * proceed — exactly one wins, cleanly.
   *
   * The lock is what makes the day-30/31 race safe in both directions:
   * - **Restore wins**: `deletedAt` is `NULL` by the time the purge re-reads
   *   the row inside its own lock, so the purge skips it and takes no
   *   destructive action.
   * - **Purge wins**: `purgedAt` is set by the time this re-reads the row, so
   *   the restore fails with a clear "permanently deleted" 410 — never a 500,
   *   and never a half-anonymized row that is somehow authenticable again.
   *
   * The row is re-read **by ID inside the transaction** rather than trusting
   * the caller's earlier lookup, which is the whole point: the state that
   * matters is the state at the moment the lock is held.
   *
   * Restoring is a single column going back to `NULL` — no relationship is
   * touched, because C1.6 guarantees none of them were touched during the
   * window (profile, services, portfolio, jobs, bookings, reviews,
   * favourites and payout details are all still attached to this row).
   *
   * Idempotent: restoring an already-live account is a no-op that returns the
   * account.
   *
   * @throws {AccountNotRestorableException} When already purged, or past the
   *   recovery window.
   * @throws {NotFoundException} When no such row exists at all.
   */
  async restoreAccountById(userId: number): Promise<User> {
    return this.usersRepository.manager.transaction(
      async (manager: EntityManager) => {
        const repo = manager.getRepository(User);
        const locked = await repo.findOne({
          where: { id: userId },
          withDeleted: true,
          lock: { mode: 'pessimistic_write' },
        });

        if (!locked) {
          throw new NotFoundException(`User with ID ${userId} not found`);
        }

        // C1.8: restoration after purge is refused here, in the same lock the
        // purge itself takes, so there is no window in which it could succeed.
        if (locked.purgedAt) {
          this.logger.warn(
            `Refused restore of purged account ${userId} (purged at ${locked.purgedAt.toISOString()})`,
          );
          throw AccountNotRestorableException.permanentlyDeleted();
        }

        if (!locked.deletedAt) {
          this.logger.log(
            `Restore requested for account ${userId} that is already active`,
          );
          return locked;
        }

        if (!isWithinRecoveryWindow(locked.deletedAt)) {
          this.logger.warn(
            `Refused restore of account ${userId}: recovery window closed`,
          );
          throw AccountNotRestorableException.windowExpired();
        }

        // `restore()` is TypeORM's purpose-built inverse of `softDelete()`:
        // it sets `deleted_at` back to NULL and touches nothing else.
        await repo.restore({ id: userId });
        this.logger.log(`Restored soft-deleted account ${userId}`);

        const restored = await repo.findOne({ where: { id: userId } });
        if (!restored) {
          // Would mean the row vanished between the update and the read while
          // we hold its write lock — impossible, but never return a stale
          // still-deleted entity to a caller that is about to issue tokens.
          throw new NotFoundException(`User with ID ${userId} not found`);
        }
        return restored;
      },
    );
  }

  async validatePassword(password: string, userId: number): Promise<boolean> {
    const user = await this.usersRepository.findOne({
      where: { id: userId },
      select: ['password'],
    });
    if (!user) {
      throw new NotFoundException(`User with ID ${userId} not found`);
    }
    // G5/G10: social-only accounts have a null password — never a valid
    // match, and never pass a null hash into bcrypt.compare (it throws).
    if (!user.password) {
      return false;
    }
    return bcrypt.compare(password, user.password);
  }

  /**
   * G10: reports whether the account has a usable (non-null) password hash,
   * without ever loading or comparing it. Kept as a standalone helper for any
   * caller that only needs this one fact; `AuthService.loginUser()` uses
   * `getPasswordCheckResult()` instead so a single login attempt only pays
   * for one query (see below).
   */
  async hasUsablePassword(userId: number): Promise<boolean> {
    const user = await this.usersRepository.findOne({
      where: { id: userId },
      select: ['password'],
    });
    return !!user?.password;
  }

  /**
   * G10 efficiency fix: `AuthService.loginUser()` used to call
   * `hasUsablePassword()` and then, if that returned true, `validatePassword()`
   * — two independent `SELECT ... WHERE id = ?` queries for the same
   * password column on every single login attempt (not just Google ones).
   * This does both checks off one fetch instead. Never passes a null hash
   * into `bcrypt.compare` (mirrors `validatePassword()`'s own guard).
   *
   * @returns `hasPassword` — false for a social-only account (no usable
   *   password hash at all); `isValid` — true only when `hasPassword` is true
   *   AND the supplied password matches.
   */
  async getPasswordCheckResult(
    password: string,
    userId: number,
  ): Promise<{ hasPassword: boolean; isValid: boolean }> {
    const user = await this.usersRepository.findOne({
      where: { id: userId },
      select: ['password'],
    });
    return this.comparePasswordHash(password, user?.password ?? null);
  }

  /**
   * Shared bcrypt comparison for every password check in this service, so the
   * "a null hash is never a match" rule (G5/G10) is stated once instead of
   * re-implemented per call site.
   *
   * A null hash still costs one comparison — against
   * {@link getDummyPasswordHash}, result discarded — so that a social-only
   * account and an account with a password are not separable by response time.
   * The G5/G10 rule that a null hash never reaches `bcrypt.compare` is
   * preserved: the null is never the argument, the throwaway hash is.
   */
  private async comparePasswordHash(
    password: string,
    hash: string | null,
  ): Promise<{ hasPassword: boolean; isValid: boolean }> {
    if (!hash) {
      await this.spendPasswordCheckCost(password);
      return { hasPassword: false, isValid: false };
    }
    return { hasPassword: true, isValid: await bcrypt.compare(password, hash) };
  }

  /**
   * C1.4: spends exactly one bcrypt comparison and discards the result, so a
   * rejection path that never found an account costs the same as one that did.
   *
   * Call this on **every** credential-checking branch that returns without
   * comparing a real hash — `AuthService`'s "no live and no soft-deleted
   * account for this email" branch, and `restoreAccount`'s "nothing
   * restorable" branch. Both are the enumeration-critical paths: their bodies
   * are already byte-identical to the wrong-password rejection, and this is
   * what makes their *timing* identical too.
   *
   * Exactly one comparison per attempt is the invariant to preserve — not
   * "at least one". Two would be as distinguishable as none.
   */
  async spendPasswordCheckCost(password: string): Promise<void> {
    // `bcrypt.compare` throws on an undefined/null data argument; a rejection
    // path must never turn into a 500 because the body was odd, and an empty
    // string costs the same to compare as any other.
    await bcrypt.compare(password ?? '', await getDummyPasswordHash());
  }

  async findOne(id: number) {
    return this.usersRepository.findOne({
      where: { id },
      select: ['password'],
    });
  }

  async updateUser(id: number, updateUserDto: UpdateUserDto) {
    await this.usersRepository.update(id, updateUserDto);
    this.logger.log(`Updated user with id: ${id}`);
    return this.findOne(id);
  }

  async updateUserData(id: number, user: Partial<User>) {
    await this.usersRepository.update(id, user);
    this.logger.log(`Updated user data for user with id: ${id}`);
  }

  async remove(id: number) {
    await this.usersRepository.delete(id);
    this.logger.log(`Removed user with id: ${id}`);
  }

  /**
   * Returns the artisan profile for a given user, including linked services and
   * the user's base data with addresses.
   *
   * C2.1: the response carries a populated `missingFields` — always present,
   * `[]` when the profile is complete. It used to be silently absent on this
   * route (the DTO declared it, only `ArtisansService.toPrivate()` filled it,
   * and that is unreachable from here), which left the artisan-facing
   * completeness indicator with nothing to list.
   *
   * @param userId - The user ID whose artisan profile to retrieve.
   * @returns `{ message, data: ArtisanProfileResponseDto }`.
   * @throws {NotFoundException} When no artisan profile exists for the user.
   */
  async findArtisanProfileByUserId(
    userId: number,
  ): Promise<{ message: string; data: ArtisanProfileResponseDto }> {
    const profile = await this.artisanProfilesRepository.findOne({
      where: { user: { id: userId } },
      relations: ['user', 'user.addresses', 'services'],
    });

    if (!profile) {
      throw new NotFoundException(
        `Artisan profile for user id ${userId} not found`,
      );
    }

    return {
      message: SUCCESS_MESSAGES.ARTISAN_PROFILE.RETRIEVED,
      data: this.toArtisanProfileResponse(profile),
    };
  }

  /**
   * Applies a partial update to an artisan's profile, optionally replacing the
   * linked services list. Pass `serviceIds: []` to unlink all services.
   *
   * C2.2: recomputes and persists `isProfileComplete` on every save through
   * this route. This is the route both the Profile page and the Settings page
   * actually save through, and it previously never recomputed the flag — only
   * the `/artisans/me` routes did. The effect was that an artisan could fill
   * in every required field, save successfully, and stay flagged incomplete
   * and invisible in customer search indefinitely, unless they happened to
   * also add or remove a service afterwards.
   *
   * The recompute runs against the **post-merge** profile, not the request
   * body: the Profile page and the Settings page send different, overlapping
   * field subsets, so completeness has to be judged on the whole resulting
   * profile or a partial payload would look incomplete purely because it
   * didn't mention the other page's fields.
   *
   * @param userId - The user ID whose artisan profile to update.
   * @param updateArtisanProfileDto - Fields to update.
   * @returns `{ message, data: ArtisanProfileResponseDto }` reflecting the saved state.
   * @throws {NotFoundException} When the artisan profile or any requested service is not found.
   */
  async updateArtisanProfile(
    userId: number,
    updateArtisanProfileDto: UpdateArtisanProfileDto,
  ): Promise<{ message: string; data: ArtisanProfileResponseDto }> {
    const { serviceIds, ...profileUpdates } = updateArtisanProfileDto;

    const profile = await this.artisanProfilesRepository.findOne({
      where: { user: { id: userId } },
      relations: ['user', 'user.addresses', 'services'],
    });

    if (!profile) {
      throw new NotFoundException(
        `Artisan profile for user id ${userId} not found`,
      );
    }

    if (serviceIds !== undefined) {
      if (serviceIds.length === 0) {
        profile.services = [];
      } else {
        const services = await this.servicesRepository.findBy({
          id: In(serviceIds),
        });
        if (services.length !== serviceIds.length) {
          throw new NotFoundException('One or more services were not found.');
        }
        profile.services = services;
      }
    }

    Object.assign(profile, profileUpdates);

    // C2.2: exactly the same logic the `/artisans/me` routes already apply —
    // imported, not re-implemented, so there is only ever one definition of
    // "complete" (and therefore of who is searchable).
    const { isComplete } = computeProfileCompleteness(profile);
    profile.isProfileComplete = isComplete;

    const saved = await this.artisanProfilesRepository.save(profile);

    const updated = await this.artisanProfilesRepository.findOne({
      where: { id: saved.id },
      relations: ['user', 'user.addresses', 'services'],
    });

    this.logger.log(
      `Artisan ${userId} updated their profile (isProfileComplete=${isComplete})`,
    );

    return {
      message: SUCCESS_MESSAGES.ARTISAN_PROFILE.UPDATED,
      data: this.toArtisanProfileResponse(updated!),
    };
  }

  /**
   * Returns the customer profile for a given user, including preferred services
   * and the user's base data with addresses.
   *
   * @param userId - The user ID whose customer profile to retrieve.
   * @returns `{ message, data: CustomerProfileResponseDto }`.
   * @throws {NotFoundException} When no customer profile exists for the user.
   */
  async findCustomerProfileByUserId(
    userId: number,
  ): Promise<{ message: string; data: CustomerProfileResponseDto }> {
    const profile = await this.customerProfilesRepository.findOne({
      where: { user: { id: userId } },
      relations: ['user', 'user.addresses', 'preferredServices'],
    });

    if (!profile) {
      throw new NotFoundException(
        `Customer profile for user id ${userId} not found`,
      );
    }

    return {
      message: SUCCESS_MESSAGES.CUSTOMER_PROFILE.RETRIEVED,
      data: this.toCustomerProfileResponse(profile),
    };
  }

  /**
   * Applies a partial update to a customer's profile, optionally replacing the
   * preferred services list. Pass `preferredServiceIds: []` to clear all.
   * Budget validation (`max >= min`) is enforced before saving.
   *
   * @param userId - The user ID whose customer profile to update.
   * @param updateCustomerProfileDto - Fields to update.
   * @returns `{ message, data: CustomerProfileResponseDto }` reflecting the saved state.
   * @throws {NotFoundException} When the customer profile or any requested service is not found.
   * @throws {BadRequestException} When `budgetMax` is less than `budgetMin`.
   */
  async updateCustomerProfile(
    userId: number,
    updateCustomerProfileDto: UpdateCustomerProfileDto,
  ): Promise<{ message: string; data: CustomerProfileResponseDto }> {
    const { preferredServiceIds, ...profileUpdates } = updateCustomerProfileDto;

    const profile = await this.customerProfilesRepository.findOne({
      where: { user: { id: userId } },
      relations: ['user', 'user.addresses', 'preferredServices'],
    });

    if (!profile) {
      throw new NotFoundException(
        `Customer profile for user id ${userId} not found`,
      );
    }

    const nextBudgetMin =
      updateCustomerProfileDto.budgetMin === undefined
        ? profile.budgetMin
        : updateCustomerProfileDto.budgetMin;
    const nextBudgetMax =
      updateCustomerProfileDto.budgetMax === undefined
        ? profile.budgetMax
        : updateCustomerProfileDto.budgetMax;

    if (
      nextBudgetMin !== undefined &&
      nextBudgetMax !== undefined &&
      Number(nextBudgetMax) < Number(nextBudgetMin)
    ) {
      throw new BadRequestException(
        'budgetMax must be greater than or equal to budgetMin.',
      );
    }

    if (preferredServiceIds !== undefined) {
      if (preferredServiceIds.length === 0) {
        profile.preferredServices = [];
      } else {
        const preferredServices = await this.servicesRepository.findBy({
          id: In(preferredServiceIds),
        });
        if (preferredServices.length !== preferredServiceIds.length) {
          throw new NotFoundException(
            'One or more preferred services were not found.',
          );
        }
        profile.preferredServices = preferredServices;
      }
    }

    Object.assign(profile, profileUpdates);
    const saved = await this.customerProfilesRepository.save(profile);

    const updated = await this.customerProfilesRepository.findOne({
      where: { id: saved.id },
      relations: ['user', 'user.addresses', 'preferredServices'],
    });

    return {
      message: SUCCESS_MESSAGES.CUSTOMER_PROFILE.UPDATED,
      data: this.toCustomerProfileResponse(updated!),
    };
  }

  async addAddress(
    userId: number,
    dto: CreateAddressDto,
  ): Promise<{ message: string; data: AddressResponseDto }> {
    const user = await this.usersRepository.findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException(`User with ID ${userId} not found`);

    const address = this.addressesRepository.create({ ...dto, user });
    const saved = await this.addressesRepository.save(address);
    this.logger.log(`User ${userId} added address ${saved.id}`);
    return {
      message: SUCCESS_MESSAGES.USER.ADDRESS_ADDED,
      data: plainToInstance(AddressResponseDto, saved, {
        excludeExtraneousValues: true,
      }),
    };
  }

  async updateAddress(
    userId: number,
    addressId: number,
    dto: UpdateAddressDto,
  ): Promise<{ message: string; data: AddressResponseDto }> {
    const address = await this.addressesRepository.findOne({
      where: { id: addressId, user: { id: userId } },
    });
    if (!address) throw new NotFoundException(`Address ${addressId} not found`);

    Object.assign(address, dto);
    const saved = await this.addressesRepository.save(address);
    this.logger.log(`User ${userId} updated address ${addressId}`);
    return {
      message: SUCCESS_MESSAGES.USER.ADDRESS_UPDATED,
      data: plainToInstance(AddressResponseDto, saved, {
        excludeExtraneousValues: true,
      }),
    };
  }

  async removeAddress(
    userId: number,
    addressId: number,
  ): Promise<{ message: string }> {
    const address = await this.addressesRepository.findOne({
      where: { id: addressId, user: { id: userId } },
    });
    if (!address) throw new NotFoundException(`Address ${addressId} not found`);

    await this.addressesRepository.remove(address);
    this.logger.log(`User ${userId} removed address ${addressId}`);
    return { message: SUCCESS_MESSAGES.USER.ADDRESS_REMOVED };
  }

  /**
   * C2.1: `missingFields` is not a persisted column — only the derived
   * `isProfileComplete` boolean is — so it has to be computed fresh and
   * stitched onto the transformed DTO, exactly as
   * `ArtisansService.toPrivate()` does for the `/artisans/me` routes. Without
   * this, the field the DTO (and therefore Swagger) promises was simply absent
   * from both `/users/me/artisan-profile` responses, and the frontend had no
   * way to distinguish "complete" from "the field wasn't serialized".
   *
   * The caller **must** have loaded the `services` relation: completeness
   * counts offered services, and an unloaded relation would report `services`
   * as missing on a profile that has some.
   */
  private toArtisanProfileResponse(
    profile: ArtisanProfile,
  ): ArtisanProfileResponseDto {
    const dto = plainToInstance(ArtisanProfileResponseDto, profile, {
      excludeExtraneousValues: true,
    });

    const { isComplete, missingFields } = computeProfileCompleteness(profile);
    dto.missingFields = missingFields;

    // `isProfileComplete` stays sourced from the persisted column, because
    // that column — not this computation — is what the search hard-filter
    // reads. If the two ever disagree, the artisan's real search visibility is
    // the persisted value, so reporting anything else would be a lie in one
    // direction or the other. A disagreement means some write path skipped the
    // recompute (the C2.2 bug's signature), so say so loudly rather than
    // papering over it on a read.
    if (dto.isProfileComplete !== isComplete) {
      this.logger.warn(
        `Artisan profile ${profile.id} has a stale isProfileComplete flag ` +
          `(persisted=${dto.isProfileComplete}, computed=${isComplete}); ` +
          `missing=[${missingFields.join(', ')}]`,
      );
    }

    return dto;
  }

  private toCustomerProfileResponse(
    profile: CustomerProfile,
  ): CustomerProfileResponseDto {
    return plainToInstance(CustomerProfileResponseDto, profile, {
      excludeExtraneousValues: true,
    });
  }
}

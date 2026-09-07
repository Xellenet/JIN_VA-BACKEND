import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, IsNull, LessThan, Repository } from 'typeorm';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { User } from './entities/user.entity';
import { UserToken } from './entities/user-token.entity';
import { Address } from './entities/address.entity';
import { ArtisanProfile } from './entities/artisan-profile.entity';
import { VARIABLES } from '@common/constants/variables.constants';
import { purgeCutoffFrom } from '@common/utils/account-recovery.util';

/** What happened to one candidate on one run. */
export type PurgeOutcome =
  /** Destructive mode: the row was scrubbed. */
  | 'purged'
  /** Log-only mode: reported, nothing written. */
  | 'reported'
  /**
   * Re-checked under the row lock and found no longer eligible — restored by
   * its owner in the meantime, or already purged by an overlapping run. Not a
   * failure; this is what makes the job idempotent and race-safe.
   */
  | 'skipped';

/**
 * C1.7: irreversibly anonymizes accounts whose 30-day recovery window has
 * elapsed. Driven by `AccountPurgeSchedulerService`'s daily cron; the purge
 * logic lives here rather than in `src/scheduler/` so the scheduler stays a
 * thin orchestrator, matching how the jobs and bookings crons delegate to
 * their own domain services.
 *
 * **Anonymize, not hard-delete.** Payments, disputes and completed
 * jobs/bookings stay exactly where they are, still attached to this
 * now-anonymized row. A true row delete would either orphan or cascade into
 * financial and audit records the platform is required to keep, and would
 * break historical records for counterparties who did nothing wrong. Nothing
 * in this service deletes or cascades into any of them.
 *
 * **Log-only by default.** Destructive action happens only when
 * `ACCOUNT_PURGE_MODE=destructive`. An irreversible daily job must not go
 * straight to destructive on its first-ever production run, especially with
 * pre-existing soft-deleted rows of unknown provenance in the table — see
 * `docs/team/auth-settings-closeout/api-contract.md` for the enablement
 * procedure.
 */
@Injectable()
export class AccountPurgeService {
  private readonly logger = new Logger(AccountPurgeService.name);

  constructor(
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
    private readonly config: ConfigService,
  ) {}

  /**
   * Whether destructive mode is armed. Anything other than the exact opt-in
   * string — including unset, which is the default everywhere — means
   * log-only.
   */
  isDestructiveModeEnabled(): boolean {
    const mode = this.config.get<string>('ACCOUNT_PURGE_MODE') ?? '';
    return (
      mode.trim().toLowerCase() === VARIABLES.ACCOUNT_PURGE_MODE_DESTRUCTIVE
    );
  }

  /**
   * IDs of accounts eligible for purge: soft-deleted **strictly** more than
   * the retention period ago, and not already purged.
   *
   * Two deliberate properties, both of which C1.7 requires and both of which
   * have explicit test coverage:
   *
   * 1. **It can never match a live account.** Eligibility is expressed as
   *    `deleted_at < cutoff`. In SQL a comparison against `NULL` is never
   *    true, so a row with `deleted_at IS NULL` is structurally unable to
   *    appear in this result — there is no query-builder mistake short of
   *    rewriting this predicate that could select one. Every candidate is
   *    re-checked under its row lock anyway.
   * 2. **The boundary favours the user.** The cutoff is exactly
   *    `now - retention`, so an account at exactly day 30 is *not* a
   *    candidate; only one strictly past day 30 is.
   */
  async findPurgeCandidateIds(now: Date = new Date()): Promise<number[]> {
    const cutoff = purgeCutoffFrom(now);

    const rows = await this.usersRepository.find({
      where: { deletedAt: LessThan(cutoff), purgedAt: IsNull() },
      withDeleted: true,
      select: ['id'],
      order: { id: 'ASC' },
    });

    return rows.map((row) => row.id);
  }

  /**
   * Purges one account, independently of every other candidate, inside its own
   * row-locked transaction.
   *
   * The lock is the same one `UsersService.restoreAccountById()` takes, which
   * is what resolves the day-30/31 purge-vs-restore race to exactly one clean
   * winner. Whichever transaction gets the lock first commits; the other
   * re-reads the row and finds the world changed:
   * - restore won → `deletedAt` is `NULL` here → `'skipped'`, nothing written;
   * - purge won → `purgedAt` is set there → the restore 410s with a clear
   *   "permanently deleted" message.
   *
   * Re-checking eligibility **inside** the lock (rather than trusting the
   * candidate list, which was gathered earlier and unlocked) is also what
   * makes reruns and overlapping runs idempotent.
   */
  async purgeAccount(
    userId: number,
    now: Date = new Date(),
  ): Promise<PurgeOutcome> {
    const cutoff = purgeCutoffFrom(now);
    const destructive = this.isDestructiveModeEnabled();

    return this.usersRepository.manager.transaction(
      async (manager: EntityManager) => {
        const user = await manager.getRepository(User).findOne({
          where: { id: userId },
          withDeleted: true,
          lock: { mode: 'pessimistic_write' },
        });

        if (!user) {
          this.logger.warn(`Purge candidate ${userId} no longer exists`);
          return 'skipped';
        }

        // Defence in depth behind the candidate query's `deleted_at < cutoff`:
        // a live account is not purgeable, full stop, no matter how it came to
        // be in the candidate list.
        if (!user.deletedAt) {
          this.logger.log(
            `Skipping purge of user ${userId}: account is active (restored during the window)`,
          );
          return 'skipped';
        }

        if (user.purgedAt) {
          this.logger.log(
            `Skipping purge of user ${userId}: already purged at ${user.purgedAt.toISOString()}`,
          );
          return 'skipped';
        }

        if (user.deletedAt.getTime() >= cutoff.getTime()) {
          this.logger.log(
            `Skipping purge of user ${userId}: still inside the ${VARIABLES.SOFT_DELETE_RETENTION_DAYS}-day recovery window`,
          );
          return 'skipped';
        }

        if (!destructive) {
          // C1.7 / Open Question 4: report exactly what would be purged, and
          // write nothing at all.
          this.logger.warn(
            `[LOG-ONLY] Would purge user ${userId} (role=${user.role}, ` +
              `deletedAt=${user.deletedAt.toISOString()}). Set ` +
              `ACCOUNT_PURGE_MODE=${VARIABLES.ACCOUNT_PURGE_MODE_DESTRUCTIVE} to act on this.`,
          );
          return 'reported';
        }

        await this.scrubUserRow(manager, user, now);
        await this.scrubArtisanProfile(manager, user.id);
        await this.deleteResidualPersonalData(manager, user.id);

        this.logger.log(`Purged user ${userId}`);
        return 'purged';
      },
    );
  }

  /**
   * Overwrites every directly-identifying field on the user row and leaves it
   * permanently non-authenticable.
   *
   * Non-authenticable is enforced three independent ways, so no single mistake
   * can bring a purged account back:
   * - `password` is nulled, so no credential can ever match (and a null hash
   *   never reaches `bcrypt.compare`);
   * - `email` is overwritten with a placeholder derived from the row ID alone,
   *   so the original address resolves to nothing — and is also freed for
   *   future re-registration;
   * - `purgedAt` is stamped, which every restore path refuses outright.
   *
   * `deletedAt` is deliberately left in place: the row stays soft-deleted, so
   * it remains invisible to every ordinary query in the application.
   */
  private async scrubUserRow(
    manager: EntityManager,
    user: User,
    now: Date,
  ): Promise<void> {
    // Several of these columns are nullable in the database but typed as
    // non-optional on the entity (a pre-existing inaccuracy in `User`, not
    // something this change introduces), so the payload is asserted once here
    // rather than each field being cast individually.
    const scrubbed = {
      email: `deleted-user-${user.id}@${VARIABLES.PURGED_EMAIL_DOMAIN}`,
      password: null,
      firstname: VARIABLES.PURGED_FIRSTNAME,
      lastname: VARIABLES.PURGED_LASTNAME,
      username: null,
      phoneNumber: null,
      dateOfBirth: null,
      gender: null,
      profilePicture: null,
      socialProvider: null,
      socialProviderId: null,
      isSocialLogin: false,
      purgedAt: now,
    } as unknown as QueryDeepPartialEntity<User>;

    await manager.getRepository(User).update({ id: user.id }, scrubbed);
  }

  /**
   * Clears an artisan's free-text profile content and payout details.
   *
   * Scoped to the identifying and financially-sensitive columns only: ratings,
   * review counts and services stay, because they belong to the
   * counterparties' records as much as to this account, and `artisan_profiles`
   * rows are joined by past jobs and reviews that must keep rendering.
   * `isProfileComplete` is forced false so an anonymized profile can never
   * surface in customer search.
   *
   * A no-op for a customer account (no matching row) — deliberately not
   * conditional on the account's current role, so a role that changed at some
   * point can't leave payout details behind.
   */
  private async scrubArtisanProfile(
    manager: EntityManager,
    userId: number,
  ): Promise<void> {
    const scrubbed = {
      bio: null,
      businessName: null,
      location: null,
      cancellationPolicy: null,
      payoutType: null,
      paystackRecipientCode: null,
      payoutAccountName: null,
      payoutAccountNumber: null,
      payoutBankCode: null,
      isProfileComplete: false,
    } as unknown as QueryDeepPartialEntity<ArtisanProfile>;

    // Targeted by the raw `user_id` join column rather than a nested relation
    // criteria: TypeORM cannot express a relation condition in an UPDATE, and
    // `ArtisanProfile` exposes no scalar `userId` property. Same convention
    // `DisputesService.participantQb` documents for `@RelationId` columns.
    await manager
      .createQueryBuilder()
      .update(ArtisanProfile)
      .set(scrubbed)
      .where('user_id = :userId', { userId })
      .execute();
  }

  /**
   * Removes what is left of the account's authentication surface and its
   * stored postal addresses.
   *
   * Refresh tokens were already revoked at deletion time; this sweeps up every
   * other token type (email-verification, password-reset) so no token can
   * outlive the purge. Addresses are personal data with no counterparty or
   * audit value, so — unlike payments and disputes — they are deleted rather
   * than anonymized.
   */
  private async deleteResidualPersonalData(
    manager: EntityManager,
    userId: number,
  ): Promise<void> {
    await manager
      .createQueryBuilder()
      .delete()
      .from(UserToken)
      .where('user_id = :userId', { userId })
      .execute();

    await manager
      .createQueryBuilder()
      .delete()
      .from(Address)
      .where('user_id = :userId', { userId })
      .execute();
  }
}

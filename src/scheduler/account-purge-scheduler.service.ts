import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { AccountPurgeService } from '@users/account-purge.service';
import { VARIABLES } from '@common/constants/variables.constants';

@Injectable()
export class AccountPurgeSchedulerService {
  private readonly logger = new Logger(AccountPurgeSchedulerService.name);

  constructor(private readonly accountPurgeService: AccountPurgeService) {}

  /**
   * C1.7: runs daily — irreversibly anonymizes accounts whose 30-day recovery
   * window has elapsed ("strictly more than 30 days ago", so an account at
   * exactly day 30 is left alone and the boundary favours the user).
   *
   * Follows the same contract as the jobs and bookings crons:
   * - each candidate is processed and committed independently inside
   *   {@link AccountPurgeService.purgeAccount}'s own row-locked transaction, so
   *   a mid-batch failure never leaves a partially-applied batch and anything
   *   missed is simply caught on the next run;
   * - reruns and overlapping runs are idempotent — eligibility is re-checked
   *   under the row lock, and an already-purged (or meanwhile-restored)
   *   account is skipped rather than touched twice;
   * - a per-run summary is always logged, including when zero accounts
   *   qualify, so the job can never look dormant.
   *
   * **This job is log-only until an operator arms it.** With
   * `ACCOUNT_PURGE_MODE` unset — the default in every environment — it reports
   * exactly which accounts it *would* purge and writes nothing. The mode in
   * force is stated on every run summary so it is never ambiguous which of the
   * two a given log line describes. See
   * `docs/team/auth-settings-closeout/api-contract.md` for how to review the
   * first log-only run and then enable destructive mode.
   */
  @Cron(CronExpression.EVERY_DAY_AT_4AM)
  async purgeExpiredDeletedAccounts(): Promise<void> {
    const destructive = this.accountPurgeService.isDestructiveModeEnabled();
    const mode = destructive
      ? VARIABLES.ACCOUNT_PURGE_MODE_DESTRUCTIVE
      : 'log-only';

    const candidateIds = await this.accountPurgeService.findPurgeCandidateIds();

    if (candidateIds.length === 0) {
      this.logger.log(
        `purgeExpiredDeletedAccounts run summary: mode=${mode} candidates=0 processed=0 failed=0 skipped=0`,
      );
      return;
    }

    let processed = 0;
    let failed = 0;
    let skipped = 0;
    for (const id of candidateIds) {
      try {
        const outcome = await this.accountPurgeService.purgeAccount(id);
        if (outcome === 'skipped') skipped++;
        else processed++;
      } catch (err) {
        failed++;
        this.logger.error(
          `Failed to purge account ${id}: ${(err as Error).message}`,
        );
      }
    }

    this.logger.log(
      `purgeExpiredDeletedAccounts run summary: mode=${mode} candidates=${candidateIds.length} processed=${processed} failed=${failed} skipped=${skipped}`,
    );

    if (!destructive) {
      this.logger.warn(
        `purgeExpiredDeletedAccounts is in log-only mode — ${processed} account(s) ` +
          `are past the ${VARIABLES.SOFT_DELETE_RETENTION_DAYS}-day window and were reported, not purged. ` +
          `Review the [LOG-ONLY] lines above, then set ACCOUNT_PURGE_MODE=${VARIABLES.ACCOUNT_PURGE_MODE_DESTRUCTIVE} to act on them.`,
      );
    }
  }
}

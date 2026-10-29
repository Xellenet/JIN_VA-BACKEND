import { addDays } from 'date-fns';
import { VARIABLES } from '@common/constants/variables.constants';

/**
 * C1: the single arithmetic definition of the 30-day account-recovery window.
 *
 * Everything that has an opinion about the window derives it from here — the
 * deletion response's purge date, the deletion email's calendar date, the
 * pending-deletion login rejection's `restorableUntil`, the restore path's
 * window check, and the purge job's candidate cutoff. Any one of those
 * computing "+30 days" independently is how the promise on the confirmation
 * email drifts away from what the purge job actually enforces.
 */

/** The instant a soft-deleted account becomes eligible for purge. */
export function purgeDateFor(deletedAt: Date): Date {
  return addDays(new Date(deletedAt), VARIABLES.SOFT_DELETE_RETENTION_DAYS);
}

/**
 * Whether a soft-deleted account can still be restored.
 *
 * The boundary deliberately favours the user (C1.7): an account whose
 * `deletedAt` is *exactly* the retention period ago is still restorable, and
 * is not a purge candidate. Only strictly-past-the-window accounts are gone.
 */
export function isWithinRecoveryWindow(
  deletedAt: Date,
  now: Date = new Date(),
): boolean {
  return now.getTime() <= purgeDateFor(deletedAt).getTime();
}

/**
 * The `deletedAt` cutoff for the purge job: an account is a candidate only if
 * its `deletedAt` is strictly older than this. Expressed as a cutoff (rather
 * than as a per-row comparison) so the candidate query can be a single
 * indexed `deleted_at < cutoff` predicate — which, in SQL, can never match a
 * `NULL` `deleted_at`, i.e. can never select a live account.
 */
export function purgeCutoffFrom(now: Date = new Date()): Date {
  return addDays(new Date(now), -VARIABLES.SOFT_DELETE_RETENTION_DAYS);
}

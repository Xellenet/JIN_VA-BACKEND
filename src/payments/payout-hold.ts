/**
 * Payout holds: why a payout was not sent after the name check that runs
 * before every transfer, and how a "check pending" payout is retried.
 *
 * A held payout is parked at `PENDING_TRANSFER` with one of these reasons in
 * `payments.payout_hold_reason`. A `PENDING_TRANSFER` payment with no reason
 * is the older case: there was no payout method at all.
 */

/** Paystack has a different name on the account than the one saved. */
export const PAYOUT_NAME_MISMATCH = 'payout_name_mismatch';
/** Paystack can't find the account (number gone, or the wrong network/bank). */
export const PAYOUT_ACCOUNT_NOT_FOUND = 'payout_account_not_found';
/** The name could not be checked right now (Paystack down or rate limited). */
export const PAYOUT_CHECK_PENDING = 'payout_check_pending';

export const PAYOUT_HOLD_REASONS = [
  PAYOUT_NAME_MISMATCH,
  PAYOUT_ACCOUNT_NOT_FOUND,
  PAYOUT_CHECK_PENDING,
] as const;
export type PayoutHoldReason = (typeof PAYOUT_HOLD_REASONS)[number];

/** Holds only the artisan can clear, by fixing their payment details. */
export const ARTISAN_ACTION_HOLDS: readonly PayoutHoldReason[] = [
  PAYOUT_NAME_MISMATCH,
  PAYOUT_ACCOUNT_NOT_FOUND,
];

export function isPayoutHoldReason(v: unknown): v is PayoutHoldReason {
  return (
    typeof v === 'string' &&
    (PAYOUT_HOLD_REASONS as readonly string[]).includes(v)
  );
}

export function needsArtisanAction(reason: string | null | undefined): boolean {
  return (ARTISAN_ACTION_HOLDS as readonly string[]).includes(reason ?? '');
}

/** Plain words for a hold, used in the earnings CSV. */
export function payoutHoldLabel(reason: string | null | undefined): string {
  switch (reason) {
    case PAYOUT_NAME_MISMATCH:
      return "Payout account name doesn't match";
    case PAYOUT_ACCOUNT_NOT_FOUND:
      return 'Payout account not found';
    case PAYOUT_CHECK_PENDING:
      return 'Checking your payout account';
    default:
      return '';
  }
}

/** Where the artisan fixes their payout details. */
export const PAYOUT_SETTINGS_PATH = '/dashboard/artisan/settings?tab=payments';

/** 422 for the artisan's retry: the name on the account doesn't match. */
export const PAYOUT_NAME_MISMATCH_MESSAGE =
  "The name on your payout account doesn't match. Update your payment details to receive it.";
/** 422 for the artisan's retry: the account can't be found. */
export const PAYOUT_ACCOUNT_NOT_FOUND_MESSAGE =
  "We couldn't find your payout account. Update your payment details to receive it.";
/** 503 for the artisan's retry: the check couldn't be made. */
export const PAYOUT_CHECK_PENDING_MESSAGE =
  "We couldn't check your payout account right now, so nothing was sent. We'll try again automatically.";

// ─── Retrying a pending check ────────────────────────────────────────────────

/** First retry after this long; each later one waits twice as long. */
export const PAYOUT_CHECK_RETRY_BASE_MS = 30 * 60_000;
/** No wait is longer than this. */
export const PAYOUT_CHECK_RETRY_MAX_MS = 12 * 60 * 60_000;
/**
 * After this many checks that couldn't be made, the scheduler stops retrying
 * and admins are told. The artisan's retry and an admin release still work.
 */
export const PAYOUT_CHECK_MAX_ATTEMPTS = 8;

/**
 * When to retry after the `attempts`-th check that couldn't be made, or null
 * once the cap is reached: 30 min, 1 h, 2 h, 4 h, 8 h, then every 12 h.
 */
export function nextPayoutCheckAt(attempts: number, now: Date): Date | null {
  if (attempts >= PAYOUT_CHECK_MAX_ATTEMPTS) return null;
  const n = Math.max(1, Math.floor(attempts));
  const delay = Math.min(
    PAYOUT_CHECK_RETRY_BASE_MS * 2 ** (n - 1),
    PAYOUT_CHECK_RETRY_MAX_MS,
  );
  return new Date(now.getTime() + delay);
}

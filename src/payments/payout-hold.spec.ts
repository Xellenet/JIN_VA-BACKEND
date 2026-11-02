import {
  isPayoutHoldReason,
  needsArtisanAction,
  nextPayoutCheckAt,
  PAYOUT_CHECK_MAX_ATTEMPTS,
  payoutHoldLabel,
} from './payout-hold';

describe('payout hold helpers', () => {
  const now = new Date('2026-11-01T10:00:00Z');
  const minutesAfter = (d: Date | null) =>
    d ? (d.getTime() - now.getTime()) / 60_000 : null;

  it('backs off 30 min, 1 h, 2 h, 4 h, 8 h, then every 12 h, up to the cap', () => {
    const delays = Array.from({ length: PAYOUT_CHECK_MAX_ATTEMPTS }, (_, i) =>
      minutesAfter(nextPayoutCheckAt(i + 1, now)),
    );
    expect(delays).toEqual([30, 60, 120, 240, 480, 720, 720, null]);
    expect(nextPayoutCheckAt(PAYOUT_CHECK_MAX_ATTEMPTS + 5, now)).toBeNull();
    expect(minutesAfter(nextPayoutCheckAt(0, now))).toBe(30);
  });

  it('knows which holds the artisan must fix', () => {
    expect(needsArtisanAction('payout_name_mismatch')).toBe(true);
    expect(needsArtisanAction('payout_account_not_found')).toBe(true);
    expect(needsArtisanAction('payout_check_pending')).toBe(false);
    expect(needsArtisanAction(null)).toBe(false);
  });

  it('recognises only the known reasons', () => {
    expect(isPayoutHoldReason('payout_check_pending')).toBe(true);
    expect(isPayoutHoldReason('no_payout_method')).toBe(false);
    expect(isPayoutHoldReason(3)).toBe(false);
  });

  it('labels each reason in plain words, never "escrow"', () => {
    expect(payoutHoldLabel('payout_name_mismatch')).toBe(
      "Payout account name doesn't match",
    );
    expect(payoutHoldLabel('payout_account_not_found')).toBe(
      'Payout account not found',
    );
    expect(payoutHoldLabel('payout_check_pending')).toBe(
      'Checking your payout account',
    );
    expect(payoutHoldLabel(null)).toBe('');
  });
});

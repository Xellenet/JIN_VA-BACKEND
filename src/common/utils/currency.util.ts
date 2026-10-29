/**
 * Formats a GHS amount for user-facing notification/email copy.
 *
 * The platform is GHS-only (see `PaymentsService.holdPayment`, which refuses
 * any non-GHS job outright), so this deliberately takes no currency argument —
 * a second currency would be a much larger change than a formatting helper.
 *
 * Mirrors the frontend's shared `formatCurrency()` output (`GH₵ 1,250.00`) so
 * an amount rendered in a notification body reads identically to the same
 * amount rendered in the UI. Never emit a bare number or a `$` for money.
 *
 * `amount` is typed `number | string` because TypeORM returns `decimal`
 * columns (`Payment.amount`, `artisanAmount`, `refundedAmount`) as strings.
 */
export function formatGhs(amount: number | string): string {
  const value = Number(amount);
  if (!Number.isFinite(value)) return 'GH₵ 0.00';
  return `GH₵ ${value.toLocaleString('en-GH', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

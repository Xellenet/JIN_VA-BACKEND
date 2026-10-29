/**
 * QA AUTH-04: addresses are case-insensitive in practice, so one mailbox must
 * map to one account. Every stored address is normalised with this, and
 * every lookup compares against it.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

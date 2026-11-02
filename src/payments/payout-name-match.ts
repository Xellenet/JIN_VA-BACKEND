/**
 * Payout name check: does the name Paystack has on a payout account match
 * the name the artisan saved with it?
 *
 * Pure and side-effect free. Nothing here logs, so a name never reaches the
 * logs through this module.
 */

/** Courtesy titles some bank records put in front of a name. */
const TITLES = new Set(['mr', 'mrs', 'ms', 'miss', 'dr', 'rev', 'prof']);

/**
 * The tokens of a name: accents removed, lower case, apostrophes dropped
 * (`O'Neil` → `oneil`), every other punctuation mark a separator, courtesy
 * titles removed, and each token once.
 */
export function nameTokens(name: string | null | undefined): string[] {
  if (typeof name !== 'string') return [];
  const plain = name
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/['’‘`]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
  if (!plain) return [];
  const tokens = plain.split(' ').filter((t) => t && !TITLES.has(t));
  return [...new Set(tokens)];
}

/**
 * True when two account names belong to the same person.
 *
 * Case, accents, punctuation, extra spaces and token order are ignored. They
 * match when every token of the shorter name appears in the longer one and
 * they share at least 2 tokens, because bank records often add a middle
 * name (`Kofi Mensah` matches `MENSAH Kofi Asante`). Two names that are the
 * same once normalised also match, so a one-word name Paystack itself
 * returns is not refused.
 */
export function payoutNamesMatch(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const ta = nameTokens(a);
  const tb = nameTokens(b);
  if (ta.length === 0 || tb.length === 0) return false;
  const [shorter, longer] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  const inLonger = new Set(longer);
  if (!shorter.every((t) => inLonger.has(t))) return false;
  if (shorter.length === longer.length) return true;
  return shorter.length >= 2;
}

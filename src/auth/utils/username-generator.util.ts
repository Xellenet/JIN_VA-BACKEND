import { VARIABLES } from '@common/constants/variables.constants';

/** Letters NFKD doesn't decompose into an ASCII base letter. */
const SPECIAL_FOLDS: Record<string, string> = {
  ß: 'ss',
  æ: 'ae',
  œ: 'oe',
  ø: 'o',
  đ: 'd',
  ð: 'd',
  ł: 'l',
  þ: 'th',
  ı: 'i',
};

const MAX = 30;
const MIN = 3;

/** Lower-case ASCII letters and digits only, accents folded ("Ẹ̀sí" → "esi"). */
export function foldNamePart(part: string | null | undefined): string {
  if (!part) return '';
  return part
    .toLowerCase()
    .replace(/[ßæœøđðłþı]/g, (ch) => SPECIAL_FOLDS[ch] ?? '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9]/g, '');
}

/**
 * The collision-free base for a sign-up: `first.last` from the first and last
 * name only (never the email or phone). Long names are cut so that the base
 * plus a suffix of up to `suffixRoom` digits still fits in 30 characters. A
 * name with nothing usable left becomes `user`; one shorter than 3 characters
 * is padded with `.user`.
 */
export function usernameBase(
  firstname: string | null | undefined,
  lastname: string | null | undefined,
  suffixRoom = 4,
): string {
  const first = foldNamePart(firstname);
  const last = foldNamePart(lastname);
  let base = [first, last].filter(Boolean).join('.');
  if (!base) base = 'user';
  if (base.length < MIN) base = `${base}.user`;
  base = base.slice(0, MAX - suffixRoom).replace(/\.+$/, '');
  return base.length >= MIN ? base : 'user';
}

/** The n-th candidate: `base` for n = 1, then `base2`, `base3`… */
export function usernameCandidate(base: string, n: number): string {
  return n <= 1 ? base : `${base}${n}`;
}

/**
 * The first free candidate given the usernames already taken that start with
 * `base` (compared lower-case). `base` itself, then `base2`, `base3`…
 */
export function firstFreeUsername(
  base: string,
  taken: Iterable<string>,
): string {
  const used = new Set<number>();
  const pattern = new RegExp(`^${base.replace(/\./g, '\\.')}(\\d*)$`);
  for (const name of taken) {
    const match = pattern.exec(name.toLowerCase());
    if (!match) continue;
    if (match[1] === '') used.add(1);
    else if (/^[1-9]\d*$/.test(match[1]) && Number(match[1]) >= 2) {
      used.add(Number(match[1]));
    }
  }
  // `base1` is never generated, so the sequence is base, base2, base3…
  let n = 1;
  while (used.has(n)) n = n === 1 ? 2 : n + 1;
  return usernameCandidate(base, n);
}

/** Every generated value must satisfy the same rule a typed username does. */
export function isValidUsername(value: string): boolean {
  return VARIABLES.USERNAME_REGEX.test(value);
}

/**
 * Customer experience v2 (B3 `search`): escapes the three characters that are
 * special in a Postgres `LIKE`/`ILIKE` pattern with `ESCAPE '\'`, so a
 * customer searching for `50%` or `a_b` matches those characters literally
 * and cannot turn the search into a wildcard scan. The value is still bound
 * as a parameter; this only neutralises pattern syntax, not SQL.
 */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** `%escaped%`: a "contains" pattern for `ILIKE :q ESCAPE '\'`. */
export function containsPattern(value: string): string {
  return `%${escapeLike(value)}%`;
}

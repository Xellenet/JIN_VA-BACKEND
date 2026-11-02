import { Transform } from 'class-transformer';

/**
 * Sign-up form v2: the optional middle name. A string is trimmed, and a blank
 * one becomes `null`, so "no middle name" is always stored as NULL (never '')
 * and sending `""` from Settings clears it. Non-strings pass through for
 * `@IsString()` to reject.
 */
export function NormalizeMiddleName(): PropertyDecorator {
  return Transform(({ value }: { value: unknown }) => {
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  });
}

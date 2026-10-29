import { Transform } from 'class-transformer';

/**
 * Trims a string before validation, so length rules count real characters.
 * QA DSP-03: a dispute reason of 25 spaces passed `@MinLength(20)`; QA JOB-02:
 * likewise for job titles and descriptions. Non-strings pass through for the
 * type validators to reject.
 */
export function TrimText() {
  return Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  );
}

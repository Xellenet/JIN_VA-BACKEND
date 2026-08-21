/**
 * Safely extracts a human-readable message from a `catch` binding.
 *
 * TS/ESLint treat `catch (e)` bindings as `any` by default in this project's
 * tsconfig (`useUnknownInCatchVariables` not force-enabled everywhere), which
 * previously caused widespread `@typescript-eslint/no-unsafe-member-access`
 * lint errors on `error.message` across services/listeners. Use this helper
 * instead of accessing `.message` directly on a caught value.
 */
export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/** Extracts the `.stack` trace from a caught value, if it has one. */
export function getErrorStack(error: unknown): string | undefined {
  return error instanceof Error ? error.stack : undefined;
}

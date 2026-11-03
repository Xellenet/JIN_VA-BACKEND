import { VARIABLES } from '@common/constants/variables.constants';

/** `AUTH_RESPONSE_FLOOR_MS`, or the default. A bad value falls back to the default. */
export function responseFloorMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.AUTH_RESPONSE_FLOOR_MS;
  if (raw === undefined || raw === '') return VARIABLES.AUTH_RESPONSE_FLOOR_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0
    ? Math.floor(parsed)
    : VARIABLES.AUTH_RESPONSE_FLOOR_MS;
}

/**
 * Runs `work` and makes the caller wait at least `floorMs` in total, whether
 * it resolves or throws. Used where the answer must not reveal whether an
 * address has an account: both paths already do the same hashing, and the
 * floor absorbs what's left (an insert, a lookup that found a row).
 */
export async function withMinimumDuration<T>(
  work: () => Promise<T>,
  floorMs: number,
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => number = Date.now,
): Promise<T> {
  const started = now();
  try {
    return await work();
  } finally {
    const remaining = floorMs - (now() - started);
    if (remaining > 0) await sleep(remaining);
  }
}

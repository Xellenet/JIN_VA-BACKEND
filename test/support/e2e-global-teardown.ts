import type { PGlite } from '@electric-sql/pglite';
import type { PGliteServer } from './pglite-server';

/** Stops the in-memory Postgres started by e2e-global-setup.ts. */
export default async function globalTeardown(): Promise<void> {
  const running = (
    globalThis as { __e2ePostgres?: { server: PGliteServer; db: PGlite } }
  ).__e2ePostgres;
  if (!running) return;
  await running.server.stop();
  await running.db.close();
}

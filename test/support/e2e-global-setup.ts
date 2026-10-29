/**
 * Starts a throwaway, in-memory Postgres for the e2e run, so the suite needs
 * no database server, no Docker and no .env — it runs as-is in a pipeline.
 *
 * PGlite is real Postgres compiled to WebAssembly, running inside this
 * process. PGliteServer serves it over the normal wire protocol on a free
 * loopback port, so the app connects through its usual TypeORM/pg config
 * and runs every migration on a fresh, empty database. Nothing persists:
 * the database disappears when the run ends.
 *
 * Every other setting the app reads is given a test-only value here. The app
 * skips the .env file under NODE_ENV=test (see AppModule), so a local run and
 * a pipeline run see exactly the same configuration.
 */
import { PGlite } from '@electric-sql/pglite';
import { uuid_ossp } from '@electric-sql/pglite/contrib/uuid_ossp';
import { PGliteServer } from './pglite-server';

const TEST_ENV: Record<string, string> = {
  NODE_ENV: 'test',
  APP_NAME: 'JinVa',
  FRONTEND_URL: 'http://localhost:3000',
  ALLOWED_ORIGINS: 'http://localhost:3000',
  SUPPORT_EMAIL: 'support@jinva.test',
  SESSION_COOKIE_SECRET: 'e2e-session-cookie-secret',
  JWT_SECRET: 'e2e-jwt-secret',
  JWT_ACCESS_EXPIRES_IN: '15m',
  JWT_REFRESH_EXPIRES_IN: '7d',
  GOOGLE_CLIENT_ID: 'e2e-google-client-id.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'e2e-google-client-secret',
  GOOGLE_CALLBACK_URL: 'http://localhost:4200/api/v1/auth/google/callback',
  GOOGLE_REDIRECT_URI: 'http://localhost:3000/auth/callback',
  PAYSTACK_SECRET_KEY: 'sk_test_e2e_not_a_real_key',
  PAYSTACK_CALLBACK_URL: 'http://localhost:3000/payments/callback',
  MAIL_PROVIDER: 'smtp',
  MAIL_FROM: 'JinVa <no-reply@jinva.test>',
  MAIL_HOST: '127.0.0.1',
  MAIL_PORT: '2525',
  MAIL_USER: 'e2e',
  MAIL_PASS: 'e2e',
  STORAGE_PROVIDER: 'local',
  STORAGE_PUBLIC_DELIVERY: 'direct',
  PUSH_PROVIDER: 'log',
  PHOTON_BASE_URL: 'http://photon.invalid',
};

type Running = { server: PGliteServer; db: PGlite };

export default async function globalSetup(): Promise<void> {
  // Opt-in, for the few suites that need several database sessions running
  // at once (see dc-b6-rollback-guard): E2E_REAL_POSTGRES=1 with DB_HOST,
  // DB_PORT, DB_USER, DB_PASS and DB_NAME pointing at a disposable Postgres
  // on this machine. Never needed by the default run or the pipeline.
  if (process.env.E2E_REAL_POSTGRES === '1') {
    const missing = ['DB_HOST', 'DB_PORT', 'DB_USER', 'DB_NAME'].filter(
      (key) => !process.env[key],
    );
    if (missing.length) {
      throw new Error(
        `E2E_REAL_POSTGRES=1 needs ${missing.join(', ')} set in the environment.`,
      );
    }
    Object.assign(process.env, TEST_ENV);
    return;
  }

  const db = await PGlite.create({ extensions: { uuid_ossp } });
  await db.exec('CREATE EXTENSION IF NOT EXISTS "uuid-ossp";');

  // A free port picked by the OS, so parallel pipelines never collide.
  const server = new PGliteServer(db);
  const port = await server.start();

  Object.assign(process.env, TEST_ENV, {
    DB_HOST: '127.0.0.1',
    DB_PORT: String(port),
    DB_USER: 'postgres',
    DB_PASS: 'postgres',
    DB_NAME: 'postgres',
  });

  (globalThis as { __e2ePostgres?: Running }).__e2ePostgres = { server, db };
}

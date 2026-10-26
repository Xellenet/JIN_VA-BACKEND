/**
 * TEST ISOLATION for every e2e suite (wired in through jest-e2e.json's
 * setupFilesAfterEnv, so a new spec cannot forget it). It runs in the test
 * process before the spec imports AppModule, and never edits or prints .env.
 *
 * - Storage: STORAGE_PROVIDER=local. @nestjs/config lets an existing
 *   process.env value win over .env, so the app never builds the S3 provider
 *   from the dev bucket settings; the S3 provider's I/O methods also throw if
 *   anything reaches them anyway.
 * - Mail: MailService.sendMail and both transports are replaced, so no SMTP or
 *   Resend message can leave the process. Sent mail is recorded (event type
 *   only) on globalThis.__isolatedMail for specs that want to assert on it.
 * - Push and payments: PUSH_PROVIDER=log, FCM and Paystack calls never leave.
 * - Places: PHOTON_BASE_URL points at a host that cannot resolve, unless a
 *   spec mocks HttpService itself.
 *
 * Prototype assignment (not jest.spyOn), so a spec's restoreAllMocks() cannot
 * undo it. A spec that overrides MailService in its testing module still can.
 */
import { MailService } from '../src/mail/mail.service';
import { ResendMailProvider } from '../src/mail/providers/resend-mail.provider';
import { SmtpMailProvider } from '../src/mail/providers/smtp-mail.provider';
import { PaystackService } from '../src/payments/paystack.service';
import { FcmPushProvider } from '../src/push-notifications/providers/fcm-push.provider';
import { S3StorageProvider } from '../src/uploads/providers/s3-storage.provider';
import { config as loadEnv } from 'dotenv';
import { DataSource } from 'typeorm';

process.env.STORAGE_PROVIDER = 'local';
process.env.STORAGE_PUBLIC_DELIVERY = 'direct';
process.env.PUSH_PROVIDER = 'log';
process.env.PHOTON_BASE_URL = 'http://photon.invalid';

const refuse = (what: string) =>
  function refused(): Promise<never> {
    return Promise.reject(
      new Error(`[e2e isolation] ${what} is disabled in tests`),
    );
  };

const patch = (proto: object, name: string, fn: unknown): void => {
  (proto as Record<string, unknown>)[name] = fn;
};

const sentMail: Array<{ eventType: string }> = [];
(globalThis as { __isolatedMail?: typeof sentMail }).__isolatedMail = sentMail;

patch(
  MailService.prototype,
  'sendMail',
  function sendMail(_to: string, eventType: string): Promise<void> {
    sentMail.push({ eventType });
    return Promise.resolve();
  },
);
patch(SmtpMailProvider.prototype, 'send', refuse('SMTP send'));
patch(ResendMailProvider.prototype, 'send', refuse('Resend send'));

for (const name of Object.getOwnPropertyNames(S3StorageProvider.prototype)) {
  if (name === 'constructor' || name === 'missingConfiguration') continue;
  const d = Object.getOwnPropertyDescriptor(S3StorageProvider.prototype, name);
  if (d && typeof d.value === 'function') {
    patch(S3StorageProvider.prototype, name, refuse(`S3 ${name}`));
  }
}

patch(
  FcmPushProvider.prototype,
  'send',
  function send(tokens: string[]): Promise<{
    successCount: number;
    failedTokens: string[];
  }> {
    return Promise.resolve({ successCount: 0, failedTokens: [...tokens] });
  },
);
for (const name of [
  'initializeTransaction',
  'verifyTransaction',
  'createRefund',
  'createTransferRecipient',
  'initiateTransfer',
]) {
  patch(PaystackService.prototype, name, refuse(`Paystack ${name}`));
}

/*
 * Keep the shared dev database at its seed data. A suite's own users take their
 * rows with them (everything cascades from `users`), but notifications the
 * suite caused for SEED accounts (e.g. every admin's "dispute filed" alert)
 * would otherwise pile up. Remove whatever notifications appeared while this
 * file ran. Caveat: this also removes notifications created by someone using
 * the app against the same database during the run.
 */
loadEnv({ quiet: true });
let suiteStartedAt: string | undefined;
const withDb = async <T>(fn: (db: DataSource) => Promise<T>): Promise<T> => {
  const db = new DataSource({
    type: 'postgres',
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    username: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
  });
  await db.initialize();
  try {
    return await fn(db);
  } finally {
    await db.destroy();
  }
};

beforeAll(async () => {
  const rows: Array<{ now: string }> = await withDb((db) =>
    db.query('SELECT now()::text AS now'),
  );
  suiteStartedAt = rows[0].now;
});

afterAll(async () => {
  if (!suiteStartedAt) return;
  const since = suiteStartedAt;
  await withDb((db) =>
    db.query('DELETE FROM notifications WHERE created_at >= $1', [since]),
  );
});

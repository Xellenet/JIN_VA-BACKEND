import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Resend } from 'resend';
import type { IMailProvider, MailMessage } from './mail-provider.interface';

/**
 * BI4: Resend-backed implementation of {@link IMailProvider}, the PRD §7
 * named provider JinVa is migrating to (Open Question 8's recorded decision:
 * the current SMTP host is *not* already SendGrid or Resend, so this is a real
 * migration rather than a paperwork closure).
 *
 * NOT active by default — `MailProviderFactory` only returns this provider
 * when `MAIL_PROVIDER === 'resend'`. Setting that variable, like the S3
 * cutover, is the operator's action; nothing in this codebase does it, and no
 * environment file is read, opened or inspected to build it.
 *
 * Configuration is read exclusively via named environment variables:
 * - `MAIL_PROVIDER`   set to `resend` to activate this provider (`smtp` or
 *                     unset keeps the existing SMTP transport)
 * - `RESEND_API_KEY`  (required when active) — the Resend API key, created in
 *                     the Resend dashboard. Never read or echoed by this
 *                     codebase; referenced by name only.
 * - `MAIL_FROM`       (required) — the sender address, which must be on a
 *                     domain verified in Resend or Resend rejects the send.
 *                     Supplied by `MailService`, unchanged.
 *
 * Explicitly *not* used: `MAIL_HOST` / `MAIL_PORT` / `MAIL_USER` /
 * `MAIL_PASS`. Those stay meaningful only for the SMTP provider, so the two
 * can coexist and an environment can switch back by unsetting one variable.
 *
 * Failure discipline. The SDK does **not** throw on an API-level rejection —
 * it resolves with `{ data: null, error }` — so a naive port would report
 * success for every unsent email and quietly break verification and password
 * reset. `send()` therefore inspects `error` and throws, which is what keeps
 * `MailService`'s existing "log and re-throw" behaviour intact. The thrown
 * message carries Resend's error *code* and HTTP status only: mail transports
 * are the one place an error string can pick up an authentication credential
 * (an SMTP `535` response echoes the username, for instance), and this string
 * lands in the application log. The per-message detail lives in Resend's
 * dashboard, which is the deliverability reporting BI4 exists to get.
 *
 * ── Why the SDK call is wrapped ─────────────────────────────────────────────
 * Sanitising the *thrown* message is not sufficient on its own. The installed
 * SDK logs the failure itself, before this provider ever sees the result:
 * `Resend.logError()` (resend@6.24.0, `dist/index.cjs`) runs on every API
 * error branch of `fetchRequest` and does
 *
 *     if (process.env.NODE_ENV !== "production")
 *       console.error("[Resend API Error]:", { status, error, path });
 *
 * where `error` is the complete parsed Resend payload — including the exact
 * free-text `message` field this provider deliberately drops (recipient
 * addresses in `validation_error` payloads, domain-verification detail, the
 * request path). It writes to raw stderr rather than through winston, so it
 * sits outside the app's logging policy entirely, and it cannot be caught,
 * because it is a log call rather than a thrown value. The SDK exposes no
 * option to disable it.
 *
 * So `send()` runs the SDK call inside `withSdkErrorLoggingSuppressed`, which
 * drops exactly the calls whose first argument is the SDK's own
 * `'[Resend API Error]:'` sentinel, for exactly the duration of that call.
 * Everything else written to `console.error` by anything else, at any time,
 * passes through untouched. `resend-mail.provider.sdk.spec.ts` proves this
 * against the **real** SDK driven by a stubbed `fetch`, rather than against a
 * `jest.mock('resend')` double — a mocked SDK replaces the very object that
 * does the logging, so it could never have observed this.
 *
 * (Note for the record: no path in the SDK puts the API key into an error
 * string — `Authorization` is set once at construction and never echoed — so
 * what this closes is provider-detail and recipient-PII disclosure to process
 * logs, not a credential leak.)
 */
@Injectable()
export class ResendMailProvider implements IMailProvider {
  readonly providerName = 'resend';
  private client: Resend | undefined;

  constructor(private readonly config: ConfigService) {}

  async send(message: MailMessage): Promise<void> {
    const apiKey = this.requireApiKey();
    const from = message.from;
    if (!from) {
      throw new Error(
        'MAIL_FROM is not configured. Resend requires a sender address on a domain verified in Resend.',
      );
    }

    const { error } = await withSdkErrorLoggingSuppressed(() =>
      this.getClient(apiKey).emails.send({
        from,
        to: message.to,
        subject: message.subject,
        html: message.html,
        text: message.text,
      }),
    );

    if (error) {
      throw new Error(
        `Resend rejected the message: ${error.name}${
          error.statusCode ? ` (HTTP ${error.statusCode})` : ''
        }. See the Resend dashboard for the per-message detail.`,
      );
    }
  }

  missingConfiguration(): string[] {
    const missing: string[] = [];
    if (!this.readConfig('RESEND_API_KEY')) missing.push('RESEND_API_KEY');
    if (!this.readConfig('MAIL_FROM')) missing.push('MAIL_FROM');
    return missing;
  }

  private requireApiKey(): string {
    const apiKey = this.readConfig('RESEND_API_KEY');
    if (!apiKey) {
      // Named, not valued. Thrown rather than left to the SDK constructor,
      // whose own "Missing API key" error would otherwise fall back to
      // reading `process.env.RESEND_API_KEY` itself and produce a less
      // actionable message.
      throw new Error(
        'RESEND_API_KEY is not configured. Set it before running with MAIL_PROVIDER="resend".',
      );
    }
    return apiKey;
  }

  /** Built on first use, mirroring `S3StorageProvider.getClient`. */
  private getClient(apiKey: string): Resend {
    if (!this.client) {
      this.client = new Resend(apiKey);
    }
    return this.client;
  }

  /** Trims so a variable set to whitespace counts as unset. */
  private readConfig(name: string): string | undefined {
    const trimmed = this.config.get<string>(name)?.trim();
    return trimmed ? trimmed : undefined;
  }
}

/**
 * The exact first argument `Resend.logError()` passes to `console.error`. Match
 * on it strictly (`===`, not a substring or a regex) so nothing else can be
 * swallowed by accident.
 */
export const RESEND_SDK_LOG_SENTINEL = '[Resend API Error]:';

/**
 * Depth counter rather than a plain save/restore, so two concurrent sends
 * (which is the normal case — mail is dispatched from event listeners) cannot
 * have the inner one restore `console.error` while the outer one is still
 * running.
 */
let suppressionDepth = 0;
let restoreConsoleError: ConsoleErrorFn | undefined;

/**
 * Node's `console.error` is declared `(...data: any[]) => void`; narrowing the
 * saved reference to this keeps the wrapper below free of `any`.
 */
type ConsoleErrorFn = (...args: unknown[]) => void;

/**
 * Runs `fn` with the Resend SDK's own `console.error` diagnostic suppressed,
 * and nothing else suppressed. See the class comment for why this is needed at
 * all.
 *
 * Scope is deliberately as narrow as it can be made:
 *  - only calls whose **first argument is exactly** the SDK sentinel are
 *    dropped; every other `console.error` in the process, including one that
 *    merely mentions Resend, is forwarded verbatim;
 *  - the patch is installed for the duration of the send and removed in a
 *    `finally`, so a throw cannot leave it in place;
 *  - the diagnostic is not lost, only redirected: the provider throws a
 *    sanitised message carrying Resend's error name and HTTP status, which
 *    `MailService` logs through winston, and the full per-message detail is in
 *    the Resend dashboard.
 */
async function withSdkErrorLoggingSuppressed<T>(
  fn: () => Promise<T>,
): Promise<T> {
  if (suppressionDepth === 0) {
    const original: ConsoleErrorFn = console.error;
    restoreConsoleError = original;
    const filtered: ConsoleErrorFn = (...args) => {
      if (args[0] === RESEND_SDK_LOG_SENTINEL) return;
      original(...args);
    };
    console.error = filtered;
  }
  suppressionDepth += 1;

  try {
    return await fn();
  } finally {
    suppressionDepth -= 1;
    if (suppressionDepth === 0 && restoreConsoleError) {
      console.error = restoreConsoleError;
      restoreConsoleError = undefined;
    }
  }
}

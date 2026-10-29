import { ConfigService } from '@nestjs/config';
import {
  RESEND_SDK_LOG_SENTINEL,
  ResendMailProvider,
} from './resend-mail.provider';
import type { MailMessage } from './mail-provider.interface';

/**
 * BI4 leak-prevention, exercised against the **real** `resend` SDK.
 *
 * `resend-mail.provider.spec.ts` deliberately does `jest.mock('resend')`, which
 * is right for pinning the provider's own logic — but it cannot observe the
 * leak that actually mattered, because the mock replaces the very object that
 * does the logging. The installed SDK's `Resend.logError()` runs on every API
 * error branch of `fetchRequest` and does
 * `console.error("[Resend API Error]:", { status, error, path })` whenever
 * `NODE_ENV !== 'production'`, where `error` is the full parsed Resend payload
 * — recipient addresses, domain-verification detail, the request path.
 *
 * So this spec loads the genuine SDK and stubs `fetch` instead, which is the
 * only place a claim about the SDK's behaviour can honestly be tested. Jest
 * sets `NODE_ENV=test`, so the SDK's logging branch is live here — i.e. this
 * asserts the suppression works in exactly the condition the leak occurs in.
 *
 * No network call is made and no API key is used: `fetch` never reaches the
 * real transport, and the configured key is a placeholder string.
 */

const MESSAGE: MailMessage = {
  from: 'JinVa <no-reply@jinva.test>',
  to: 'artisan@example.test',
  subject: 'Verify your email',
  html: '<p>Verify your email</p>',
  text: 'Verify your email',
};

/**
 * A value planted in the *free-text* part of a simulated Resend payload. If it
 * shows up in a thrown message or on a console sink, sanitisation failed.
 */
const SENTINEL = 'leak-sentinel-not-a-key';

const buildProvider = () =>
  new ResendMailProvider({
    get: <T>(key: string): T | undefined =>
      ({
        RESEND_API_KEY: 'placeholder-not-a-real-key',
        MAIL_FROM: MESSAGE.from,
      })[key] as T | undefined,
  } as ConfigService);

const respondWith = (status: number, body: unknown): void => {
  jest.spyOn(global, 'fetch').mockImplementation(() =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    ),
  );
};

describe('ResendMailProvider against the real resend SDK (BI4 leak prevention)', () => {
  let consoleErrorSpy: jest.SpyInstance;
  let consoleLogSpy: jest.SpyInstance;
  let consoleWarnSpy: jest.SpyInstance;

  beforeEach(() => {
    consoleErrorSpy = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    consoleLogSpy = jest
      .spyOn(console, 'log')
      .mockImplementation(() => undefined);
    consoleWarnSpy = jest
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const everythingWrittenToConsole = (): string =>
    [consoleErrorSpy, consoleLogSpy, consoleWarnSpy]
      .flatMap((spy) => spy.mock.calls as unknown[][])
      .flat()
      .map((arg) => {
        try {
          return typeof arg === 'string' ? arg : JSON.stringify(arg);
        } catch {
          return String(arg);
        }
      })
      .join(' | ');

  it('confirms the environment this is meant to test: the SDK logging branch is live', () => {
    // If this ever fails, the assertions below stop proving anything, because
    // the SDK would be skipping `logError` for its own reasons.
    expect(process.env.NODE_ENV).not.toBe('production');
  });

  it('does not let the SDK write Resend’s free-text payload to any console sink', async () => {
    respondWith(422, {
      name: 'validation_error',
      statusCode: 422,
      message: `The ${MESSAGE.to} recipient is not verified. Reference ${SENTINEL}.`,
    });

    await expect(buildProvider().send(MESSAGE)).rejects.toThrow();

    const written = everythingWrittenToConsole();
    expect(written).not.toContain(SENTINEL);
    expect(written).not.toContain(RESEND_SDK_LOG_SENTINEL);
    expect(written).not.toContain('is not verified');
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('still throws a message an operator can act on — error name plus HTTP status', async () => {
    respondWith(401, {
      name: 'invalid_api_key',
      statusCode: 401,
      message: `API key ${SENTINEL} is invalid`,
    });

    await expect(buildProvider().send(MESSAGE)).rejects.toThrow(
      /Resend rejected the message: invalid_api_key \(HTTP 401\)/,
    );
  });

  it('keeps the free-text detail out of the thrown message too', async () => {
    respondWith(403, {
      name: 'restricted_api_key',
      statusCode: 403,
      message: `Domain jinva.test is not verified — ${SENTINEL}`,
    });

    const thrown = await buildProvider()
      .send(MESSAGE)
      .then(
        () => null,
        (err: unknown) => err,
      );

    const message = (thrown as Error).message;
    expect(message).not.toContain(SENTINEL);
    expect(message).not.toContain('is not verified');
    expect(message).not.toContain('placeholder-not-a-real-key');
  });

  it('restores console.error afterwards — the suppression is scoped to the send, not global', async () => {
    respondWith(500, { name: 'application_error', statusCode: 500 });
    const provider = buildProvider();

    await expect(provider.send(MESSAGE)).rejects.toThrow();

    // Anything at all, including something that looks exactly like the SDK's
    // own line, gets through once the send is over.
    console.error(RESEND_SDK_LOG_SENTINEL, 'from somewhere else entirely');
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      RESEND_SDK_LOG_SENTINEL,
      'from somewhere else entirely',
    );
  });

  it('suppresses only the SDK sentinel — an unrelated console.error during a send is untouched', async () => {
    jest.spyOn(global, 'fetch').mockImplementation(() => {
      console.error('an unrelated app diagnostic', { detail: 'keep me' });
      return Promise.resolve(
        new Response(JSON.stringify({ id: 'abc' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    });

    await expect(buildProvider().send(MESSAGE)).resolves.toBeUndefined();

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      'an unrelated app diagnostic',
      {
        detail: 'keep me',
      },
    );
  });

  it('resolves silently on a successful send, logging nothing at all', async () => {
    respondWith(200, { id: 'e9f4b0c2-0000-4000-8000-000000000000' });

    await expect(buildProvider().send(MESSAGE)).resolves.toBeUndefined();
    expect(everythingWrittenToConsole()).toBe('');
  });
});

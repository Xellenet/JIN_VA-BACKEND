import { HttpException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import type { ExecutionContext } from '@nestjs/common';
import { VARIABLES } from '@common/constants/variables.constants';
import {
  TURNSTILE_FAILED_ERROR_CODE,
  TURNSTILE_REQUIRED_ERROR_CODE,
  TURNSTILE_UNAVAILABLE_ERROR_CODE,
  TurnstileService,
} from './turnstile.service';
import { RequireTurnstile, TurnstileGuard } from './turnstile.guard';

/** Cloudflare is never called: `fetch` is replaced per test (hermetic.ts blocks it anyway). */
describe('TurnstileService', () => {
  const config = (values: Record<string, string | undefined>) =>
    ({ get: (key: string) => values[key] }) as unknown as ConfigService;
  // Cloudflare's documented always-pass test secret; no request leaves the process.
  const enabled = () =>
    new TurnstileService(
      config({ TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA' }),
    );
  let fetchSpy: jest.SpyInstance;

  const answer = (body: unknown, status = 200) =>
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    );

  beforeEach(() => {
    fetchSpy = jest.spyOn(globalThis, 'fetch');
  });
  afterEach(() => fetchSpy.mockRestore());

  it('is skipped, with one startup warning, when the secret is unset', async () => {
    const service = new TurnstileService(config({}));
    const warn = jest
      .spyOn(service['logger'], 'warn')
      .mockImplementation(() => undefined);
    service.onModuleInit();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(service.isEnabled()).toBe(false);
    expect(await service.verify(undefined, 'register')).toEqual({
      outcome: 'skipped',
    });
    await expect(
      service.assertPassed(undefined, 'register'),
    ).resolves.toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does not warn when the secret is set', () => {
    const service = enabled();
    const warn = jest
      .spyOn(service['logger'], 'warn')
      .mockImplementation(() => undefined);
    service.onModuleInit();
    expect(warn).not.toHaveBeenCalled();
  });

  it('passes a token Cloudflare accepts for the right action, sending secret, token and IP', async () => {
    answer({ success: true, action: 'register', hostname: 'app.jinva.test' });
    const service = enabled();

    expect(await service.verify('tok-123', 'register', '203.0.113.9')).toEqual({
      outcome: 'passed',
    });

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(VARIABLES.TURNSTILE_SITEVERIFY_URL);
    expect(init.method).toBe('POST');
    const sent = new URLSearchParams(init.body as URLSearchParams);
    expect(sent.get('secret')).toBe('1x0000000000000000000000000000000AA');
    expect(sent.get('response')).toBe('tok-123');
    expect(sent.get('remoteip')).toBe('203.0.113.9');
    expect(init.signal).toBeDefined();
  });

  it('fails a missing token without calling Cloudflare', async () => {
    const service = enabled();
    expect(await service.verify('', 'login')).toEqual({
      outcome: 'failed',
      reason: 'missing-token',
    });
    expect(await service.verify(42, 'login')).toEqual({
      outcome: 'failed',
      reason: 'missing-token',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fails a token Cloudflare rejects', async () => {
    answer({ success: false, 'error-codes': ['invalid-input-response'] });
    expect(await enabled().verify('bad', 'forgot')).toEqual({
      outcome: 'failed',
      reason: 'rejected',
    });
  });

  it('fails a token made for another action', async () => {
    answer({ success: true, action: 'login' });
    expect(await enabled().verify('tok', 'register')).toEqual({
      outcome: 'failed',
      reason: 'wrong-action',
    });
  });

  it('checks the hostname only when TURNSTILE_EXPECTED_HOSTNAME is set', async () => {
    const strict = new TurnstileService(
      config({
        TURNSTILE_SECRET_KEY: 'secret',
        TURNSTILE_EXPECTED_HOSTNAME: 'app.jinva.test',
      }),
    );
    answer({
      success: true,
      action: 'code_request',
      hostname: 'evil.example.com',
    });
    expect(await strict.verify('tok', 'code_request')).toEqual({
      outcome: 'failed',
      reason: 'wrong-hostname',
    });
    answer({
      success: true,
      action: 'code_request',
      hostname: 'app.jinva.test',
    });
    expect(await strict.verify('tok', 'code_request')).toEqual({
      outcome: 'passed',
    });
    answer({
      success: true,
      action: 'code_request',
      hostname: 'anything.example.com',
    });
    expect(await enabled().verify('tok', 'code_request')).toEqual({
      outcome: 'passed',
    });
  });

  it('is unavailable (fail-closed) on a timeout, a network error or a non-200', async () => {
    fetchSpy.mockRejectedValueOnce(
      Object.assign(new Error('timed out'), { name: 'TimeoutError' }),
    );
    expect(await enabled().verify('tok', 'register')).toEqual({
      outcome: 'unavailable',
    });
    fetchSpy.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    expect(await enabled().verify('tok', 'register')).toEqual({
      outcome: 'unavailable',
    });
    answer({ oops: true }, 502);
    expect(await enabled().verify('tok', 'register')).toEqual({
      outcome: 'unavailable',
    });
  });

  it('really aborts a slow siteverify after TURNSTILE_TIMEOUT_MS', async () => {
    fetchSpy.mockImplementationOnce(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal!.addEventListener('abort', () =>
            reject(new Error(String(init.signal!.reason))),
          );
        }),
    );
    const quick = new TurnstileService(
      config({ TURNSTILE_SECRET_KEY: 's', TURNSTILE_TIMEOUT_MS: '20' }),
    );
    expect(await quick.verify('tok', 'login')).toEqual({
      outcome: 'unavailable',
    });
  });

  it('assertPassed maps outcomes to the contract errors', async () => {
    const service = enabled();
    const status = async (p: Promise<void>) => {
      try {
        await p;
        return 'ok';
      } catch (e) {
        const err = e as HttpException;
        return `${err.getStatus()} ${(err.getResponse() as { errorCode: string }).errorCode}`;
      }
    };
    answer({ success: true, action: 'register' });
    expect(await status(service.assertPassed('tok', 'register'))).toBe('ok');
    expect(await status(service.assertPassed(undefined, 'register'))).toBe(
      `400 ${TURNSTILE_FAILED_ERROR_CODE}`,
    );
    expect(
      await status(
        service.assertPassed(undefined, 'login', null, {
          status: 401,
          errorCode: TURNSTILE_REQUIRED_ERROR_CODE,
        }),
      ),
    ).toBe(`401 ${TURNSTILE_REQUIRED_ERROR_CODE}`);
    fetchSpy.mockRejectedValueOnce(new Error('down'));
    expect(await status(service.assertPassed('tok', 'register'))).toBe(
      `503 ${TURNSTILE_UNAVAILABLE_ERROR_CODE}`,
    );
  });
});

describe('TurnstileGuard', () => {
  class Handlers {
    @RequireTurnstile('forgot')
    guarded() {}
    open() {}
  }
  const contextFor = (handler: () => void, body: unknown) =>
    ({
      getHandler: () => handler,
      switchToHttp: () => ({
        getRequest: () => ({ body, ip: '198.51.100.4' }),
      }),
    }) as unknown as ExecutionContext;

  it('checks the route action with the body token and the client IP', async () => {
    const turnstile = { assertPassed: jest.fn().mockResolvedValue(undefined) };
    const guard = new TurnstileGuard(
      new Reflector(),
      turnstile as unknown as TurnstileService,
    );

    expect(
      await guard.canActivate(
        contextFor(Handlers.prototype.guarded, { turnstileToken: 't' }),
      ),
    ).toBe(true);
    expect(turnstile.assertPassed).toHaveBeenCalledWith(
      't',
      'forgot',
      '198.51.100.4',
    );
  });

  it('lets a route without an action through, and copes with no body', async () => {
    const turnstile = { assertPassed: jest.fn().mockResolvedValue(undefined) };
    const guard = new TurnstileGuard(
      new Reflector(),
      turnstile as unknown as TurnstileService,
    );
    expect(
      await guard.canActivate(contextFor(Handlers.prototype.open, undefined)),
    ).toBe(true);
    expect(turnstile.assertPassed).not.toHaveBeenCalled();
    await guard.canActivate(contextFor(Handlers.prototype.guarded, undefined));
    expect(turnstile.assertPassed).toHaveBeenCalledWith(
      undefined,
      'forgot',
      '198.51.100.4',
    );
  });
});

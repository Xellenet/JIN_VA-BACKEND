import {
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { VARIABLES } from '@common/constants/variables.constants';

/** The actions the frontend widget is rendered with. The backend checks the token's action matches. */
export const TURNSTILE_ACTIONS = [
  'register',
  'code_request',
  'forgot',
  'login',
] as const;
export type TurnstileAction = (typeof TURNSTILE_ACTIONS)[number];

/** `meta.error` codes. */
export const TURNSTILE_FAILED_ERROR_CODE = 'TURNSTILE_FAILED';
export const TURNSTILE_REQUIRED_ERROR_CODE = 'TURNSTILE_REQUIRED';
export const TURNSTILE_UNAVAILABLE_ERROR_CODE = 'TURNSTILE_UNAVAILABLE';

/** What siteverify answered, reduced to what we check. */
export type TurnstileResult =
  | { outcome: 'skipped' }
  | { outcome: 'passed' }
  | {
      outcome: 'failed';
      reason: 'missing-token' | 'rejected' | 'wrong-action' | 'wrong-hostname';
    }
  | { outcome: 'unavailable' };

interface SiteverifyResponse {
  success?: boolean;
  action?: string;
  hostname?: string;
  'error-codes'?: string[];
}

/**
 * Cloudflare Turnstile server-side check (siteverify).
 *
 * - POSTs the secret, the token and the client IP; a token passes only when
 *   Cloudflare says `success`, the token was made for the expected `action`,
 *   and — when `TURNSTILE_EXPECTED_HOSTNAME` is set — for that hostname.
 * - Short timeout (`TURNSTILE_TIMEOUT_MS`, default 3 s).
 * - **Unset `TURNSTILE_SECRET_KEY` turns the check off** (dev and tests): every
 *   call is `skipped`, and one warning is logged at startup.
 * - **Fail-closed.** If Cloudflare can't be reached, times out or answers
 *   garbage, the result is `unavailable` and the guarded request is refused
 *   with 503 `TURNSTILE_UNAVAILABLE` — sign-up, code requests and forgot
 *   password must not turn into open mail relays during a Cloudflare outage,
 *   and password login only asks for Turnstile after repeated failures, so a
 *   user who hits that during an outage can retry shortly.
 *
 * Tokens and the secret are never logged.
 */
@Injectable()
export class TurnstileService implements OnModuleInit {
  private readonly logger = new Logger(TurnstileService.name);
  private readonly secret: string | undefined;
  private readonly expectedHostname: string | undefined;
  private readonly timeoutMs: number;

  constructor(config: ConfigService) {
    this.secret = config.get<string>('TURNSTILE_SECRET_KEY') || undefined;
    this.expectedHostname =
      config.get<string>('TURNSTILE_EXPECTED_HOSTNAME') || undefined;
    const timeout = Number(config.get<string | number>('TURNSTILE_TIMEOUT_MS'));
    this.timeoutMs =
      Number.isFinite(timeout) && timeout > 0
        ? Math.floor(timeout)
        : VARIABLES.TURNSTILE_TIMEOUT_MS;
  }

  onModuleInit(): void {
    if (!this.secret) {
      this.logger.warn(
        'TURNSTILE_SECRET_KEY is not set: Turnstile checks are skipped (register, code requests, forgot password, login after failures).',
      );
    }
  }

  isEnabled(): boolean {
    return Boolean(this.secret);
  }

  async verify(
    token: unknown,
    action: TurnstileAction,
    remoteIp?: string | null,
  ): Promise<TurnstileResult> {
    if (!this.secret) return { outcome: 'skipped' };
    if (
      typeof token !== 'string' ||
      token.length === 0 ||
      token.length > 2048
    ) {
      return { outcome: 'failed', reason: 'missing-token' };
    }

    const body = new URLSearchParams({ secret: this.secret, response: token });
    if (remoteIp) body.set('remoteip', remoteIp);

    let data: SiteverifyResponse;
    try {
      const res = await fetch(VARIABLES.TURNSTILE_SITEVERIFY_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) throw new Error(`siteverify HTTP ${res.status}`);
      data = (await res.json()) as SiteverifyResponse;
    } catch (err) {
      this.logger.error(
        `Turnstile siteverify unavailable (${action}): ${(err as Error)?.name ?? 'Error'}`,
      );
      return { outcome: 'unavailable' };
    }

    if (data?.success !== true) {
      this.logger.warn(
        `Turnstile token rejected (${action}): ${(data?.['error-codes'] ?? []).join(',') || 'no error code'}`,
      );
      return { outcome: 'failed', reason: 'rejected' };
    }
    if (data.action !== action) {
      this.logger.warn(`Turnstile token was for another action (${action})`);
      return { outcome: 'failed', reason: 'wrong-action' };
    }
    if (this.expectedHostname && data.hostname !== this.expectedHostname) {
      this.logger.warn(`Turnstile token was for another hostname (${action})`);
      return { outcome: 'failed', reason: 'wrong-hostname' };
    }
    return { outcome: 'passed' };
  }

  /**
   * Verifies and throws the contract's error when the token doesn't pass:
   * 400 `TURNSTILE_FAILED` (or `failedErrorCode`, with `failedStatus`) for a
   * missing or rejected token, 503 `TURNSTILE_UNAVAILABLE` when Cloudflare
   * can't be reached.
   */
  async assertPassed(
    token: unknown,
    action: TurnstileAction,
    remoteIp?: string | null,
    failed: { status: number; errorCode: string } = {
      status: HttpStatus.BAD_REQUEST,
      errorCode: TURNSTILE_FAILED_ERROR_CODE,
    },
  ): Promise<void> {
    const result = await this.verify(token, action, remoteIp);
    if (result.outcome === 'skipped' || result.outcome === 'passed') return;
    if (result.outcome === 'unavailable') {
      throw new HttpException(
        {
          errorCode: TURNSTILE_UNAVAILABLE_ERROR_CODE,
          message:
            "We couldn't run the security check just now. Please try again in a moment.",
        },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    throw new HttpException(
      {
        errorCode: failed.errorCode,
        message:
          failed.errorCode === TURNSTILE_REQUIRED_ERROR_CODE
            ? 'Please complete the security check and try again.'
            : "The security check didn't pass. Please try again.",
      },
      failed.status,
    );
  }
}

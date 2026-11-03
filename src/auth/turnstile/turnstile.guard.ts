import {
  CanActivate,
  ExecutionContext,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { TurnstileAction, TurnstileService } from './turnstile.service';

const TURNSTILE_ACTION_KEY = 'turnstile:action';

/**
 * Checks `body.turnstileToken` against Cloudflare for this route's action
 * before the handler runs. A no-op when `TURNSTILE_SECRET_KEY` is unset.
 *
 * Runs before validation, so it reads the token defensively; the DTOs also
 * declare `turnstileToken` so `forbidNonWhitelisted` accepts it.
 */
@Injectable()
export class TurnstileGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly turnstile: TurnstileService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const action = this.reflector.get<TurnstileAction | undefined>(
      TURNSTILE_ACTION_KEY,
      context.getHandler(),
    );
    if (!action) return true;
    const req = context.switchToHttp().getRequest<Request>();
    const body = req.body as Record<string, unknown> | undefined;
    await this.turnstile.assertPassed(body?.turnstileToken, action, req.ip);
    return true;
  }
}

/**
 * `@RequireTurnstile('register')`: names the action `TurnstileGuard` checks
 * for this route. List the guard explicitly after the throttler —
 * `@UseGuards(AuthEmailThrottlerGuard, TurnstileGuard)` — so a flood is cut
 * off by the rate limit before any call to Cloudflare is made.
 */
export const RequireTurnstile = (action: TurnstileAction) =>
  SetMetadata(TURNSTILE_ACTION_KEY, action);

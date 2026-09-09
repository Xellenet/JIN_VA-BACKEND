import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';
import type { ExecutionContext } from '@nestjs/common';

/**
 * A `ThrottlerGuard` scoped to exactly one of the named throttlers configured
 * in `ThrottlingModule`.
 *
 * This exists because the stock guard applies **every** configured throttler to
 * **every** route it protects. With one named throttler in the config that
 * distinction was invisible; the moment a second one was added (auth), the
 * message-send route would have started silently enforcing the auth limit too —
 * i.e. adding a limit to `/auth/login` would have broken `/messages`. Scoping
 * each guard to its own name keeps the named throttlers independent, which is
 * what "named" implies at every call site.
 *
 * Note that scoping does **not** mean sharing a counter. `generateKey` includes
 * the controller and handler name, so two routes attached to the same named
 * throttler get the same *configuration* (limit + window) and separate
 * *buckets*.
 */
@Injectable()
export abstract class NamedThrottlerGuard extends ThrottlerGuard {
  /** Must match one of `THROTTLER_NAMES`. */
  protected abstract readonly throttlerName: string;

  async onModuleInit(): Promise<void> {
    await super.onModuleInit();
    const scoped = this.throttlers.filter(
      (throttler) => throttler.name === this.throttlerName,
    );
    if (scoped.length === 0) {
      // Fail the bootstrap rather than come up with this guard silently
      // enforcing nothing. A route that believes it is rate-limited and isn't
      // is a security regression no test or log would otherwise reveal.
      throw new Error(
        `${this.constructor.name}: no throttler named "${this.throttlerName}" ` +
          `is configured. Add it to THROTTLER_NAMES/ThrottlingModule or fix the name.`,
      );
    }
    this.throttlers = scoped;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Belt and braces. `this.throttlers` is populated by the lifecycle hook
    // above, which Nest only calls for a guard it instantiated as a provider.
    // If one of these guards is ever attached to a route without also being
    // registered in its module's `providers`, the stock `canActivate` would
    // throw a TypeError on undefined and the caller would get a 500 — the
    // opposite of the clean, specific 429 these guards exist to produce.
    if (!Array.isArray(this.throttlers)) {
      await this.onModuleInit();
    }
    return super.canActivate(context);
  }
}

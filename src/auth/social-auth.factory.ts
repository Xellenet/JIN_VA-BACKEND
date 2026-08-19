import { Injectable, BadRequestException } from '@nestjs/common';
import { SocialAuthStrategy } from './strategy/social-auth.strategy';
import { ConfigService } from '@nestjs/config';
import { GoogleAuthStrategy } from './strategy/google-auth.strategy';

@Injectable()
export class SocialAuthStrategyFactory {
  private readonly strategies: Map<string, SocialAuthStrategy> = new Map();

  constructor(
    private readonly configService: ConfigService,
    // Fixed: this used to be `new GoogleAuthStrategy(httpService)`, manually
    // constructing a second instance instead of injecting the one Nest DI
    // already builds and owns via auth.module.ts's `providers` list. That
    // DI-managed instance was fully constructed (reading env vars,
    // potentially throwing on misconfiguration) but never actually used by
    // anything — harmless since both instances read the same env vars and
    // shared the same HttpService singleton, but confusing for maintenance.
    // Now there is exactly one instance. See
    // docs/team/google-oauth-fix/qa-report.md ([MINOR]).
    private readonly googleAuthStrategy: GoogleAuthStrategy,
  ) {
    this.registerStrategy(this.googleAuthStrategy);
  }

  private registerStrategy(strategy: SocialAuthStrategy): void {
    this.strategies.set(strategy.getProviderName(), strategy);
  }

  getStrategy(provider: string): SocialAuthStrategy {
    const strategy = this.strategies.get(provider.toLowerCase());
    if (!strategy) {
      throw new BadRequestException(`Unsupported provider: ${provider}`);
    }
    return strategy;
  }

  getSupportedProviders(): string[] {
    return Array.from(this.strategies.keys());
  }
}

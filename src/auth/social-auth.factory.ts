import { Injectable, BadRequestException } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { SocialAuthStrategy } from './strategy/social-auth.strategy';
import { ConfigService } from '@nestjs/config';
import { GoogleAuthStrategy } from './strategy/google-auth.strategy';

@Injectable()
export class SocialAuthStrategyFactory {
  private readonly strategies: Map<string, SocialAuthStrategy> = new Map();

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
  ) {
    this.registerStrategy(new GoogleAuthStrategy(httpService));
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

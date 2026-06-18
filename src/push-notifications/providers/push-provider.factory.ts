import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FcmPushProvider } from './fcm-push.provider';
import { LogPushProvider } from './log-push.provider';
import type { IPushProvider } from './push-provider.interface';

@Injectable()
export class PushProviderFactory {
  private readonly provider: IPushProvider;

  constructor(
    private readonly fcm: FcmPushProvider,
    private readonly log: LogPushProvider,
    config: ConfigService,
  ) {
    const name = config.get<string>('PUSH_PROVIDER', 'log');
    switch (name) {
      case 'fcm':
        this.provider = this.fcm;
        break;
      default:
        this.provider = this.log;
    }
  }

  get(): IPushProvider {
    return this.provider;
  }
}

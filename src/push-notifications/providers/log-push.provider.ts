import { Injectable, Logger } from '@nestjs/common';
import type { IPushProvider, PushPayload, PushSendResult } from './push-provider.interface';

/**
 * No-op provider used in local development. Logs the notification to console
 * instead of sending it to FCM/APNS — no credentials required.
 * Activated when PUSH_PROVIDER is unset or set to 'log'.
 */
@Injectable()
export class LogPushProvider implements IPushProvider {
  readonly providerName = 'log';
  private readonly logger = new Logger(LogPushProvider.name);

  async send(tokens: string[], payload: PushPayload): Promise<PushSendResult> {
    this.logger.debug(
      `[PUSH:LOG] "${payload.title}" → ${tokens.length} device(s): ${payload.body}`,
    );
    return { successCount: tokens.length, failedTokens: [] };
  }
}

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import type { IPushProvider, PushPayload, PushSendResult } from './push-provider.interface';

@Injectable()
export class FcmPushProvider implements IPushProvider, OnModuleInit {
  readonly providerName = 'fcm';
  private readonly logger = new Logger(FcmPushProvider.name);

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    const projectId = this.config.get<string>('FIREBASE_PROJECT_ID');
    if (!projectId) {
      this.logger.warn('FIREBASE_PROJECT_ID not set — FCM provider inactive. Set PUSH_PROVIDER=fcm to enable.');
      return;
    }

    if (!getApps().length) {
      initializeApp({
        credential: cert({
          projectId,
          clientEmail: this.config.get<string>('FIREBASE_CLIENT_EMAIL'),
          privateKey:  this.config.get<string>('FIREBASE_PRIVATE_KEY')?.replace(/\\n/g, '\n'),
        }),
      });
      this.logger.log('Firebase Admin SDK initialised');
    }
  }

  async send(tokens: string[], payload: PushPayload): Promise<PushSendResult> {
    if (!tokens.length || !getApps().length) return { successCount: 0, failedTokens: [] };

    const response = await getMessaging().sendEachForMulticast({
      tokens,
      notification: { title: payload.title, body: payload.body },
      data: payload.data ?? {},
      android: { priority: 'high' },
      apns: { payload: { aps: { sound: 'default' } } },
    });

    const failedTokens: string[] = [];
    response.responses.forEach((r, i) => {
      if (!r.success) {
        this.logger.warn(`FCM token failed (${r.error?.code}): ${tokens[i]}`);
        if (
          r.error?.code === 'messaging/registration-token-not-registered' ||
          r.error?.code === 'messaging/invalid-registration-token'
        ) {
          failedTokens.push(tokens[i]);
        }
      }
    });

    this.logger.log(`Push sent: ${response.successCount}/${tokens.length} succeeded`);
    return { successCount: response.successCount, failedTokens };
  }
}

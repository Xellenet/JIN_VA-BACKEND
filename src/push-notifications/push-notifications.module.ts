import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule } from '@nestjs/config';
import { DeviceToken } from './entities/device-token.entity';
import { NotificationPreferences } from '../notifications/entities/notification-preferences.entity';
import { FcmPushProvider } from './providers/fcm-push.provider';
import { LogPushProvider } from './providers/log-push.provider';
import { PushProviderFactory } from './providers/push-provider.factory';
import { PushNotificationsService } from './push-notifications.service';
import { PushNotificationsController } from './push-notifications.controller';
import { PushNotificationsListener } from './listeners/push-notifications.listener';

@Module({
  imports: [
    ConfigModule,
    TypeOrmModule.forFeature([DeviceToken, NotificationPreferences]),
  ],
  controllers: [PushNotificationsController],
  providers: [
    FcmPushProvider,
    LogPushProvider,
    PushProviderFactory,
    PushNotificationsService,
    PushNotificationsListener,
  ],
  exports: [PushNotificationsService],
})
export class PushNotificationsModule {}

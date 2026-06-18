import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { Notification } from './entities/notification.entity';
import { NotificationPreferences } from './entities/notification-preferences.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Notification, NotificationPreferences])],
  controllers: [NotificationsController],
  providers: [NotificationsService],
})
export class NotificationsModule {}

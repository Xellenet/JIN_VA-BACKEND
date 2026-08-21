import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { Notification } from './entities/notification.entity';
import { NotificationPreferences } from './entities/notification-preferences.entity';
import { User } from '@users/entities/user.entity';

@Module({
  imports: [
    // PR3: `User` is needed to fan admin-queue notifications out to every
    // ADMIN account (see `NotificationsService.persistForAdmins`).
    TypeOrmModule.forFeature([Notification, NotificationPreferences, User]),
  ],
  controllers: [NotificationsController],
  providers: [NotificationsService],
})
export class NotificationsModule {}

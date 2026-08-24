import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { UsersModule } from './users/users.module';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WinstonModule } from 'nest-winston';
import { AuthModule } from './auth/auth.module';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ScheduleModule } from '@nestjs/schedule';
import { MailModule } from 'mail/mail.module';
import { typeOrmConfigAsync } from 'config/typeorm.config';
import { winstonConfig } from 'config/winston.config';
import { appConfig } from 'config/app.config';
import { ReviewsModule } from './reviews/reviews.module';
import { ServicesModule } from './services/services.module';
import { JobsModule } from './jobs/jobs.module';
import { ArtisansModule } from './artisans/artisans.module';
import { FavouritesModule } from './favourites/favourites.module';
import { MessagesModule } from './messages/messages.module';
import { NotificationsModule } from './notifications/notifications.module';
import { AvailabilityModule } from './availability/availability.module';
import { VerificationModule } from './verification/verification.module';
import { SchedulerModule } from './scheduler/scheduler.module';
import { BookingsModule } from './bookings/bookings.module';
import { AdminModule } from './admin/admin.module';
import { UploadsModule } from './uploads/uploads.module';
import { PushNotificationsModule } from './push-notifications/push-notifications.module';
import { DisputesModule } from './disputes/disputes.module';
import { PaymentsModule } from './payments/payments.module';
import { PortfolioModule } from './portfolio/portfolio.module';
import { AdminAuditModule } from './admin-audit/admin-audit.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [appConfig],
    }),
    TypeOrmModule.forRootAsync(typeOrmConfigAsync),
    WinstonModule.forRoot(winstonConfig),
    EventEmitterModule.forRoot(),
    ScheduleModule.forRoot(),
    MailModule,
    UsersModule,
    AuthModule,
    ReviewsModule,
    ServicesModule,
    JobsModule,
    ArtisansModule,
    FavouritesModule,
    // MB1: `MessagesModule` is the platform's single messaging backend. The
    // former `DirectMessagesModule` was retired here — running both meant the
    // frontend talked to the one that emitted no events, so sending a message
    // notified nobody. Re-registering a second messaging module would
    // reintroduce exactly that bug.
    MessagesModule,
    NotificationsModule,
    AvailabilityModule,
    VerificationModule,
    SchedulerModule,
    BookingsModule,
    AdminModule,
    UploadsModule,
    PushNotificationsModule,
    DisputesModule,
    PaymentsModule,
    PortfolioModule,
    // AT5: leaf module owning the append-only `admin_actions` log. Imported by
    // every module that performs an auditable admin action.
    AdminAuditModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}

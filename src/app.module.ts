import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { UsersModule } from './users/users.module';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WinstonModule } from 'nest-winston';
import { AuthModule } from './auth/auth.module';
import { EventEmitterModule } from '@nestjs/event-emitter';
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

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [appConfig]
    }),
    TypeOrmModule.forRootAsync(typeOrmConfigAsync),
    WinstonModule.forRoot(winstonConfig),
    EventEmitterModule.forRoot(),
    MailModule,
    UsersModule,
    AuthModule,
    ReviewsModule,
    ServicesModule,
    JobsModule,
    ArtisansModule,
    FavouritesModule,
    MessagesModule,
    NotificationsModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}

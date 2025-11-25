import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { UsersModule } from './users/users.module';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WinstonModule } from 'nest-winston';
import { AuthModule } from './auth/auth.module';
import { AuthService } from './auth/auth.service';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { MailModule } from 'mail/mail.module';
import { typeOrmConfigAsync } from 'config/typeorm.config';
import { winstonConfig } from 'config/winston.config';
import { appConfig } from 'config/app.config';

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
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}

import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MailService } from './mail.service';
import { MailTemplateService } from './mail.template';
import { UserMailListener } from './listeners/user-mail.listener';
import { DomainMailListener } from './listeners/domain-mail.listener';
import { MailProviderFactory } from './providers/mail-provider.factory';
import { ResendMailProvider } from './providers/resend-mail.provider';
import { SmtpMailProvider } from './providers/smtp-mail.provider';
import { User } from '../users/entities/user.entity';
import { NotificationPreferences } from '../notifications/entities/notification-preferences.entity';

@Module({
  imports: [
    ConfigModule,
    TypeOrmModule.forFeature([User, NotificationPreferences]),
  ],
  providers: [
    MailService,
    MailTemplateService,
    UserMailListener,
    DomainMailListener,
    // BI4: the transport seam, wired exactly like `UploadsModule` wires its
    // storage providers — both implementations registered, the factory picks
    // one from `MAIL_PROVIDER`.
    SmtpMailProvider,
    ResendMailProvider,
    MailProviderFactory,
  ],
  exports: [MailService],
})
export class MailModule {}

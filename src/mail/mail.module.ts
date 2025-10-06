import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MailService } from './mail.service';
import { MailTemplateService } from './mail.template';
import { UserMailListener } from './listeners/user-mail.listener';

@Module({
  imports: [ConfigModule],
  providers: [
    MailService,
    MailTemplateService,
    UserMailListener,
  ],
  exports: [MailService],
})
export class MailModule {}

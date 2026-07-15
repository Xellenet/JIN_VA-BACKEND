import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MailService } from './mail.service';
import { MailTemplateService } from './mail.template';
import { UserMailListener } from './listeners/user-mail.listener';
import { DomainMailListener } from './listeners/domain-mail.listener';
import { User } from '../users/entities/user.entity';

@Module({
  imports: [
    ConfigModule,
    TypeOrmModule.forFeature([User]),
  ],
  providers: [
    MailService,
    MailTemplateService,
    UserMailListener,
    DomainMailListener,
  ],
  exports: [MailService],
})
export class MailModule {}

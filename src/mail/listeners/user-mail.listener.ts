import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { MailEvent } from '../events/mail.events';
import { MailService } from '../mail.service';
import { ConfigService } from '@nestjs/config';
import type { UserRegisteredPayload } from '../events/mail.events';

@Injectable()
export class UserMailListener {
  constructor(
    private readonly mailService: MailService,
    private readonly config: ConfigService,
  ) {}

  @OnEvent(MailEvent.USER_REGISTERED, { async: true })
  async handleUserRegistered(payload: UserRegisteredPayload) {
    const verifyUrl = `${this.config.get('FRONTEND_URL')}/verify?token=${payload.verificationToken}`;

    await this.mailService.sendMail(payload.email, MailEvent.USER_REGISTERED, {
      firstname: payload.firstname,
      verifyUrl,
    });
  }
}

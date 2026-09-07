import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MessagesController } from './messages.controller';
import { MessagesService } from './messages.service';
import { MessageSendThrottlerGuard } from './guards/message-send-throttler.guard';
import { Message } from './entities/message.entity';
import { Conversation } from './entities/conversation.entity';
import { User } from '@users/entities/user.entity';
import { Job } from '@jobs/entities/job.entity';
import { Booking } from '../bookings/entities/booking.entity';
import { ThrottlingModule } from '@common/throttling/throttling.module';

@Module({
  imports: [
    // `Job`/`Booking` back MC2's participation check — a sender may only tag a
    // message with a job/booking they are actually party to.
    TypeOrmModule.forFeature([Message, Conversation, User, Job, Booking]),
    /**
     * RL1: the `message-send` throttler (and its
     * `MESSAGE_RATE_LIMIT_PER_MINUTE` override) is configured centrally in
     * `ThrottlingModule`, which used to be registered inline here. It moved
     * when `/auth/*` needed limits of its own: `ThrottlerModule` is `@Global()`,
     * so two root registrations would have left two competing option providers
     * in the global scope. Nothing about this route's limit changed — it is
     * still opt-in per route (no `APP_GUARD`), still 25/minute by default, and
     * `MessageSendThrottlerGuard` still scopes itself to the `message-send`
     * throttler alone, so the auth limits do not apply here.
     */
    ThrottlingModule,
  ],
  controllers: [MessagesController],
  providers: [MessagesService, MessageSendThrottlerGuard],
  // AD1: `DisputesModule` consumes `getConversationBetween` for the admin
  // dispute-conversation lookup.
  exports: [MessagesService],
})
export class MessagesModule {}

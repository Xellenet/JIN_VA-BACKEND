import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { MessagesController } from './messages.controller';
import { MessagesService } from './messages.service';
import { MessageSendThrottlerGuard } from './guards/message-send-throttler.guard';
import { Message } from './entities/message.entity';
import { Conversation } from './entities/conversation.entity';
import { User } from '@users/entities/user.entity';
import { Job } from '@jobs/entities/job.entity';
import { Booking } from '../bookings/entities/booking.entity';

/** RL1: default when `MESSAGE_RATE_LIMIT_PER_MINUTE` is unset. */
const DEFAULT_MESSAGE_RATE_LIMIT = 25;

@Module({
  imports: [
    // `Job`/`Booking` back MC2's participation check — a sender may only tag a
    // message with a job/booking they are actually party to.
    TypeOrmModule.forFeature([Message, Conversation, User, Job, Booking]),
    /**
     * RL1: registered here rather than globally in `AppModule` on purpose.
     * The requirement is a rate limit on *sending a message*; a global
     * `APP_GUARD` registration would silently start throttling every other
     * endpoint in the application, which is a much bigger behavioural change
     * than what was asked for. The named `message-send` throttler is applied
     * by `@UseGuards(MessageSendThrottlerGuard)` on that one route.
     *
     * The limit is tunable without a code change (requirements.md Open
     * Question #5 flags 20–30/minute as a starting point, not a resolved
     * figure) — set `MESSAGE_RATE_LIMIT_PER_MINUTE` in the environment.
     */
    ThrottlerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const raw = config.get<string | number>(
          'MESSAGE_RATE_LIMIT_PER_MINUTE',
          DEFAULT_MESSAGE_RATE_LIMIT,
        );
        const parsed = Number(raw);
        const limit =
          Number.isFinite(parsed) && parsed > 0
            ? Math.floor(parsed)
            : DEFAULT_MESSAGE_RATE_LIMIT;
        return {
          throttlers: [{ name: 'message-send', ttl: 60_000, limit }],
        };
      },
    }),
  ],
  controllers: [MessagesController],
  providers: [MessagesService, MessageSendThrottlerGuard],
  // AD1: `DisputesModule` consumes `getConversationBetween` for the admin
  // dispute-conversation lookup.
  exports: [MessagesService],
})
export class MessagesModule {}

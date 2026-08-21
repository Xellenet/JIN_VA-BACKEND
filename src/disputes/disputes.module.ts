import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Dispute } from './entities/dispute.entity';
import { Booking } from '../bookings/entities/booking.entity';
import { Job } from '@jobs/entities/job.entity';
import { Payment } from '../payments/entities/payment.entity';
import { DisputesService } from './disputes.service';
import { DisputesController } from './disputes.controller';
import { MessagesModule } from '@messages/messages.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Dispute, Booking, Job, Payment]),
    // AD1: supplies `MessagesService.getConversationBetween` for the
    // dispute-scoped, read-only conversation lookup.
    MessagesModule,
  ],
  controllers: [DisputesController],
  providers: [DisputesService],
  exports: [DisputesService],
})
export class DisputesModule {}

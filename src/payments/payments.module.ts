import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PaymentsService } from './payments.service';
import { PaymentsController } from './payments.controller';
import { PaystackService } from './paystack.service';
import { Payment } from './entities/payment.entity';
import { Job } from '@jobs/entities/job.entity';
import { User } from '@users/entities/user.entity';
import { ArtisanProfile } from '@users/entities/artisan-profile.entity';
import { AdminAuditModule } from '../admin-audit/admin-audit.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Payment, Job, User, ArtisanProfile]),
    // AT5: admin refunds and fraud flags each write an audit row.
    AdminAuditModule,
  ],
  controllers: [PaymentsController],
  providers: [PaymentsService, PaystackService],
  exports: [PaymentsService],
})
export class PaymentsModule {}

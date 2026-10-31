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
import { ThrottlingModule } from '@common/throttling/throttling.module';
import { AccountSecurityModule } from '../account-security/account-security.module';
import {
  CustomerAnalyticsThrottlerGuard,
  CustomerExportThrottlerGuard,
} from '@common/throttling/customer-throttler.guards';
import { CustomerPaymentHistoryService } from './customer-payment-history.service';
import { PaymentHistoryThrottlerGuard } from './payment-history-throttler.guard';

@Module({
  imports: [
    TypeOrmModule.forFeature([Payment, Job, User, ArtisanProfile]),
    // AT5: admin refunds and fraud flags each write an audit row.
    AdminAuditModule,
    // Customer experience v2: B3/B3f/B10 rate limits and the export audit.
    ThrottlingModule,
    AccountSecurityModule,
  ],
  controllers: [PaymentsController],
  providers: [
    PaymentsService,
    PaystackService,
    CustomerPaymentHistoryService,
    PaymentHistoryThrottlerGuard,
    CustomerAnalyticsThrottlerGuard,
    CustomerExportThrottlerGuard,
  ],
  exports: [PaymentsService],
})
export class PaymentsModule {}

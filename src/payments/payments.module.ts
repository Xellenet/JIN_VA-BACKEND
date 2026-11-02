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
  PaymentChargeStatusThrottlerGuard,
  PaymentChargeThrottlerGuard,
} from '@common/throttling/customer-throttler.guards';
import { CustomerPaymentHistoryService } from './customer-payment-history.service';
import { PaymentHistoryThrottlerGuard } from './payment-history-throttler.guard';
import {
  ArtisanExportThrottlerGuard,
  ArtisanInsightsThrottlerGuard,
  PayoutAccountLookupThrottlerGuard,
} from '@common/throttling/artisan-throttler.guards';
import { ArtisanEarningsService } from './artisan-earnings.service';
import { BankListService } from './bank-list';
import { PayoutAccountService } from './payout-account.service';
import { PaymentCharge } from './entities/payment-charge.entity';
import { SavedMethodChargeService } from './saved-method-charge.service';
import { PaymentMethodsModule } from '../payment-methods/payment-methods.module';
import { FieldEncryptionModule } from '@common/crypto/field-encryption.module';
import { IdempotencyModule } from '@common/idempotency/idempotency.module';
import { PaymentAttemptsService } from './payment-attempts.service';
import { DuplicateRefundService } from './duplicate-refund.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Payment,
      PaymentCharge,
      Job,
      User,
      ArtisanProfile,
    ]),
    // Saved payment methods: the customer's methods and the shared cipher.
    PaymentMethodsModule,
    FieldEncryptionModule,
    // Idempotent payments: Idempotency-Key on the payment POSTs.
    IdempotencyModule,
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
    // Artisan fixes: B2 statement/CSV and B6 bank list.
    ArtisanEarningsService,
    BankListService,
    ArtisanInsightsThrottlerGuard,
    ArtisanExportThrottlerGuard,
    // Payout account name lookup.
    PayoutAccountService,
    PayoutAccountLookupThrottlerGuard,
    // Saved payment methods: paying with one.
    SavedMethodChargeService,
    // Idempotent payments: one active attempt per job; duplicate refunds.
    PaymentAttemptsService,
    DuplicateRefundService,
    PaymentChargeThrottlerGuard,
    PaymentChargeStatusThrottlerGuard,
  ],
  exports: [PaymentsService, DuplicateRefundService],
})
export class PaymentsModule {}

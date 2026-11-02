import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from '@users/entities/user.entity';
import { ThrottlingModule } from '@common/throttling/throttling.module';
import { FieldEncryptionModule } from '@common/crypto/field-encryption.module';
import {
  CustomerAnalyticsThrottlerGuard,
  PaymentMethodLookupThrottlerGuard,
  PaymentMethodsWriteThrottlerGuard,
} from '@common/throttling/customer-throttler.guards';
import { AccountSecurityModule } from '../account-security/account-security.module';
import { PaystackService } from '../payments/paystack.service';
import { CustomerPaymentMethod } from './entities/customer-payment-method.entity';
import { PaymentMethodsController } from './payment-methods.controller';
import { PaymentMethodsService } from './payment-methods.service';

/**
 * Customers' saved payment methods. Imported by `PaymentsModule` (which
 * charges them and saves cards from the webhook); `AppModule` is not edited.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([CustomerPaymentMethod, User]),
    ThrottlingModule,
    AccountSecurityModule,
    FieldEncryptionModule,
  ],
  controllers: [PaymentMethodsController],
  providers: [
    PaymentMethodsService,
    PaystackService,
    CustomerAnalyticsThrottlerGuard,
    PaymentMethodLookupThrottlerGuard,
    PaymentMethodsWriteThrottlerGuard,
  ],
  exports: [PaymentMethodsService],
})
export class PaymentMethodsModule {}

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from '@users/entities/user.entity';
import { ThrottlingModule } from '@common/throttling/throttling.module';
import { PaymentSettingsWriteThrottlerGuard } from '@common/throttling/customer-throttler.guards';
import { AccountSecurityModule } from '../account-security/account-security.module';
import { CustomerPaymentSettings } from './entities/customer-payment-settings.entity';
import { PaymentSettingsController } from './payment-settings.controller';
import { PaymentSettingsService } from './payment-settings.service';

/**
 * Customer Experience v2 (B5). Registered through `UsersModule`;
 * `AppModule` is not edited.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([CustomerPaymentSettings, User]),
    ThrottlingModule,
    AccountSecurityModule,
  ],
  controllers: [PaymentSettingsController],
  providers: [PaymentSettingsService, PaymentSettingsWriteThrottlerGuard],
  exports: [PaymentSettingsService],
})
export class PaymentSettingsModule {}

import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PaymentDataEncryptionService } from './payment-data-encryption.service';

/** One shared instance, so the "not configured" warning is logged once. */
@Module({
  imports: [ConfigModule],
  providers: [PaymentDataEncryptionService],
  exports: [PaymentDataEncryptionService],
})
export class FieldEncryptionModule {}

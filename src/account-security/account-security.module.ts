import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AccountSecurityEvent } from './entities/account-security-event.entity';
import { AccountSecurityService } from './account-security.service';

/**
 * Customer Experience v2: the append-only `account_security_events` log and
 * its 12-month retention cron. Reached through `UsersModule`,
 * `PaymentSettingsModule` and `PaymentsModule`; `AppModule` is not edited.
 */
@Module({
  imports: [TypeOrmModule.forFeature([AccountSecurityEvent])],
  providers: [AccountSecurityService],
  exports: [AccountSecurityService],
})
export class AccountSecurityModule {}

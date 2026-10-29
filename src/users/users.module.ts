import { Module } from '@nestjs/common';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from './entities/user.entity';
import { Address } from './entities/address.entity';
import { UserToken } from './entities/user-token.entity';
import { UserTokenService } from './token.service';
import { ArtisanProfile } from './entities/artisan-profile.entity';
import { CustomerProfile } from './entities/customer-profile.entity';
import { ServiceEntity } from '@services/entities/service.entity';
import { UploadsModule } from '../uploads/uploads.module';
import { Booking } from '../bookings/entities/booking.entity';
import { Job } from '@jobs/entities/job.entity';
import { Payment } from '../payments/entities/payment.entity';
import { Dispute } from '../disputes/entities/dispute.entity';
import { AccountCommitmentsService } from './account-commitments.service';
import { AccountPurgeService } from './account-purge.service';
import { ArtisanVerification } from '../verification/entities/artisan-verification.entity';
import { DeviceToken } from '../push-notifications/entities/device-token.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      User,
      Address,
      UserToken,
      ArtisanProfile,
      CustomerProfile,
      ServiceEntity,
      // C1.1: read-only, count-only access for the pre-deletion live
      // -commitment guard. Deliberately the entities and not the owning
      // modules — this adds no module-level coupling and no behaviour from
      // bookings/jobs/payments/disputes leaks into users.
      Booking,
      Job,
      Payment,
      Dispute,
      // C1.7: the purge scrubs the KYC identity data hanging off the artisan
      // profile. Registered here so `autoLoadEntities` sees it from this
      // module rather than only from `AdminModule`.
      ArtisanVerification,
      // M3: the purge also deletes the account's registered push devices.
      // Registered here for the same reason as `ArtisanVerification` — this
      // module's own use of the entity should not depend on
      // `PushNotificationsModule` happening to register it.
      DeviceToken,
    ]),
    UploadsModule,
  ],
  controllers: [UsersController],
  providers: [
    UsersService,
    UserTokenService,
    AccountCommitmentsService,
    AccountPurgeService,
  ],
  exports: [
    UsersService,
    UserTokenService,
    AccountCommitmentsService,
    // C1.7: consumed by `SchedulerModule`'s daily purge cron.
    AccountPurgeService,
  ],
})
export class UsersModule {}

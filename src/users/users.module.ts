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

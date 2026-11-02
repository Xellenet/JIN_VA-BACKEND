import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JobsService } from './jobs.service';
import { JobsController } from './jobs.controller';
import { Job } from './entities/job.entity';
import { JobApplication } from './entities/job-application.entity';
import { JobStatusHistory } from './entities/job-status-history.entity';
import { JobAttachment } from './entities/job-attachment.entity';
import { ServiceEntity } from '@services/entities/service.entity';
import { User } from '@users/entities/user.entity';
import { PaymentsModule } from '../payments/payments.module';
import { ThrottlingModule } from '@common/throttling/throttling.module';
import { CustomerAnalyticsThrottlerGuard } from '@common/throttling/customer-throttler.guards';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Job,
      JobApplication,
      JobStatusHistory,
      JobAttachment,
      ServiceEntity,
      User,
    ]),
    PaymentsModule,
    // B7a: `GET /jobs/mine/summary` is rate limited per user.
    ThrottlingModule,
  ],
  controllers: [JobsController],
  providers: [JobsService, CustomerAnalyticsThrottlerGuard],
  exports: [JobsService],
})
export class JobsModule {}

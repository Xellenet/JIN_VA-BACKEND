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
  ],
  controllers: [JobsController],
  providers: [JobsService],
  exports: [JobsService],
})
export class JobsModule {}

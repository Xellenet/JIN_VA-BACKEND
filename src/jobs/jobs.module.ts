import { Module } from '@nestjs/common';
import { JobsService } from './jobs.service';
import { JobsController } from './jobs.controller';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Job } from './entities/job.entity';
import { ServiceEntity } from '@services/entities/service.entity';
import { User } from '@users/entities/user.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Job, ServiceEntity, User])],
  controllers: [JobsController],
  providers: [JobsService],
})
export class JobsModule {}

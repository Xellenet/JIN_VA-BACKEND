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

@Module({
  imports:[
    TypeOrmModule.forFeature([User, Address, UserToken, ArtisanProfile, CustomerProfile, ServiceEntity]),
    UploadsModule,
  ],
  controllers: [UsersController],
  providers: [UsersService, UserTokenService],
  exports: [UsersService, UserTokenService],
})
export class UsersModule {}

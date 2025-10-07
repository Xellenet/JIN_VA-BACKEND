import { Module } from '@nestjs/common';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from './entities/user.entity';
import { Address } from './entities/address.entity';
import { UserToken } from './entities/user-token.entity';
import { UserTokenService } from './token.service';

@Module({
  imports:[
    TypeOrmModule.forFeature([User, Address, UserToken])
  ],
  controllers: [UsersController],
  providers: [UsersService, UserTokenService],
  exports: [UsersService, UserTokenService],
})
export class UsersModule {}

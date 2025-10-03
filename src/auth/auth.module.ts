import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { UsersModule } from '@users/users.module';
import { JwtStrategy } from 'strategies/jwt.strategy';
import { readFileSync } from 'fs';
import { join } from 'path';

@Module({
    imports:[
        UsersModule,
        PassportModule,
        JwtModule.register({
        privateKey: readFileSync(join(__dirname, '../../../keys/private.key')),
        publicKey: readFileSync(join(__dirname, '../../../keys/public.key')),
        signOptions: {
            algorithm: 'RS256',
        },
        }),

    ],
    controllers: [AuthController],
    providers: [AuthService, JwtStrategy],
    exports: [AuthService, JwtModule],
})
export class AuthModule {}
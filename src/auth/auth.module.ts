import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { UsersModule } from '@users/users.module';
import { JwtStrategy } from 'strategies/jwt.strategy';

@Module({
    imports:[
        UsersModule,
        PassportModule,
        JwtModule.registerAsync({
        useFactory: () => ({
            secret: process.env.JWT_SECRET || "mySecret",
            signOptions: { expiresIn: process.env.JWT_EXPIRES_IN || '1h' }
        }),
        })

    ],
    controllers: [AuthController],
    providers: [AuthService, JwtStrategy],
    exports: [AuthService, JwtModule],
})
export class AuthModule {}

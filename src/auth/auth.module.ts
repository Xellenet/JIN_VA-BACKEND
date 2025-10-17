import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { UsersModule } from '@users/users.module';
import { JwtStrategy } from 'strategies/jwt.strategy';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MailModule } from 'mail/mail.module';
import { HttpModule } from '@nestjs/axios';
import { SocialAuthStrategyFactory } from './social-auth.factory';
import { GoogleAuthStrategy } from './strategy/google-auth.strategy';
import { OAuthStateService } from './oauth-state.service';

@Module({
    imports:[
        UsersModule,
        MailModule,
        PassportModule,
        JwtModule.register({
        privateKey: readFileSync(join(__dirname, '../../../keys/private.key')),
        publicKey: readFileSync(join(__dirname, '../../../keys/public.key')),
        signOptions: {
            algorithm: 'RS256',
        },
        }),
        HttpModule
    ],
    controllers: [AuthController],
    providers: [
        AuthService, 
        JwtStrategy,
        OAuthStateService,
        SocialAuthStrategyFactory,
        GoogleAuthStrategy,

    ],
    exports: [
        AuthService, 
        JwtModule, 
        SocialAuthStrategyFactory, 
        OAuthStateService
    ],
})
export class AuthModule {}
import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { UsersModule } from '@users/users.module';
import { JwtStrategy } from 'auth/strategy/jwt.strategy';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { MailModule } from 'mail/mail.module';
import { HttpModule } from '@nestjs/axios';
import { SocialAuthStrategyFactory } from './social-auth.factory';
import { GoogleAuthStrategy } from './strategy/google-auth.strategy';
import { OAuthStateService } from './oauth-state.service';

function loadKey(envVar: string, filePath: string): string {
  if (process.env[envVar]) {
    // Render stores env vars as-is; handle both real newlines and escaped \n
    return process.env[envVar]!.replace(/\\n/g, '\n');
  }
  return readFileSync(resolve(process.cwd(), filePath), 'utf8');
}

const privateKey = loadKey('JWT_PRIVATE_KEY', 'keys/private.key');
const publicKey  = loadKey('JWT_PUBLIC_KEY',  'keys/public.key');

@Module({

    imports:[
        UsersModule,
        MailModule,
        PassportModule,

        JwtModule.register({
            global: true,
            privateKey,
            publicKey,
            
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
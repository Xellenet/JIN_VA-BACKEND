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

const privateKey = readFileSync(resolve(process.cwd(), 'keys/private.key'), 'utf8');
const publicKey = readFileSync(resolve(process.cwd(), 'keys/public.key'), 'utf8');
console.log('Private key loaded:', privateKey ? `Yes (${privateKey.length} chars)` : 'EMPTY!');
console.log('Public key loaded:', publicKey ? `Yes (${publicKey.length} chars)` : 'EMPTY!');
console.log('Private key starts with:', privateKey.substring(0, 50));  // Should show '-----BEGIN ...'
// Then use in register: privateKey, publicKey
@Module({
    
    imports:[
        UsersModule,
        MailModule,
        PassportModule,
        
        JwtModule.register({
            global: true,
            privateKey: readFileSync(resolve(process.cwd(), 'keys/private.key'), 'utf8'),
            publicKey: readFileSync(resolve(process.cwd(), 'keys/public.key'), 'utf8'),
            
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
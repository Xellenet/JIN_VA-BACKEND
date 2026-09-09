import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { UsersModule } from '@users/users.module';
import { JwtStrategy } from './strategy/jwt.strategy';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MailModule } from 'mail/mail.module';
import { HttpModule } from '@nestjs/axios';
import { SocialAuthStrategyFactory } from './social-auth.factory';
import { GoogleAuthStrategy } from './strategy/google-auth.strategy';
import { OAuthStateService } from './oauth-state.service';
import { ThrottlingModule } from '@common/throttling/throttling.module';
import {
  AuthCredentialsThrottlerGuard,
  AuthEmailThrottlerGuard,
} from './guards/auth-throttler.guard';

function loadKey(envVar: string, filePath: string): string {
  if (process.env[envVar]) {
    // Render stores env vars as-is; handle both real newlines and escaped \n
    return process.env[envVar].replace(/\\n/g, '\n');
  }
  return readFileSync(resolve(process.cwd(), filePath), 'utf8');
}

const privateKey = loadKey('JWT_PRIVATE_KEY', 'keys/private.key');
const publicKey = loadKey('JWT_PUBLIC_KEY', 'keys/public.key');

@Module({
  imports: [
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
    HttpModule,
    /**
     * Rate limiting for the credential-guessing / account-enumeration surface
     * of this controller (`login`, `restore-account`, `register`,
     * `forgot-password`, `reset-password`, `verify-email`,
     * `resend-verification`, `change-password`). Opt-in per route via
     * `@UseGuards(...)` — importing this module throttles nothing by itself.
     */
    ThrottlingModule,
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    JwtStrategy,
    OAuthStateService,
    SocialAuthStrategyFactory,
    GoogleAuthStrategy,
    // Registered as providers (not merely referenced by `@UseGuards`) so Nest
    // owns their lifecycle and calls `onModuleInit`, which is what binds each
    // guard to its named throttler.
    AuthCredentialsThrottlerGuard,
    AuthEmailThrottlerGuard,
  ],
  exports: [
    AuthService,
    JwtModule,
    SocialAuthStrategyFactory,
    OAuthStateService,
  ],
})
export class AuthModule {}

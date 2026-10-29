import { Injectable, UnauthorizedException } from '@nestjs/common';
import { AccountBannedException } from '@common/exceptions/account-banned.exception';
import { PassportStrategy } from '@nestjs/passport';
import { UsersService } from '@users/users.service';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  isAccessTokenPayload,
  type JwtPayload,
} from '@common/types/jwt-payload.type';

function loadPublicKey(): string {
  if (process.env.JWT_PUBLIC_KEY) {
    return process.env.JWT_PUBLIC_KEY.replace(/\\n/g, '\n');
  }
  return readFileSync(resolve(process.cwd(), 'keys/public.key'), 'utf8');
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(private readonly userService: UsersService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey: loadPublicKey(),
      algorithms: ['RS256'],
      ignoreExpiration: false,
    });
  }

  async validate(payload: JwtPayload) {
    // Only access tokens authenticate requests; a refresh token lives for
    // days and must only ever be redeemed at /auth/refresh-token.
    if (!isAccessTokenPayload(payload)) {
      throw new UnauthorizedException();
    }
    const user = await this.userService.findUserByEmail(payload.email);
    if (user?.isBanned) {
      throw new AccountBannedException();
    }
    return user;
  }
}

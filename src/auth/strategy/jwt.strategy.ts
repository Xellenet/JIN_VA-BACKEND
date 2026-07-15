import { Injectable, UnauthorizedException } from "@nestjs/common";
import { PassportStrategy } from "@nestjs/passport";
import { UsersService } from "@users/users.service";
import { ExtractJwt, Strategy } from "passport-jwt";
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function loadPublicKey(): string {
  if (process.env.JWT_PUBLIC_KEY) {
    return process.env.JWT_PUBLIC_KEY.replace(/\\n/g, '\n');
  }
  return readFileSync(resolve(process.cwd(), 'keys/public.key'), 'utf8');
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy){
    constructor(private readonly userService: UsersService) {
      super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey: loadPublicKey(),
      algorithms: ['RS256'],
      ignoreExpiration: false,
    });
  }

    async validate(payload: any) {
      const user = await this.userService.findUserByEmail(payload.email);
      if (user?.isBanned) {
        throw new UnauthorizedException('Your account has been suspended. Contact support for assistance.');
      }
      return user;
    }
}
import { Injectable } from "@nestjs/common";
import { PassportStrategy } from "@nestjs/passport";
import { UsersService } from "@users/users.service";
import { ExtractJwt, Strategy } from "passport-jwt";
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';


@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy){
    constructor(private readonly userService: UsersService) {
      super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey: readFileSync(resolve(process.cwd(), 'keys/public.key'), 'utf8'),
      algorithms: ['RS256'],
      ignoreExpiration: false,
    });
  }

    async validate(payload: any) {
      const user = await this.userService.findUserByEmail(payload.email);
      return user;
    }
}
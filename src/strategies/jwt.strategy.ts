import { Injectable } from "@nestjs/common";
import { PassportStrategy } from "@nestjs/passport";
import { UsersService } from "@users/users.service";
import { ExtractJwt, Strategy } from "passport-jwt";
import { readFileSync } from 'fs';
import { join } from 'path';


@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy){
    constructor(private readonly userService: UsersService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey: readFileSync(join(__dirname, '../../../keys/public.key')),
      algorithms: ['RS256'],
    });
  }

    async validate(payload: any) {
      const user = await this.userService.findUserByEmail(payload.email);
      return user;
    }
}
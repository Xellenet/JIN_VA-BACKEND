import { Injectable } from "@nestjs/common";
import { PassportStrategy } from "@nestjs/passport";
import { UsersService } from "@users/users.service";
import { ExtractJwt, Strategy } from "passport-jwt";


@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy){
    constructor(private readonly userService: UsersService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: process.env.JWT_SECRET || 'supersecretkey',
    });
  }

    async validate(payload: any) {
      const user = await this.userService.findUserByEmail(payload.email);
      return user;
    }
}
import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

/**
 * Like {@link JwtAuthGuard}, but never rejects the request when no/invalid
 * credentials are supplied — `req.user` is simply left unset. Used on public
 * endpoints whose response shape legitimately differs for an authenticated
 * caller (e.g. `GET /portfolio/:artisanId`, PF3: the owning artisan sees all
 * statuses, everyone else only sees APPROVED items).
 */
@Injectable()
export class OptionalJwtAuthGuard extends AuthGuard('jwt') {
  handleRequest<TUser = any>(_err: unknown, user: TUser): TUser {
    return user;
  }
}

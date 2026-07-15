import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role } from '@common/types/enums';
import { ROLES_KEY } from '@common/decorators/roles.decorator';

/**
 * Guard that enforces role-based access control (RBAC) on route handlers.
 *
 * Must be composed with {@link JwtAuthGuard} so that `req.user` is already
 * populated when this guard runs. Apply both in order:
 * `@UseGuards(JwtAuthGuard, RolesGuard)`.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  /**
   * Determines whether the current request is permitted to proceed.
   * Reads the {@link ROLES_KEY} metadata set by the {@link Roles} decorator on
   * the handler and its class. If no roles are required, access is granted.
   *
   * @param context - The NestJS execution context providing HTTP request details.
   * @returns `true` when no roles are required or the user holds a required role.
   * @throws {ForbiddenException} When the authenticated user does not hold any of
   *   the required roles.
   */
  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const { user } = context.switchToHttp().getRequest();

    if (!requiredRoles.some((role) => user?.role === role)) {
      throw new ForbiddenException(
        `Access denied. Required role(s): ${requiredRoles.join(', ')}.`,
      );
    }

    return true;
  }
}

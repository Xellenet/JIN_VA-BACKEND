import { SetMetadata } from '@nestjs/common';
import { Role } from '@common/types/enums';

export const ROLES_KEY = 'roles';

/**
 * Assigns required roles to a route handler or controller class.
 * Works in conjunction with {@link RolesGuard} to enforce role-based access.
 *
 * @param roles - One or more {@link Role} values required to access the decorated target.
 * @example
 * @Roles(Role.ADMIN)
 * @Get('admin-only')
 * adminRoute() { ... }
 */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);

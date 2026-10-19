import { Injectable, SetMetadata, type CanActivate, type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { AdminRole } from "@classhub/db";

import { AdminRoleInsufficientException } from "./admin-auth.errors.js";
import {
  getAuthenticatedAdminSession,
  type AuthenticatedAdminRequest,
} from "./admin-auth.request.js";

const REQUIRED_ADMIN_ROLES = "classhub:required-admin-roles";

export const RequireAdminRoles = (...roles: AdminRole[]): MethodDecorator & ClassDecorator =>
  SetMetadata(REQUIRED_ADMIN_ROLES, roles);

@Injectable()
export class AdminRolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<AdminRole[]>(REQUIRED_ADMIN_ROLES, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (required === undefined || required.length === 0) return true;
    const request = context.switchToHttp().getRequest<AuthenticatedAdminRequest>();
    const session = getAuthenticatedAdminSession(request);
    if (!required.some((role) => session.roles.includes(role))) {
      throw new AdminRoleInsufficientException();
    }
    return true;
  }
}

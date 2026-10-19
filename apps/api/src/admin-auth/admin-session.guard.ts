import { Injectable, type CanActivate, type ExecutionContext } from "@nestjs/common";

import { ADMIN_SESSION_COOKIE_NAME, readAdminCookie } from "./admin-auth.cookies.js";
import { adminRequestMetadata, type AuthenticatedAdminRequest } from "./admin-auth.request.js";
import { AdminAuthService } from "./admin-auth.service.js";

@Injectable()
export class AdminSessionGuard implements CanActivate {
  constructor(private readonly adminAuthService: AdminAuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedAdminRequest>();
    request.authenticatedAdminSession = await this.adminAuthService.authenticate(
      readAdminCookie(request.headers.cookie, ADMIN_SESSION_COOKIE_NAME),
      adminRequestMetadata(request),
    );
    return true;
  }
}

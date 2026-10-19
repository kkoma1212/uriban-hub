import { timingSafeEqual } from "node:crypto";

import { Injectable, type CanActivate, type ExecutionContext } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

import { CsrfInvalidException, OriginNotAllowedException } from "../auth/auth.errors.js";
import { hashSessionSecret, isSessionSecret } from "../auth/session-crypto.js";
import type { AppEnvironment } from "../config/environment.js";
import {
  ADMIN_CSRF_COOKIE_NAME,
  ADMIN_SESSION_COOKIE_NAME,
  readAdminCookie,
} from "./admin-auth.cookies.js";
import { adminRequestMetadata, type AuthenticatedAdminRequest } from "./admin-auth.request.js";
import { AdminAuthService } from "./admin-auth.service.js";

@Injectable()
export class AdminCsrfGuard implements CanActivate {
  constructor(
    private readonly adminAuthService: AdminAuthService,
    private readonly config: ConfigService<AppEnvironment, true>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedAdminRequest>();
    const expectedOrigin = new URL(this.config.get("PUBLIC_APP_ORIGIN", { infer: true })).origin;
    if (request.headers.origin !== expectedOrigin) throw new OriginNotAllowedException();

    const session = await this.adminAuthService.authenticate(
      readAdminCookie(request.headers.cookie, ADMIN_SESSION_COOKIE_NAME),
      adminRequestMetadata(request),
    );
    const cookieToken = readAdminCookie(request.headers.cookie, ADMIN_CSRF_COOKIE_NAME);
    const headerToken = request.headers["x-admin-csrf"];
    if (
      !isSessionSecret(cookieToken) ||
      typeof headerToken !== "string" ||
      !isSessionSecret(headerToken) ||
      !timingSafeEqual(session.csrfTokenHash, hashSessionSecret(cookieToken)) ||
      !timingSafeEqual(session.csrfTokenHash, hashSessionSecret(headerToken))
    ) {
      throw new CsrfInvalidException();
    }

    request.authenticatedAdminSession = session;
    return true;
  }
}

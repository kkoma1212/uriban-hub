import { Injectable, type CanActivate, type ExecutionContext } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Reflector } from "@nestjs/core";

import type { AppEnvironment } from "../config/environment.js";
import { ALLOW_UNVERIFIED_EMAIL } from "./allow-unverified-email.decorator.js";
import { OriginNotAllowedException } from "./auth.errors.js";
import {
  attachSecurityAuditIdentity,
  type AuthenticatedFastifyRequest,
} from "./authenticated-request.js";
import { CSRF_COOKIE_NAME, readCookie, SESSION_COOKIE_NAME } from "./session-cookie.js";
import { SessionService } from "./session.service.js";

@Injectable()
export class AuthenticatedCsrfGuard implements CanActivate {
  constructor(
    private readonly config: ConfigService<AppEnvironment, true>,
    private readonly reflector: Reflector,
    private readonly sessionService: SessionService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedFastifyRequest>();
    const allowUnverifiedEmail =
      this.reflector.getAllAndOverride<boolean>(ALLOW_UNVERIFIED_EMAIL, [
        context.getHandler(),
        context.getClass(),
      ]) === true;
    const expectedOrigin = new URL(this.config.get("PUBLIC_APP_ORIGIN", { infer: true })).origin;
    if (request.headers.origin !== expectedOrigin) {
      throw new OriginNotAllowedException();
    }

    const rawSessionToken = readCookie(request.headers.cookie, SESSION_COOKIE_NAME);
    const csrfHeader = request.headers["x-csrf-token"];
    request.authenticatedSession = await this.sessionService.authenticateWithCsrf(
      rawSessionToken,
      readCookie(request.headers.cookie, CSRF_COOKIE_NAME),
      typeof csrfHeader === "string" ? csrfHeader : undefined,
      {
        allowUnverifiedEmail,
        onSecurityAuditIdentity: (identity) => attachSecurityAuditIdentity(request, identity),
      },
    );
    return true;
  }
}

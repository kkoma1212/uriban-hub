import { Injectable, type CanActivate, type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";

import { ALLOW_UNVERIFIED_EMAIL } from "./allow-unverified-email.decorator.js";
import {
  attachSecurityAuditIdentity,
  type AuthenticatedFastifyRequest,
} from "./authenticated-request.js";
import { readCookie, SESSION_COOKIE_NAME } from "./session-cookie.js";
import { SessionService } from "./session.service.js";

@Injectable()
export class AuthenticatedSessionGuard implements CanActivate {
  constructor(
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

    request.authenticatedSession = await this.sessionService.authenticate(
      readCookie(request.headers.cookie, SESSION_COOKIE_NAME),
      {
        allowUnverifiedEmail,
        onSecurityAuditIdentity: (identity) => attachSecurityAuditIdentity(request, identity),
      },
    );
    return true;
  }
}

import { Injectable, type CanActivate, type ExecutionContext } from "@nestjs/common";

import {
  AdminSessionRequiredException,
  AdminStepUpRequiredException,
} from "./admin-auth.errors.js";
import { ADMIN_STEP_UP_LIFETIME_MS } from "./admin-auth.types.js";
import {
  getAuthenticatedAdminSession,
  type AuthenticatedAdminRequest,
} from "./admin-auth.request.js";

@Injectable()
export class AdminStepUpGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthenticatedAdminRequest>();
    const session = getAuthenticatedAdminSession(request);
    const now = Date.now();
    if (
      !Number.isFinite(session.mfaVerifiedAt.getTime()) ||
      session.mfaVerifiedAt.getTime() < session.issuedAt.getTime() ||
      session.mfaVerifiedAt.getTime() > now ||
      !Number.isFinite(session.issuedAt.getTime()) ||
      !Number.isFinite(session.absoluteExpiresAt.getTime()) ||
      session.absoluteExpiresAt.getTime() <= now
    ) {
      throw new AdminSessionRequiredException();
    }
    const verifiedAt = session.reauthenticatedAt?.getTime();
    if (
      verifiedAt === undefined ||
      !Number.isFinite(verifiedAt) ||
      verifiedAt <= session.mfaVerifiedAt.getTime() ||
      verifiedAt > now ||
      now - verifiedAt >= ADMIN_STEP_UP_LIFETIME_MS
    ) {
      throw new AdminStepUpRequiredException();
    }
    return true;
  }
}

import type { FastifyRequest } from "fastify";

import type { AuthenticatedSession, SecurityAuditSessionIdentity } from "./auth.types.js";
import { UnauthenticatedException } from "./auth.errors.js";

export type AuthenticatedFastifyRequest = FastifyRequest & {
  authenticatedSession?: AuthenticatedSession;
  securityAuditIdentity?: SecurityAuditSessionIdentity;
};

export function attachSecurityAuditIdentity(
  request: AuthenticatedFastifyRequest,
  identity: SecurityAuditSessionIdentity,
): void {
  request.securityAuditIdentity = {
    currentClassId: identity.currentClassId,
    userId: identity.userId,
  };
}

export function getAuthenticatedSession(
  request: AuthenticatedFastifyRequest,
): AuthenticatedSession {
  if (request.authenticatedSession === undefined) throw new UnauthenticatedException();
  return request.authenticatedSession;
}

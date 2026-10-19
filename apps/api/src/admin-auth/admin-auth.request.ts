import type { FastifyRequest } from "fastify";

import type { AdminRequestMetadata, AuthenticatedAdminSession } from "./admin-auth.types.js";
import { AdminSessionRequiredException } from "./admin-auth.errors.js";

export type AuthenticatedAdminRequest = FastifyRequest & {
  authenticatedAdminSession?: AuthenticatedAdminSession;
};

export function adminRequestMetadata(request: FastifyRequest): AdminRequestMetadata {
  return {
    clientIp: request.ip,
    requestId: request.id,
    userAgent: request.headers["user-agent"],
  };
}

export function getAuthenticatedAdminSession(
  request: AuthenticatedAdminRequest,
): AuthenticatedAdminSession {
  if (request.authenticatedAdminSession === undefined) {
    throw new AdminSessionRequiredException();
  }
  return request.authenticatedAdminSession;
}

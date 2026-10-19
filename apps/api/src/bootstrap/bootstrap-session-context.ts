import { createHmac } from "node:crypto";

import type { AuthenticatedSession } from "../auth/auth.types.js";
import { UnauthenticatedException } from "../auth/auth.errors.js";
import { isSessionSecret } from "../auth/session-crypto.js";

/** A public comparison value, never an authentication or CSRF credential. */
export function bootstrapSessionContext(
  session: AuthenticatedSession,
  rawSessionToken: string | undefined,
): string {
  if (!isSessionSecret(rawSessionToken)) throw new UnauthenticatedException();
  const context = createHmac("sha256", rawSessionToken)
    .update(JSON.stringify(["classhub:bootstrap-session:v1", session.userId, session.sessionId]))
    .digest("base64url");
  // The prefix also makes this value invalid as a raw session/CSRF credential.
  return `v1.${context}`;
}

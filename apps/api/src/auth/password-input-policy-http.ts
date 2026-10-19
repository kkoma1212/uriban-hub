import { NewPasswordRejectedException } from "./auth.errors.js";
import { evaluateNewPassword, type NewPasswordContext } from "./password-input-policy.js";

export function requireAcceptedNewPassword(
  rawPassword: string,
  context: NewPasswordContext = {},
): string {
  const result = evaluateNewPassword(rawPassword, context);
  if (!result.ok) throw new NewPasswordRejectedException(result.reason);
  return result.normalizedPassword;
}

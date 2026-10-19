import { hashVerificationToken } from "../auth-crypto.js";
import { InvalidGuardianConsentException, TokenInvalidOrExpiredException } from "../auth.errors.js";
import type { AuthConfig, GuardianConsentReference } from "../auth.types.js";
import {
  sameLegalConsentSnapshot,
  type LegalConsentSnapshot,
} from "../../legal/legal-consent-snapshot.js";
import type { DB } from "@classhub/db";
import type { RawBuilder, Transaction } from "kysely";
import { authUpdateSucceeded } from "./auth-persistence.js";
import { ADMIN_SIGNUP_APPROVAL_MAX_ATTEMPTS } from "../../admin-signup-approval/admin-signup-approval.policy.js";

type SignupApprovalDenialCode =
  | "approval_not_found"
  | "approval_revoked"
  | "approval_consumed"
  | "approval_expired"
  | "approval_attempts_exhausted"
  | "approval_code_mismatch"
  | "approval_state_changed"
  | "email_unavailable";

type LockedSignupApproval =
  | { id: string; issuedByAdminAccountId: string | null; kind: "approved" }
  | { approvalId: string | null; kind: "denied"; resultCode: SignupApprovalDenialCode };

export async function closeApprovedGuardianConsentAttempt(
  transaction: Transaction<DB>,
  reference: GuardianConsentReference,
  now: RawBuilder<Date>,
): Promise<void> {
  await transaction
    .updateTable("guardian_consent_requests")
    .set({ completion_token_hash: null, invalidated_at: now })
    .where("id", "=", reference.request_id)
    .where("completion_token_hash", "=", hashVerificationToken(reference.completion_token))
    .where("approved_at", "is not", null)
    .where("consumed_at", "is", null)
    .where("invalidated_at", "is", null)
    .where("expires_at", ">", now)
    .execute();
}

export async function lockSignupApproval(
  transaction: Transaction<DB>,
  emailDigest: Buffer,
  codeDigest: Buffer,
  role: "student" | "teacher",
  now: Date,
  mariaDb: boolean,
): Promise<LockedSignupApproval> {
  const exact = await transaction
    .selectFrom("admin_signup_approvals")
    .select([
      "consumed_at",
      "expires_at",
      "failed_attempts",
      "id",
      "issued_by_admin_account_id",
      "revoked_at",
    ])
    .where("code_digest", "=", codeDigest)
    .where("email_key_digest", "=", emailDigest)
    .where("role", "=", role)
    .forUpdate()
    .executeTakeFirst();

  if (exact !== undefined) {
    if (exact.revoked_at !== null) {
      return { approvalId: exact.id, kind: "denied", resultCode: "approval_revoked" };
    }
    if (exact.consumed_at !== null) {
      return { approvalId: exact.id, kind: "denied", resultCode: "approval_consumed" };
    }
    if (exact.expires_at.getTime() <= now.getTime()) {
      return { approvalId: exact.id, kind: "denied", resultCode: "approval_expired" };
    }
    if (exact.failed_attempts >= ADMIN_SIGNUP_APPROVAL_MAX_ATTEMPTS) {
      return { approvalId: exact.id, kind: "denied", resultCode: "approval_attempts_exhausted" };
    }
    return {
      id: exact.id,
      issuedByAdminAccountId: exact.issued_by_admin_account_id,
      kind: "approved",
    };
  }

  const current = await transaction
    .selectFrom("admin_signup_approvals")
    .select(["expires_at", "failed_attempts", "id"])
    .where("email_key_digest", "=", emailDigest)
    .where("role", "=", role)
    .where("consumed_at", "is", null)
    .where("revoked_at", "is", null)
    .forUpdate()
    .executeTakeFirst();

  if (current === undefined) {
    return { approvalId: null, kind: "denied", resultCode: "approval_not_found" };
  }
  if (current.expires_at.getTime() <= now.getTime()) {
    return { approvalId: current.id, kind: "denied", resultCode: "approval_expired" };
  }
  if (current.failed_attempts >= ADMIN_SIGNUP_APPROVAL_MAX_ATTEMPTS) {
    return { approvalId: current.id, kind: "denied", resultCode: "approval_attempts_exhausted" };
  }

  const attemptQuery = transaction
    .updateTable("admin_signup_approvals")
    .set({ failed_attempts: current.failed_attempts + 1 })
    .where("id", "=", current.id)
    .where("failed_attempts", "=", current.failed_attempts)
    .where("consumed_at", "is", null)
    .where("revoked_at", "is", null);
  const attempted = mariaDb
    ? authUpdateSucceeded(await attemptQuery.executeTakeFirstOrThrow())
    : (await attemptQuery.returning("id").executeTakeFirst()) !== undefined;
  return !attempted
    ? { approvalId: current.id, kind: "denied", resultCode: "approval_state_changed" }
    : { approvalId: current.id, kind: "denied", resultCode: "approval_code_mismatch" };
}

export async function recordSignupApprovalEvent(
  transaction: Transaction<DB>,
  event: {
    approvalId: string | null;
    requestId: string;
    resultCode: SignupApprovalDenialCode | "approved";
    role: "student" | "teacher";
    userActorId: string | null;
  },
): Promise<void> {
  await transaction
    .insertInto("admin_signup_approval_events")
    .values({
      action: "signup",
      admin_actor_account_id: null,
      approval_id: event.approvalId,
      request_id: event.requestId,
      result_code: event.resultCode,
      role: event.role,
      user_actor_id: event.userActorId,
    })
    .execute();
}

export async function lockApprovedGuardianConsent(
  transaction: Transaction<DB>,
  reference: GuardianConsentReference,
  studentEmail: string,
  now: Date,
  config: AuthConfig,
  documentSnapshot?: LegalConsentSnapshot,
): Promise<{ completionTokenHash: Buffer; id: string }> {
  const completionTokenHash = hashVerificationToken(reference.completion_token);
  const request = await transaction
    .selectFrom("guardian_consent_requests")
    .select([
      "approved_at",
      "consumed_at",
      "expires_at",
      "guardian_email_normalized",
      "id",
      "invalidated_at",
      "privacy_policy_version",
      "terms_policy_version",
      "user_id",
    ])
    .select(documentSnapshot === undefined ? [] : ["document_snapshot"])
    .where("id", "=", reference.request_id)
    .where("completion_token_hash", "=", completionTokenHash)
    .forUpdate()
    .executeTakeFirst();

  if (
    request === undefined ||
    request.approved_at === null ||
    request.consumed_at !== null ||
    request.invalidated_at !== null ||
    request.user_id !== null ||
    request.expires_at.getTime() <= now.getTime() ||
    (documentSnapshot === undefined
      ? request.terms_policy_version !== config.termsPolicyVersion ||
        request.privacy_policy_version !== config.privacyPolicyVersion
      : !sameLegalConsentSnapshot(request.document_snapshot, documentSnapshot))
  ) {
    throw new TokenInvalidOrExpiredException();
  }

  if (request.guardian_email_normalized === studentEmail) {
    throw new InvalidGuardianConsentException();
  }

  return { completionTokenHash, id: request.id };
}

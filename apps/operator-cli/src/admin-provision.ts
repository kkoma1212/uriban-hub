import { operatorInsertedId, operatorJson } from "./operator-query.js";
import { lockOperatorTransaction } from "./operator-lock.js";
import { randomBytes, randomUUID } from "node:crypto";

import {
  hashPassword,
  isAdminRole,
  NFC_PASSWORD_INPUT_VERSION,
  type AdminRole,
} from "@classhub/db";
import { parseFragment } from "parse5";

import { authenticateOperator, lockAndRevalidateOperator } from "./operator-auth.js";
import { openOperatorDatabase } from "./operator-database.js";

const ADMIN_PROVISION_LOCK_NAME = "classhub:admin-provision";

interface HtmlNode {
  childNodes?: HtmlNode[];
  tagName?: string;
}

interface CreatedAdminResult {
  adminAccountId: string;
  created: true;
  displayName: string;
  email: string;
  rawInitialPassword: string;
  role: AdminRole;
  runId: string;
  status: "pending_mfa";
}

interface ExistingAdminResult {
  adminAccountId: string;
  created: false;
  displayName: string;
  email: string;
  rawInitialPassword: null;
  role: AdminRole;
  runId: null;
  status: "active" | "pending_mfa";
}

export type ProvisionAdminResult = CreatedAdminResult | ExistingAdminResult;

export interface ProvisionAdminInput {
  displayName: string;
  email: string;
  operatorDatabaseUrl: string | undefined;
  operatorToken: string;
  role: string;
}

function hasHtmlElement(value: string): boolean {
  const root = parseFragment(value) as unknown as HtmlNode;
  const pending = [root];
  while (pending.length > 0) {
    const node = pending.pop();
    if (node?.tagName !== undefined) return true;
    if (node?.childNodes !== undefined) pending.push(...node.childNodes);
  }
  return false;
}

export function normalizeAdminEmail(value: string): string {
  const email = value.trim().toLowerCase();
  const localPart = email.split("@")[0] ?? "";
  if (
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email) ||
    email.length > 254 ||
    Buffer.byteLength(localPart, "utf8") > 64
  ) {
    throw new Error("관리자 이메일 형식이 올바르지 않습니다.");
  }
  return email;
}

export function normalizeAdminDisplayName(value: string): string {
  const displayName = value.trim();
  const length = Array.from(displayName).length;
  if (
    length < 2 ||
    length > 40 ||
    /[\u0000-\u001F\u007F\u0085\u2028\u2029]/u.test(displayName) ||
    hasHtmlElement(displayName)
  ) {
    throw new Error("관리자 표시명은 제어문자·HTML 없는 2~40자여야 합니다.");
  }
  return displayName;
}

export function requireAdminRole(value: string): AdminRole {
  if (!isAdminRole(value)) {
    throw new Error(
      "--role은 super_admin, account_manager, support, security_auditor 중 하나여야 합니다.",
    );
  }
  return value;
}

export function generateAdminInitialPassword(): string {
  return `A1-${randomBytes(24).toString("base64url")}`;
}

export async function provisionAdmin(input: ProvisionAdminInput): Promise<ProvisionAdminResult> {
  const email = normalizeAdminEmail(input.email);
  const displayName = normalizeAdminDisplayName(input.displayName);
  const role = requireAdminRole(input.role);
  const database = await openOperatorDatabase(input.operatorDatabaseUrl);

  try {
    const authenticatedOperator = await authenticateOperator(database, input.operatorToken);

    return await database.transaction().execute(async (transaction) => {
      await lockAndRevalidateOperator(transaction, authenticatedOperator);
      await lockOperatorTransaction(transaction, ADMIN_PROVISION_LOCK_NAME);

      const existing = await transaction
        .selectFrom("admin_accounts")
        .select(["display_name", "id", "status"])
        .where("email_normalized", "=", email)
        .executeTakeFirst();

      if (existing !== undefined) {
        if (existing.status !== "active" && existing.status !== "pending_mfa") {
          throw new Error("동일 이메일의 중지 또는 폐기된 관리자 계정이 있습니다.");
        }
        const existingRole = await transaction
          .selectFrom("admin_account_roles")
          .select("role")
          .where("admin_account_id", "=", existing.id)
          .where("role", "=", role)
          .executeTakeFirst();
        if (existingRole === undefined) {
          throw new Error(
            "동일 이메일의 관리자 계정이 다른 역할로 존재합니다. 역할 변경 절차를 사용해 주세요.",
          );
        }
        return {
          adminAccountId: existing.id,
          created: false as const,
          displayName: existing.display_name,
          email,
          rawInitialPassword: null,
          role,
          runId: null,
          status: existing.status,
        };
      }

      const rawInitialPassword = generateAdminInitialPassword();
      const passwordHash = await hashPassword(rawInitialPassword);
      const runId = randomUUID();
      const insert = transaction.insertInto("admin_accounts").values({
        created_by_operator_id: authenticatedOperator.operatorId,
        display_name: displayName,
        email_normalized: email,
        password_hash: passwordHash,
        password_input_version: NFC_PASSWORD_INPUT_VERSION,
      });
      const account = { id: await operatorInsertedId(transaction, insert) };

      await transaction
        .insertInto("admin_account_roles")
        .values({
          admin_account_id: account.id,
          granted_by_operator_id: authenticatedOperator.operatorId,
          role,
        })
        .execute();
      await transaction
        .insertInto("operator_audit_logs")
        .values({
          action: "admin.created",
          actor_type: "operator",
          after_json: operatorJson(transaction, {
            admin_account_id: account.id,
            admin_account_status: "pending_mfa",
            role,
          }),
          before_json: null,
          operator_id: authenticatedOperator.operatorId,
          run_id: runId,
          target_id: account.id,
          target_type: "admin_account",
        })
        .execute();

      return {
        adminAccountId: account.id,
        created: true as const,
        displayName,
        email,
        rawInitialPassword,
        role,
        runId,
        status: "pending_mfa" as const,
      };
    });
  } finally {
    await database.destroy();
  }
}

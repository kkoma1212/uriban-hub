import { describe, expect, it } from "vitest";
import { requiredMariaDbRuntimeGrants } from "./runtime-grant-extensions.js";

// 2026-10-03 메일 발송 기록 1년 자동 삭제(총검수 I5-04): 정리 계정 묶음에 두 권한만 더한다.
describe("retention mail log grant set", () => {
  it("equals retention_v1 plus mail_delivery_logs SELECT and DELETE, sorted", () => {
    const base = requiredMariaDbRuntimeGrants("retention", "retention_v1") ?? [];
    const extended = requiredMariaDbRuntimeGrants("retention", "retention_mail_logs_v1") ?? [];
    expect(extended).toEqual(
      [...base, "table|mail_delivery_logs|DELETE|*", "table|mail_delivery_logs|SELECT|*"].sort(),
    );
    expect(base).not.toContain("table|mail_delivery_logs|DELETE|*");
  });

  it("stacks the audit/consent set on the mail set with exactly four grants (I3-01)", () => {
    const mail = requiredMariaDbRuntimeGrants("retention", "retention_mail_logs_v1") ?? [];
    const audit = requiredMariaDbRuntimeGrants("retention", "retention_audit_consents_v1") ?? [];
    expect(audit).toEqual(
      [
        ...mail,
        "table|admin_operation_audit_logs|DELETE|*",
        "table|admin_operation_audit_logs|SELECT|*",
        "table|user_consents|DELETE|*",
        "table|user_consents|SELECT|*",
      ].sort(),
    );
  });

  it("stacks the admin record set on the audit set: two contact columns, never other updates (2026-10-04)", () => {
    const audit = requiredMariaDbRuntimeGrants("retention", "retention_audit_consents_v1") ?? [];
    const admin = requiredMariaDbRuntimeGrants("retention", "retention_admin_records_v1") ?? [];
    const added = admin.filter((grant) => !audit.includes(grant));
    expect(added).toHaveLength(12);
    expect(added.filter((grant) => grant.includes("|UPDATE|"))).toEqual([
      "table|admin_signup_approvals|UPDATE|code_encrypted",
      "table|admin_signup_approvals|UPDATE|recipient_email",
    ]);
    expect(audit.every((grant) => admin.includes(grant))).toBe(true);
    expect(requiredMariaDbRuntimeGrants("app", "retention_admin_records_v1")).toBeUndefined();
  });

  it("is only available to the retention role", () => {
    expect(requiredMariaDbRuntimeGrants("app", "retention_mail_logs_v1")).toBeUndefined();
  });
});

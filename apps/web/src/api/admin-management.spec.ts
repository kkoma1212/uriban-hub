import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createAdminAccount,
  createAdminTermsVersion,
  issueAdminSignupApproval,
  listAdminAccounts,
  listAdminAuthAuditLogs,
  listAdminMembers,
  listAdminOperationAuditLogs,
  listAdminTermsConsents,
  listAdminUsers,
  replaceAdminAccountRoles,
  resetAdminAccountCredentials,
  resetAdminAccountMfa,
  updateAdminAccountStatus,
  updateAdminInquiry,
  updateAdminSystemState,
  updateAdminTermsVersionStatus,
} from "./admin-management";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
    status: 200,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("admin management API", () => {
  it.each([50, 51])("preserves user search truncation for %i matches", async (matches) => {
    const users = Array.from({ length: Math.min(matches, 50) }, (_, index) => ({
      id: String(index),
    }));
    const body = { users, truncated: matches > 50 };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse(body));
    const result = await listAdminUsers(" synthetic ");
    expect(result.users).toHaveLength(50);
    expect(result.truncated).toBe(matches > 50);
    expect(result).toEqual(body);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/v1/admin/users?search=synthetic");
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ credentials: "include" });
  });
  it("broadcasts real session expiry while keeping a step-up denial separate", async () => {
    const expired = vi.fn();
    window.addEventListener("classhub:admin-session-expired", expired);
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: { code: "ADMIN_STEP_UP_REQUIRED", message: "Verify" } }),
          { status: 401 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: { code: "ADMIN_SESSION_REQUIRED", message: "Expired" } }),
          { status: 401 },
        ),
      );
    try {
      await expect(listAdminUsers("tester")).rejects.toMatchObject({
        code: "ADMIN_STEP_UP_REQUIRED",
      });
      expect(expired).not.toHaveBeenCalled();
      await expect(listAdminUsers("tester")).rejects.toMatchObject({
        code: "ADMIN_SESSION_REQUIRED",
      });
      expect(expired).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener("classhub:admin-session-expired", expired);
    }
  });
  it("encodes required personal-data scope filters", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ members: [] }))
      .mockResolvedValueOnce(jsonResponse({ consents: [] }));

    await listAdminMembers({ search: "김 선생", status: "approved" });
    await listAdminTermsConsents({ consent_type: "terms", policy_version: "2026-09" });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "/api/v1/admin/members?search=%EA%B9%80+%EC%84%A0%EC%83%9D&status=approved",
    );
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ credentials: "include" });
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "/api/v1/admin/terms/consents?consent_type=terms&policy_version=2026-09",
    );
  });

  it("normalizes the approval expiry field and sends the isolated admin CSRF token", async () => {
    vi.spyOn(document, "cookie", "get").mockReturnValue(
      "theme=light; __Host-classhub_admin_csrf=admin-csrf-fixture",
    );
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({
        code: "123456",
        expiresAt: "2026-09-03T00:10:00.000Z",
        id: "approval-1",
      }),
    );

    await expect(
      issueAdminSignupApproval({ email: "teacher@example.com", role: "teacher" }),
    ).resolves.toEqual({
      code: "123456",
      email_delivery_status: "unknown",
      expires_at: "2026-09-03T00:10:00.000Z",
      id: "approval-1",
    });
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      body: JSON.stringify({ email: "teacher@example.com", role: "teacher" }),
      credentials: "include",
      method: "POST",
    });
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("X-Admin-CSRF")).toBe(
      "admin-csrf-fixture",
    );
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("Content-Type")).toBe(
      "application/json",
    );
  });

  it("sends structured system-state values through the same protected mutation boundary", async () => {
    vi.spyOn(document, "cookie", "get").mockReturnValue(
      "__Host-classhub_admin_csrf=admin-csrf-fixture",
    );
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        jsonResponse({ state: { key: "maintenance_mode", value_json: { enabled: true } } }),
      );

    await updateAdminSystemState("maintenance_mode", { enabled: true });

    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/v1/admin/system-state/maintenance_mode");
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      body: JSON.stringify({ value: { enabled: true } }),
      method: "PATCH",
    });
  });

  it("creates a legal document draft with the four-way document_type contract", async () => {
    vi.spyOn(document, "cookie", "get").mockReturnValue(
      "__Host-classhub_admin_csrf=admin-csrf-fixture",
    );
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({
        version: {
          content: "보호자 동의 본문",
          created_at: "2026-09-03T00:00:00.000Z",
          created_by_admin_account_id: "17",
          document_type: "guardian_consent",
          effective_at: null,
          id: "guardian-1",
          policy_version: "2026-09",
          published_at: null,
          status: "draft",
          title: "보호자 동의서",
        },
      }),
    );

    await createAdminTermsVersion({
      content: "보호자 동의 본문",
      document_type: "guardian_consent",
      policy_version: "2026-09",
      title: "보호자 동의서",
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/v1/admin/terms/versions");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      content: "보호자 동의 본문",
      document_type: "guardian_consent",
      policy_version: "2026-09",
      title: "보호자 동의서",
    });
  });

  it("connects every super-admin account operation to its protected endpoint", async () => {
    vi.spyOn(document, "cookie", "get").mockReturnValue(
      "__Host-classhub_admin_csrf=admin-csrf-fixture",
    );
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ accounts: [] }))
      .mockResolvedValueOnce(
        jsonResponse({
          account: { id: "admin-2", roles: ["support"], status: "pending_mfa" },
          initial_password: "one-time-create-password",
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          account: {
            id: "admin-2",
            status: "suspended",
            updated_at: "2026-09-03T01:00:00.000Z",
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ account: { id: "admin-2", roles: ["support", "security_auditor"] } }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          account_id: "admin-2",
          initial_password: "one-time-reset-password",
          status: "pending_mfa",
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ account_id: "admin-2", status: "pending_mfa" }));

    await listAdminAccounts();
    await createAdminAccount({
      display_name: "지원 관리자",
      email: "support@example.com",
      roles: ["support"],
    });
    await updateAdminAccountStatus("admin/2", { reason: "휴직", status: "suspended" });
    await replaceAdminAccountRoles("admin/2", {
      reason: "감사 업무 추가",
      roles: ["support", "security_auditor"],
    });
    await resetAdminAccountCredentials("admin/2", "자격 증명 분실");
    await resetAdminAccountMfa("admin/2", "기기 교체");

    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      "/api/v1/admin/accounts",
      "/api/v1/admin/accounts",
      "/api/v1/admin/accounts/admin%2F2/status",
      "/api/v1/admin/accounts/admin%2F2/roles",
      "/api/v1/admin/accounts/admin%2F2/reset-credentials",
      "/api/v1/admin/accounts/admin%2F2/reset-mfa",
    ]);
    expect(fetchMock.mock.calls.slice(1).map((call) => call[1]?.method)).toEqual([
      "POST",
      "PATCH",
      "PUT",
      "POST",
      "POST",
    ]);
    expect(fetchMock.mock.calls[4]?.[1]).toMatchObject({
      body: JSON.stringify({ reason: "자격 증명 분실" }),
    });
    expect(new Headers(fetchMock.mock.calls[4]?.[1]?.headers).get("X-Admin-CSRF")).toBe(
      "admin-csrf-fixture",
    );
    expect(new Headers(fetchMock.mock.calls[4]?.[1]?.headers).get("Content-Type")).toBe(
      "application/json",
    );
  });

  it("connects auth and operation audits, terms status changes, and inquiry responses", async () => {
    vi.spyOn(document, "cookie", "get").mockReturnValue(
      "__Host-classhub_admin_csrf=admin-csrf-fixture",
    );
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ logs: [] }))
      .mockResolvedValueOnce(jsonResponse({ logs: [] }))
      .mockResolvedValueOnce(jsonResponse({ version: { id: "terms/1", status: "published" } }))
      .mockResolvedValueOnce(jsonResponse({ inquiry: { id: "inquiry/1", status: "resolved" } }));

    await listAdminAuthAuditLogs({ action: "admin.auth step-up" });
    await listAdminOperationAuditLogs({
      action: "admin.account updated",
      actor: "17",
      from: "2026-10-01",
      offset: "50",
    });
    await updateAdminTermsVersionStatus("terms/1", {
      effective_at: "2026-09-10T00:00:00.000Z",
      reason: "법무 검토 완료",
      status: "published",
    });
    await updateAdminInquiry("inquiry/1", {
      assigned_admin_account_id: null,
      internal_note: "응답 검수 완료",
      response: "문의하신 내용을 처리했습니다.",
      status: "resolved",
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "/api/v1/admin/auth-audit-logs?action=admin.auth+step-up",
    );
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "/api/v1/admin/operation-audit-logs?action=admin.account+updated&actor=17&from=2026-10-01&offset=50",
    );
    expect(fetchMock.mock.calls[2]?.[0]).toBe("/api/v1/admin/terms/versions/terms%2F1/status");
    expect(fetchMock.mock.calls[2]?.[1]).toMatchObject({
      body: JSON.stringify({
        effective_at: "2026-09-10T00:00:00.000Z",
        reason: "법무 검토 완료",
        status: "published",
      }),
      method: "PATCH",
    });
    expect(fetchMock.mock.calls[3]?.[0]).toBe("/api/v1/admin/inquiries/inquiry%2F1");
    expect(fetchMock.mock.calls[3]?.[1]).toMatchObject({
      body: JSON.stringify({
        assigned_admin_account_id: null,
        internal_note: "응답 검수 완료",
        response: "문의하신 내용을 처리했습니다.",
        status: "resolved",
      }),
      method: "PATCH",
    });
  });
});

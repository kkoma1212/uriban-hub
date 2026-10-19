import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router";
import { ApprovalPanel } from "./admin-console-account-panels";
import { MembersPanel } from "./admin-console-members-panel";

const response = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
afterEach(() => vi.restoreAllMocks());

describe("administrator account selection", () => {
  it("groups exact account memberships without repeating the person or losing unmatched results and keeps mutation IDs separate", async () => {
    vi.spyOn(document, "cookie", "get").mockReturnValue("__Host-classhub_admin_csrf=synthetic");
    const user = {
      id: "u1",
      display_name: "합성 학생",
      email: "student@example.invalid",
      is_active: true,
      email_verified: true,
      signup_approved: true,
      created_at: "2026-10-10T00:00:00Z",
      updated_at: "2026-10-10T00:00:00Z",
    };
    const member = {
      id: "m1",
      display_name: user.display_name,
      email: user.email,
      account_active: true,
      class_id: "c1",
      class_label: "1반",
      role: "student",
      status: "pending",
      student_number: 1,
      status_changed_at: "2026-10-10T00:00:00Z",
    };
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(response({ users: [user] }))
      .mockResolvedValueOnce(
        response({
          members: [
            member,
            { ...member, id: "m2", class_id: "c2", class_label: "2반", status: "approved" },
            {
              ...member,
              id: "m3",
              display_name: "검색 외 학생",
              email: "unmatched@example.invalid",
            },
          ],
        }),
      )
      .mockResolvedValueOnce(response({ member: { ...member, status: "rejected" } }));
    render(
      <MemoryRouter>
        <MembersPanel canViewMemberships canWrite />
      </MemoryRouter>,
    );
    fireEvent.change(screen.getByLabelText("이름 또는 이메일 · 2자 이상"), {
      target: { value: "학생" },
    });
    fireEvent.click(screen.getByRole("button", { name: "검색" }));
    const heading = await screen.findByRole("heading", { name: user.display_name });
    const person = heading.closest("li")!;
    expect(screen.getAllByText(user.email)).toHaveLength(1);
    expect(within(person).getByText("1반")).toBeVisible();
    expect(within(person).getByText("2반")).toBeVisible();
    expect(screen.getByText("검색 외 학생")).toBeVisible();
    expect(person.querySelectorAll("details[open]")).toHaveLength(0);
    const summary = within(person).getByLabelText("합성 학생 · 1반 소속 상태 변경");
    fireEvent.click(summary);
    const membership = summary.closest("li")!;
    fireEvent.change(within(membership).getByLabelText("변경할 상태"), {
      target: { value: "rejected" },
    });
    fireEvent.change(within(membership).getByLabelText("사유 (필수)"), {
      target: { value: "합성 검수" },
    });
    fireEvent.click(within(membership).getByRole("button", { name: "적용" }));
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "적용" }),
    );
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
    expect(String(fetch.mock.calls[2]?.[0])).toContain("/admin/members/m1/status");
    expect(JSON.parse(String(fetch.mock.calls[2]?.[1]?.body))).toEqual({
      status: "rejected",
      reason: "합성 검수",
    });
    expect(
      within(person)
        .getByLabelText("합성 학생 · student@example.invalid 계정 관리 작업")
        .closest("details"),
    ).not.toHaveAttribute("open");
  });

  it("does not infer account identity from a name or ambiguous email", async () => {
    const user = {
      id: "u1",
      display_name: "같은 이름",
      email: "duplicate@example.invalid",
      is_active: true,
      email_verified: true,
      signup_approved: true,
      created_at: "2026-10-10T00:00:00Z",
      updated_at: "2026-10-10T00:00:00Z",
    };
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(response({ users: [user, { ...user, id: "u2" }] }))
      .mockResolvedValueOnce(
        response({
          members: [
            {
              id: "m1",
              display_name: "같은 이름",
              email: user.email,
              account_active: true,
              class_id: "c1",
              class_label: "독립 소속",
              role: "teacher",
              status: "approved",
              student_number: null,
              status_changed_at: "2026-10-10T00:00:00Z",
            },
          ],
        }),
      );
    render(
      <MemoryRouter>
        <MembersPanel canViewMemberships canWrite={false} />
      </MemoryRouter>,
    );
    fireEvent.change(screen.getByLabelText("이름 또는 이메일 · 2자 이상"), {
      target: { value: "같은" },
    });
    fireEvent.click(screen.getByRole("button", { name: "검색" }));
    expect(
      await screen.findByRole("heading", { name: "계정 검색에 포함되지 않은 학급 소속 1개" }),
    ).toBeVisible();
    expect(screen.getAllByText("독립 소속")).toHaveLength(1);
    expect(screen.queryByText("소속 상태 변경")).not.toBeInTheDocument();
    expect(screen.queryByText("계정 관리 작업")).not.toBeInTheDocument();
  });
  it("prevents issuing administrative approval until the member verifies email", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      response({
        account: {
          user_id: "1",
          display_name: "확인 대기 선생님",
          email: "teacher@example.invalid",
          signup_role: "teacher",
          email_verified: false,
        },
      }),
    );
    render(
      <MemoryRouter>
        <ApprovalPanel />
      </MemoryRouter>,
    );
    fireEvent.change(screen.getByLabelText("가입 이메일"), {
      target: { value: "teacher@example.invalid" },
    });
    fireEvent.click(screen.getByRole("button", { name: "계정 검색" }));
    await screen.findByText(/이메일 인증 대기/);
    expect(screen.getByRole("button", { name: "발급" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "발급" }));
    expect(fetch).toHaveBeenCalledOnce();
  });
  it("clears the matched account and one-time code when the selected role changes", async () => {
    vi.spyOn(document, "cookie", "get").mockReturnValue("__Host-classhub_admin_csrf=synthetic");
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        response({
          account: {
            user_id: "1",
            display_name: "가입 학생",
            email: "student@example.org",
            signup_role: "student",
            email_verified: true,
          },
        }),
      )
      .mockResolvedValueOnce(
        response({ code: "123456", id: "fixture", expiresAt: "2030-01-01T00:10:00Z" }),
      )
      .mockResolvedValueOnce(response({ account: null }));
    render(
      <MemoryRouter>
        <ApprovalPanel />
      </MemoryRouter>,
    );
    fireEvent.change(screen.getByLabelText("가입 이메일"), {
      target: { value: "student@example.org" },
    });
    fireEvent.change(screen.getByLabelText("계정 유형"), { target: { value: "student" } });
    fireEvent.click(screen.getByRole("button", { name: "계정 검색" }));
    await screen.findByText("가입 학생 · 학생 계정");
    fireEvent.click(screen.getByRole("button", { name: "발급" }));
    await screen.findByText("123456");
    fireEvent.change(screen.getByLabelText("계정 유형"), { target: { value: "teacher" } });
    expect(screen.queryByText("123456")).not.toBeInTheDocument();
    expect(screen.queryByText("가입 학생 · 학생 계정")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "발급" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "계정 검색" }));
    await screen.findByText(/계정 유형에 일치하는 승인 대기 계정이 없습니다/u);
    expect(fetch.mock.calls[2]?.[0]).toContain("role=teacher");
    expect(screen.queryByRole("button", { name: "발급" })).not.toBeInTheDocument();
  });

  it("does not submit unchanged user status even after a reason is supplied", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      response({
        users: [
          {
            id: "1",
            display_name: "가입 학생",
            email: "student@example.org",
            is_active: true,
            email_verified: false,
            signup_approved: false,
            created_at: "2026-09-08T00:00:00Z",
            updated_at: "2026-09-08T00:00:00Z",
          },
        ],
      }),
    );
    render(
      <MemoryRouter>
        <MembersPanel canViewMemberships={false} canWrite />
      </MemoryRouter>,
    );
    fireEvent.change(screen.getByLabelText("이름 또는 이메일 · 2자 이상"), {
      target: { value: "가입" },
    });
    fireEvent.submit(screen.getByLabelText("이름 또는 이메일 · 2자 이상").closest("form")!);
    const accountHeading = await screen.findByRole("heading", { name: "가입 학생" });
    const accountActions = accountHeading.closest("li")!.querySelector("details")!;
    expect(accountActions).not.toHaveAttribute("open");
    fireEvent.click(screen.getByText("계정 관리 작업"));
    expect(accountActions).toHaveAttribute("open");
    fireEvent.change(screen.getByLabelText("작업 사유 (필수)"), { target: { value: "상태 확인" } });
    expect(screen.getByRole("button", { name: "계정 상태 저장" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "계정 상태 저장" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    fireEvent.change(screen.getByLabelText("계정 상태"), { target: { value: "inactive" } });
    expect(screen.getByRole("button", { name: "계정 상태 저장" })).toBeEnabled();
  });
});

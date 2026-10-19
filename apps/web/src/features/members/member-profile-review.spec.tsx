import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MemberProfileManagementPage } from "./member-profile-management-page";

const bootstrapFixture = {
  account: { display_name: "김교사", email_verified: true, is_active: true },
  allowed_actions: ["CHANGE_PASSWORD", "LOGOUT", "DELETE_ACCOUNT", "MANAGE_CLASS"],
  current_class: { id: "1", name: "테스트 1반", status: "active" },
  current_membership: {
    class_id: "1",
    display_name_in_class: null,
    id: "1",
    role: "teacher",
    status: "approved",
    student_number: null,
  },
  destination: "HOME",
  last_membership_status: null,
  last_status_reason: null,
  server_today: "2026-07-18",
  teacher_profile: { status: "active", temporary_password_must_change: false },
};

const approvedMember = {
  account_state: "active",
  display_name: "반 별명",
  display_name_in_class: "반 별명",
  id: "2",
  requested_at: null,
  row_version: "1",
  status: "approved",
  status_changed_at: "2026-07-18T01:00:00.000Z",
  student_number: 7,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function requestUrl(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
}

function renderProfile(memberId = "2"): void {
  vi.spyOn(Document.prototype, "cookie", "get").mockReturnValue(
    "__Host-classhub_csrf=test-csrf-token",
  );
  render(
    <MemoryRouter initialEntries={[`/members/manage/${memberId}`]}>
      <Routes>
        <Route path="/members/manage/:memberId" element={<MemberProfileManagementPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("member profile review regressions", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows a safe direct-URL failure for a missing or no-longer-approved student", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = requestUrl(input);
      if (url === "/api/v1/bootstrap") return Promise.resolve(jsonResponse(bootstrapFixture));
      if (url === "/api/v1/members/999/profile") {
        return Promise.resolve(
          jsonResponse(
            { error: { code: "MEMBER_NOT_FOUND", message: "구성원을 찾지 못했습니다." } },
            404,
          ),
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    renderProfile("999");

    expect(await screen.findByText("학생 정보를 열 수 없어요.")).toBeInTheDocument();
    expect(screen.getByText(/반 또는 승인 상태가 바뀌었는지/u)).toBeInTheDocument();
    expect(screen.queryByRole("form")).toBeNull();
    expect(document.body.textContent).not.toMatch(/전화번호|집 주소|보호자 연락처|생년월일|성별/u);
  });

  it("does not claim that the latest profile loaded when conflict recovery fails", async () => {
    let getCount = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = requestUrl(input);
      if (url === "/api/v1/bootstrap") return Promise.resolve(jsonResponse(bootstrapFixture));
      if (url === "/api/v1/members/2/profile" && init?.method !== "PATCH") {
        getCount += 1;
        if (getCount === 1) return Promise.resolve(jsonResponse({ member: approvedMember }));
        return Promise.reject(new Error("프로필 네트워크 오류"));
      }
      if (url === "/api/v1/members/2/profile") {
        return Promise.resolve(
          jsonResponse(
            {
              error: {
                code: "RESOURCE_VERSION_CHANGED",
                message: "다른 요청에서 먼저 변경되었습니다.",
              },
            },
            409,
          ),
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    renderProfile();
    const form = await screen.findByRole("form", { name: "반 별명 학생 정보 수정" });
    fireEvent.change(within(form).getByRole("textbox", { name: "반에서 보이는 이름" }), {
      target: { value: "충돌 이름" },
    });
    fireEvent.click(within(form).getByRole("button", { name: "저장" }));

    expect(
      await screen.findByText(
        "학생 정보가 먼저 변경됐지만 최신 정보를 불러오지 못했습니다. 학생 목록에서 상태를 다시 확인해 주세요.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("최신 학생 정보를 확인하지 못했어요.")).toBeInTheDocument();
    expect(screen.queryByText(/최신 정보를 불러왔습니다/u)).toBeNull();
    expect(within(form).getByRole("button", { name: "저장" })).toBeDisabled();
    expect(getCount).toBe(2);
  });

  it("hides account state from teachers without inventing additional profile fields", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = requestUrl(input);
      if (url === "/api/v1/bootstrap") return Promise.resolve(jsonResponse(bootstrapFixture));
      if (url === "/api/v1/members/2/profile") {
        return Promise.resolve(
          jsonResponse({
            member: { ...approvedMember, account_state: "inactive" },
          }),
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    renderProfile();

    const status = await screen.findByRole("region", { name: "반 별명 학생 상태" });
    expect(status).not.toHaveTextContent("사용 중지");
    expect(status).not.toHaveTextContent("계정 상태");
    expect(status).toHaveTextContent("참여");
    expect(document.body.textContent).not.toMatch(/전화번호|집 주소|보호자 연락처|생년월일|성별/u);
  });
});

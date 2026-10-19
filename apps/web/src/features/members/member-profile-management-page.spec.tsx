import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { clearNavigationCapabilities } from "../../lib/navigation-capabilities";
import { StudentSettingsPage } from "../settings/student-settings-page";
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

function LocationProbe(): React.JSX.Element {
  const location = useLocation();
  return <output data-testid="location">{`${location.pathname}${location.search}`}</output>;
}

function renderProfile(initialEntry = "/members/manage/2"): void {
  vi.spyOn(Document.prototype, "cookie", "get").mockReturnValue(
    "__Host-classhub_csrf=test-csrf-token",
  );
  render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <LocationProbe />
      <Routes>
        <Route path="/members/manage/:memberId" element={<MemberProfileManagementPage />} />
        <Route path="/members/manage" element={<p>학생 목록 화면</p>} />
        <Route path="/home" element={<p>학생 홈 화면</p>} />
        <Route path="/bootstrap" element={<p>계정 안내 화면</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("MemberProfileManagementPage", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    // 앞 시험의 담임 확인 상태가 다음 시험(학생)으로 넘어가지 않게 로그아웃과 같이 비운다.
    clearNavigationCapabilities();
  });

  it("loads an approved student directly, exposes only safe fields, and returns to the approved tab", async () => {
    const urls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = requestUrl(input);
      urls.push(url);
      if (url === "/api/v1/bootstrap") return Promise.resolve(jsonResponse(bootstrapFixture));
      if (url === "/api/v1/members/2/profile") {
        return Promise.resolve(jsonResponse({ member: approvedMember }));
      }
      // 담임 확인 뒤 화면 틀이 묻는 열린 도움 요청 수(학생 정보와 무관)
      if (url === "/api/v1/help-requests?status=open")
        return Promise.resolve(jsonResponse({ items: [] }));
      throw new Error(`Unexpected URL: ${url}`);
    });

    renderProfile();

    expect(await screen.findByRole("heading", { name: "학생 정보", level: 1 })).toBeInTheDocument();
    const status = await screen.findByRole("region", { name: "반 별명 학생 상태" });
    expect(status).toHaveTextContent("반 별명");
    expect(status).toHaveTextContent("7");
    expect(status).not.toHaveTextContent("계정 상태");
    expect(status).toHaveTextContent("참여");
    const form = screen.getByRole("form", { name: "반 별명 학생 정보 수정" });
    expect(within(form).getByRole("textbox", { name: "반에서 보이는 이름" })).toHaveValue(
      "반 별명",
    );
    expect(within(form).getByRole("spinbutton", { name: "학생 번호" })).toHaveValue(7);
    expect(status.compareDocumentPosition(form)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(urls.filter((url) => !url.startsWith("/api/v1/help-requests"))).toEqual([
      "/api/v1/bootstrap",
      "/api/v1/members/2/profile",
    ]);

    for (const prohibitedLabel of ["전화번호", "집 주소", "보호자 연락처", "생년월일", "성별"]) {
      expect(screen.queryByText(prohibitedLabel, { exact: false })).toBeNull();
    }

    fireEvent.click(screen.getByRole("link", { name: "학생 목록으로" }));
    expect(screen.getByTestId("location")).toHaveTextContent("/members/manage?tab=approved");
    expect(screen.getByText("학생 목록 화면")).toBeInTheDocument();
  });

  it("sends only changed fields with If-Match and blocks duplicate submission", async () => {
    let patchCount = 0;
    let resolvePatch!: (response: Response) => void;
    const patchResponse = new Promise<Response>((resolve) => {
      resolvePatch = resolve;
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = requestUrl(input);
      if (url === "/api/v1/bootstrap") return Promise.resolve(jsonResponse(bootstrapFixture));
      if (url === "/api/v1/members/2/profile" && init?.method !== "PATCH") {
        return Promise.resolve(jsonResponse({ member: approvedMember }));
      }
      if (url === "/api/v1/members/2/profile") {
        patchCount += 1;
        return patchResponse;
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    renderProfile();
    const form = await screen.findByRole("form", { name: "반 별명 학생 정보 수정" });
    fireEvent.change(within(form).getByRole("textbox", { name: "반에서 보이는 이름" }), {
      target: { value: "새 반 이름" },
    });
    const saveButton = within(form).getByRole("button", { name: "저장" });
    fireEvent.click(saveButton);
    fireEvent.click(saveButton);
    expect(patchCount).toBe(1);
    expect(saveButton).toBeDisabled();

    const patchCall = fetchMock.mock.calls.find(
      ([input, init]) =>
        requestUrl(input) === "/api/v1/members/2/profile" && init?.method === "PATCH",
    );
    expect(patchCall?.[1]?.body).toBe(JSON.stringify({ display_name_in_class: "새 반 이름" }));
    const headers = new Headers(patchCall?.[1]?.headers);
    expect(headers.get("If-Match")).toBe('"1"');
    expect(headers.get("X-CSRF-Token")).toBe("test-csrf-token");

    resolvePatch(
      jsonResponse({
        member: {
          ...approvedMember,
          display_name: "새 반 이름",
          display_name_in_class: "새 반 이름",
          row_version: "2",
        },
        profile_updated: true,
      }),
    );
    expect(await screen.findByText("새 반 이름 학생 정보를 저장했습니다.")).toBeInTheDocument();
    expect(screen.getByTestId("location")).toHaveTextContent("/members/manage/2");
    expect(screen.getByRole("button", { name: "이름·번호 수정" })).toBeEnabled();
  });

  it("validates the related field and reloads the latest profile after a version conflict", async () => {
    let getCount = 0;
    let patchCount = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = requestUrl(input);
      if (url === "/api/v1/bootstrap") return Promise.resolve(jsonResponse(bootstrapFixture));
      if (url === "/api/v1/members/2/profile" && init?.method !== "PATCH") {
        getCount += 1;
        return Promise.resolve(
          jsonResponse({
            member:
              getCount === 1
                ? approvedMember
                : { ...approvedMember, row_version: "2", student_number: 9 },
          }),
        );
      }
      if (url === "/api/v1/members/2/profile") {
        patchCount += 1;
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
    const displayName = within(form).getByRole("textbox", { name: "반에서 보이는 이름" });
    const studentNumber = within(form).getByRole("spinbutton", { name: "학생 번호" });
    fireEvent.change(displayName, { target: { value: "<b>잘못된 이름</b>" } });
    fireEvent.click(within(form).getByRole("button", { name: "저장" }));
    const validationError = await within(form).findByRole("alert");
    expect(validationError).toHaveTextContent("HTML 요소");
    expect(validationError).toHaveClass("text-danger");
    expect(displayName).toHaveAttribute("aria-invalid", "true");
    expect(studentNumber).not.toHaveAttribute("aria-invalid");
    expect(displayName).toHaveFocus();
    expect(patchCount).toBe(0);

    fireEvent.change(displayName, { target: { value: "경쟁 변경" } });
    fireEvent.click(within(form).getByRole("button", { name: "저장" }));
    expect(
      await screen.findByText(
        "학생 정보가 다른 작업에서 먼저 변경되어 최신 정보를 불러왔습니다. 다시 수정해 주세요.",
      ),
    ).toBeInTheDocument();
    expect(patchCount).toBe(1);
    expect(getCount).toBe(2);
    expect(within(form).getByRole("spinbutton", { name: "학생 번호" })).toHaveValue(9);
    expect(screen.getByTestId("location")).toHaveTextContent("/members/manage/2");
  });

  it("uses a primary recovery action when the student profile initially fails", async () => {
    let profileRequestCount = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = requestUrl(input);
      if (url === "/api/v1/bootstrap") return Promise.resolve(jsonResponse(bootstrapFixture));
      if (url === "/api/v1/members/2/profile") {
        profileRequestCount += 1;
        return profileRequestCount === 1
          ? Promise.resolve(
              jsonResponse({ error: { code: "MEMBER_LOOKUP_FAILED", message: "synthetic" } }, 503),
            )
          : Promise.resolve(jsonResponse({ member: approvedMember }));
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    renderProfile();

    const alert = await screen.findByRole("alert");
    const retryButton = within(alert).getByRole("button", { name: "다시 시도" });
    expect(retryButton).toHaveClass("ui-button-primary");
    expect(retryButton).not.toHaveClass("ui-button-danger");

    fireEvent.click(retryButton);
    expect(await screen.findByRole("form", { name: "반 별명 학생 정보 수정" })).toBeVisible();
    expect(profileRequestCount).toBe(2);
  });

  it("redirects a student before requesting another member profile", async () => {
    const urls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = requestUrl(input);
      urls.push(url);
      if (url !== "/api/v1/bootstrap") throw new Error(`Unexpected URL: ${url}`);
      return Promise.resolve(
        jsonResponse({
          ...bootstrapFixture,
          allowed_actions: ["CHANGE_PASSWORD", "LOGOUT"],
          current_membership: {
            ...bootstrapFixture.current_membership,
            role: "student",
          },
          teacher_profile: null,
        }),
      );
    });

    renderProfile();

    await waitFor(() => {
      expect(screen.getByTestId("location")).toHaveTextContent("/home");
    });
    expect(urls).toEqual(["/api/v1/bootstrap"]);
  });
});

describe("student own class profile", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    // 앞 시험의 담임 확인 상태가 다음 시험(학생)으로 넘어가지 않게 로그아웃과 같이 비운다.
    clearNavigationCapabilities();
  });

  it("retries a failed settings bootstrap without a page reload", async () => {
    let bootstrapRequestCount = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = requestUrl(input);
      if (url !== "/api/v1/bootstrap") throw new Error(`Unexpected URL: ${url}`);
      bootstrapRequestCount += 1;
      if (bootstrapRequestCount === 1) {
        return Promise.resolve(
          jsonResponse({ error: { code: "BOOTSTRAP_FAILED", message: "synthetic" } }, 503),
        );
      }
      return Promise.resolve(
        jsonResponse({
          ...bootstrapFixture,
          allowed_actions: ["CHANGE_PASSWORD", "LOGOUT", "DELETE_ACCOUNT", "LEAVE_CLASS"],
          current_membership: {
            ...bootstrapFixture.current_membership,
            role: "student",
          },
          teacher_profile: null,
        }),
      );
    });

    render(
      <MemoryRouter initialEntries={["/settings"]}>
        <StudentSettingsPage />
      </MemoryRouter>,
    );

    const alert = await screen.findByRole("alert");
    const retryButton = within(alert).getByRole("button", { name: "다시 시도" });
    expect(retryButton).toHaveClass("ui-button-primary");
    expect(retryButton).not.toHaveClass("ui-button-danger");

    fireEvent.click(retryButton);
    expect(await screen.findByRole("heading", { name: "프로필" })).toBeVisible();
    expect(bootstrapRequestCount).toBe(2);
  });

  it("shows only the signed-in student's class display name and student number", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = requestUrl(input);
      if (url !== "/api/v1/bootstrap") throw new Error(`Unexpected URL: ${url}`);
      return Promise.resolve(
        jsonResponse({
          ...bootstrapFixture,
          allowed_actions: ["CHANGE_PASSWORD", "LOGOUT", "DELETE_ACCOUNT", "LEAVE_CLASS"],
          current_membership: {
            ...bootstrapFixture.current_membership,
            display_name_in_class: "교실 별명",
            role: "student",
            student_number: 12,
          },
          teacher_profile: null,
        }),
      );
    });

    render(
      <MemoryRouter initialEntries={["/settings"]}>
        <StudentSettingsPage />
      </MemoryRouter>,
    );

    const classInfo = await screen.findByRole("heading", { name: "프로필" });
    const card = classInfo.nextElementSibling;
    expect(card).toHaveTextContent("테스트 1반");
    expect(card).toHaveTextContent("교실 별명");
    expect(card).toHaveTextContent("12");
    expect(card).not.toHaveTextContent("다른 학생");
  });
});

describe("student profile removal placement", () => {
  afterEach(() => vi.restoreAllMocks());
  it("keeps removal behind its confirmation after moving it into the profile", async () => {
    const calls: RequestInit[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = requestUrl(input);
      if (url === "/api/v1/bootstrap") return jsonResponse(bootstrapFixture);
      if (url === "/api/v1/members/2/profile") return jsonResponse({ member: approvedMember });
      if (url === "/api/v1/members/2/remove") {
        calls.push(init ?? {});
        return jsonResponse({ member: { id: "2", reason: "전학", status: "removed" } });
      }
      throw new Error("Unexpected URL: " + url);
    });
    renderProfile();
    const reason = await screen.findByRole("textbox", { name: "반 별명 반에서 제외 사유" });
    fireEvent.change(reason, { target: { value: "전학" } });
    const trigger = screen.getByRole("button", { name: "반에서 제외" });
    trigger.focus();
    fireEvent.click(trigger);
    expect(calls).toHaveLength(0);
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "취소" }));
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(calls).toHaveLength(0);
    fireEvent.click(trigger);
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "반에서 제외" }),
    );
    expect(await screen.findByText("학생 목록 화면")).toBeVisible();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toBe(JSON.stringify({ reason: "전학" }));
  });
});

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TeacherClassCreatePage } from "./teacher-class-create-page";
import { TeacherClassManagementPage } from "./teacher-class-management-page";

const teacherBootstrap = {
  account: { display_name: "테스트 선생님", email_verified: true, is_active: true },
  allowed_actions: ["CHANGE_PASSWORD", "LOGOUT", "VIEW_CLASS", "MANAGE_CLASS"],
  current_class: { id: "1", name: "테스트 1반", status: "active" },
  current_membership: {
    class_id: "1",
    display_name_in_class: "테스트 선생님",
    id: "51",
    role: "teacher",
    status: "approved",
    student_number: null,
  },
  destination: "HOME",
  last_membership_status: null,
  last_status_reason: null,
  server_today: "2026-07-21",
  teacher_profile: { status: "active", temporary_password_must_change: false },
};

const createClassBootstrap = {
  ...teacherBootstrap,
  allowed_actions: ["CHANGE_PASSWORD", "LOGOUT", "CREATE_CLASS"],
  current_class: null,
  current_membership: null,
  destination: "CREATE_CLASS",
};

const school = {
  edu_office_code: "B10",
  edu_office_name: "테스트 교육청",
  region_name: "서울",
  school_code: "1234567",
  school_kind: "middle",
  school_name: "테스트 중학교",
};

const currentClass = {
  academic_year: 2026,
  active_student_count: 1,
  expected_student_count: 30,
  grade: 1,
  id: "1",
  name: "테스트 1반",
  role: "teacher",
  row_version: "1",
  school_name: "테스트 중학교",
  status: "active",
  teacher_display_name: "테스트 선생님",
};

const oldInvite = {
  class_id: "1",
  invite_code: {
    code: "ABCDEFGH",
    created_at: "2026-07-21T00:00:00.000Z",
    expires_at: "2026-08-04T00:00:00.000Z",
    id: "1",
    status: "active",
  },
};

const newInvite = {
  class_id: "1",
  invite_code: {
    code: "JKMNPQRS",
    created_at: "2026-07-21T01:00:00.000Z",
    expires_at: "2026-08-04T01:00:00.000Z",
    id: "2",
    status: "active",
  },
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

function headerValue(init: RequestInit | undefined, name: string): string | null {
  return new Headers(init?.headers).get(name);
}

function confirmDialog(title: string, action: string): HTMLButtonElement {
  return within(screen.getByRole("dialog", { name: title })).getByRole("button", {
    name: action,
  });
}

describe("teacher class mutation state", () => {
  afterEach(() => {
    window.sessionStorage.clear();
    vi.restoreAllMocks();
  });

  it("retries a failed class-create bootstrap without reloading the page", async () => {
    let bootstrapRequestCount = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = requestUrl(input);
      if (url !== "/api/v1/bootstrap") throw new Error(`Unexpected URL: ${url}`);
      bootstrapRequestCount += 1;
      return Promise.resolve(
        bootstrapRequestCount === 1
          ? jsonResponse({ error: { code: "BOOTSTRAP_FAILED", message: "synthetic" } }, 503)
          : jsonResponse(createClassBootstrap),
      );
    });

    render(
      <MemoryRouter initialEntries={["/class/create"]}>
        <Routes>
          <Route element={<TeacherClassCreatePage />} path="/class/create" />
        </Routes>
      </MemoryRouter>,
    );

    const alert = await screen.findByRole("alert");
    const retryButton = within(alert).getByRole("button", { name: "다시 시도" });
    expect(retryButton).toHaveClass("ui-button-primary");
    expect(retryButton).not.toHaveClass("ui-button-danger");

    fireEvent.click(retryButton);
    expect(await screen.findByRole("heading", { level: 1, name: "반 만들기" })).toBeVisible();
    expect(bootstrapRequestCount).toBe(2);
  });

  it("restores a lost class-create request and reuses one key after a page remount", async () => {
    const submittedKeys: string[] = [];
    let postAttempts = 0;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = requestUrl(input);
      if (url === "/api/v1/bootstrap") return Promise.resolve(jsonResponse(createClassBootstrap));
      if (url === `/api/v1/schools?q=${encodeURIComponent("테스트")}`) {
        return Promise.resolve(jsonResponse({ schools: [school] }));
      }
      if (url === "/api/v1/classes" && init?.method === "POST") {
        postAttempts += 1;
        const key = headerValue(init, "Idempotency-Key");
        if (key === null) throw new Error("Idempotency-Key가 없습니다.");
        submittedKeys.push(key);
        if (postAttempts === 1) return Promise.reject(new TypeError("response lost"));
        return Promise.resolve(
          jsonResponse(
            {
              class: { ...currentClass, id: "2", name: "응답 유실 검수반" },
              invite_code: newInvite.invite_code,
              next_action: "HOME",
              teacher_membership_id: "52",
            },
            201,
          ),
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    vi.spyOn(Document.prototype, "cookie", "get").mockReturnValue(
      "__Host-classhub_csrf=test-csrf-token",
    );

    const firstRender = render(
      <MemoryRouter initialEntries={["/class/create"]}>
        <Routes>
          <Route element={<TeacherClassCreatePage />} path="/class/create" />
          <Route element={<p>반 생성 완료</p>} path="/class/manage" />
        </Routes>
      </MemoryRouter>,
    );
    fireEvent.change(await screen.findByLabelText("학교 이름"), {
      target: { value: "테스트" },
    });
    fireEvent.click(screen.getByRole("button", { name: "학교 검색" }));
    fireEvent.click(await screen.findByRole("button", { name: /테스트 중학교/u }));
    fireEvent.change(screen.getByLabelText("반 이름"), {
      target: { value: "응답 유실 검수반" },
    });
    const createForm = screen.getByLabelText("반 이름").closest("form");
    if (createForm === null) throw new Error("반 생성 폼을 찾지 못했습니다.");
    fireEvent.submit(createForm);
    fireEvent.submit(createForm);

    expect(await screen.findByText(/반 만들기 요청이 저장됐는지 확인하지 못했어요/u)).toBeVisible();
    expect(postAttempts).toBe(1);
    expect(screen.getByLabelText("반 이름")).toBeDisabled();
    expect(screen.getByRole("button", { name: "결과 다시 확인" })).toBeEnabled();
    expect(window.sessionStorage.length).toBe(1);

    firstRender.unmount();
    render(
      <MemoryRouter initialEntries={["/class/create"]}>
        <Routes>
          <Route element={<TeacherClassCreatePage />} path="/class/create" />
          <Route element={<p>반 생성 완료</p>} path="/class/manage" />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByText(/반 만들기 요청이 저장됐는지 확인하지 못했어요/u)).toBeVisible();
    expect(screen.getByLabelText("반 이름")).toHaveValue("응답 유실 검수반");
    fireEvent.click(screen.getByRole("button", { name: "결과 다시 확인" }));

    expect(await screen.findByText("반 생성 완료")).toBeVisible();
    expect(submittedKeys).toHaveLength(2);
    expect(new Set(submittedKeys).size).toBe(1);
    expect(window.sessionStorage.length).toBe(0);
    expect(fetchMock).toHaveBeenCalled();
  });

  it("guards invite rotation and replays an unknown result with the original key", async () => {
    const submittedKeys: string[] = [];
    let postAttempts = 0;
    let activeInvite = oldInvite;
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = requestUrl(input);
      if (url === "/api/v1/bootstrap") return Promise.resolve(jsonResponse(teacherBootstrap));
      if (url === "/api/v1/classes/current" && (init?.method ?? "GET") === "GET") {
        return Promise.resolve(jsonResponse(currentClass));
      }
      if (url === "/api/v1/classes/current/invite-code") {
        return Promise.resolve(jsonResponse(activeInvite));
      }
      if (url === "/api/v1/classes/current/invite-code/rotate" && init?.method === "POST") {
        postAttempts += 1;
        const key = headerValue(init, "Idempotency-Key");
        if (key === null) throw new Error("Idempotency-Key가 없습니다.");
        submittedKeys.push(key);
        if (postAttempts === 1) return Promise.reject(new TypeError("response lost"));
        activeInvite = newInvite;
        return Promise.resolve(jsonResponse(newInvite));
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    vi.spyOn(Document.prototype, "cookie", "get").mockReturnValue(
      "__Host-classhub_csrf=test-csrf-token",
    );
    render(
      <MemoryRouter initialEntries={["/class/manage"]}>
        <TeacherClassManagementPage />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "새 코드 (반 초대 코드 재발급)" }));
    const firstConfirm = confirmDialog("반 초대 코드를 재발급할까요?", "반 초대 코드 재발급");
    fireEvent.click(firstConfirm);
    fireEvent.click(firstConfirm);
    // 처리 중에는 '새 코드' 단추가 잠기므로 초점은 페이지 맨 앞이 아니라 초대 칸 제목으로 간다(2026-10-22).
    expect(screen.getByRole("heading", { level: 2, name: "학생 초대" })).toHaveFocus();

    expect(
      await screen.findByText(/반 초대 코드 재발급 요청이 저장됐는지 확인하지 못했어요/u),
    ).toBeVisible();
    expect(postAttempts).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "결과 다시 확인" }));
    fireEvent.click(confirmDialog("반 초대 코드 재발급 결과를 다시 확인할까요?", "결과 다시 확인"));

    expect(await screen.findByText("JKMNPQRS")).toBeVisible();
    expect(await screen.findByText("반 초대 코드를 재발급했어요.")).toBeVisible();
    expect(submittedKeys).toHaveLength(2);
    expect(new Set(submittedKeys).size).toBe(1);
    expect(window.sessionStorage.length).toBe(0);
  });

  it("resolves a lost class-information save through If-Match without applying it twice", async () => {
    let storedClass = currentClass;
    let patchAttempts = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = requestUrl(input);
      if (url === "/api/v1/bootstrap") return Promise.resolve(jsonResponse(teacherBootstrap));
      if (url === "/api/v1/classes/current" && (init?.method ?? "GET") === "GET") {
        return Promise.resolve(jsonResponse(storedClass));
      }
      if (url === "/api/v1/classes/current/invite-code") {
        return Promise.resolve(jsonResponse(oldInvite));
      }
      if (url === "/api/v1/classes/current" && init?.method === "PATCH") {
        patchAttempts += 1;
        if (patchAttempts === 1) {
          storedClass = {
            ...currentClass,
            expected_student_count: 28,
            name: "응답 유실 확인반",
            row_version: "2",
          };
          return Promise.reject(new TypeError("response lost"));
        }
        return Promise.resolve(
          jsonResponse(
            {
              error: {
                code: "RESOURCE_VERSION_CHANGED",
                message: "반 정보가 변경되었습니다. 최신 값을 다시 확인해 주세요.",
              },
            },
            409,
          ),
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    vi.spyOn(Document.prototype, "cookie", "get").mockReturnValue(
      "__Host-classhub_csrf=test-csrf-token",
    );
    render(
      <MemoryRouter initialEntries={["/class/manage"]}>
        <TeacherClassManagementPage />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "반 이름 · 예상 학생 수 수정" }));
    fireEvent.change(screen.getByLabelText("반 이름"), {
      target: { value: "응답 유실 확인반" },
    });
    fireEvent.change(screen.getByLabelText("예상 학생 수"), { target: { value: "28" } });
    const firstSave = screen.getByRole("button", { name: "저장" });
    fireEvent.click(firstSave);
    fireEvent.click(firstSave);

    expect(await screen.findByText(/반 정보 저장 결과를 확인하지 못했습니다/u)).toBeVisible();
    expect(patchAttempts).toBe(1);
    expect(screen.getByLabelText("반 이름")).toHaveValue("응답 유실 확인반");
    fireEvent.click(screen.getByRole("button", { name: "저장" }));

    expect(await screen.findByText("반 정보 저장 결과를 확인했습니다.")).toBeVisible();
    expect(patchAttempts).toBe(2);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "반 이름 · 예상 학생 수 수정" })).toBeVisible(),
    );
  });
});

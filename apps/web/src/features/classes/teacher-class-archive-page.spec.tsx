import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { BootstrapResponse, CurrentClassResponse } from "../../api/auth";
import { TeacherClassArchivePage } from "./teacher-class-archive-page";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

const bootstrapFixture: BootstrapResponse = {
  account: { display_name: "테스트 교사", email_verified: true, is_active: true },
  allowed_actions: ["CHANGE_PASSWORD", "LOGOUT", "VIEW_CLASS", "MANAGE_CLASS"],
  current_class: { id: "41", name: "테스트 1반", status: "active" },
  current_membership: {
    class_id: "41",
    display_name_in_class: null,
    id: "51",
    role: "teacher",
    student_number: null,
    status: "approved",
  },
  destination: "HOME",
  last_membership_status: null,
  last_status_reason: null,
  server_today: "2026-07-18",
  teacher_profile: { status: "active", temporary_password_must_change: false },
};

const currentClassFixture: CurrentClassResponse = {
  academic_year: 2026,
  active_student_count: 2,
  expected_student_count: 30,
  grade: 1,
  id: "41",
  name: "테스트 1반",
  role: "teacher",
  row_version: "7",
  school_address: null,
  school_homepage_url: null,
  school_name: "테스트 중학교",
  school_phone_number: null,
  status: "active",
  teacher_display_name: "테스트 교사",
};

function renderPage(): void {
  render(
    <MemoryRouter initialEntries={["/class/archive"]}>
      <Routes>
        <Route element={<TeacherClassArchivePage />} path="/class/archive" />
        <Route element={<p>새 반 시작 상태 도착</p>} path="/bootstrap" />
        <Route element={<p>로그인 도착</p>} path="/login" />
        <Route element={<p>반 관리 도착</p>} path="/class/manage" />
      </Routes>
    </MemoryRouter>,
  );
}

function mockInitialLoads(
  archiveResponse: Promise<Response> | Response,
): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
    const url = requestUrl(input);
    if (url === "/api/v1/bootstrap") return Promise.resolve(jsonResponse(bootstrapFixture));
    if (url === "/api/v1/classes/current") {
      return Promise.resolve(jsonResponse(currentClassFixture));
    }
    if (url === "/api/v1/classes/current/archive") return Promise.resolve(archiveResponse);
    if (url === "/api/v1/past-classes") return Promise.resolve(jsonResponse({ items: [] }));
    throw new Error(`Unexpected URL: ${url}`);
  });
}

async function enterExactNameAndReview(): Promise<HTMLElement> {
  const input = await screen.findByLabelText("확인할 반 이름");
  fireEvent.change(input, { target: { value: currentClassFixture.name } });
  const review = screen.getByRole("button", { name: "반 운영 종료 검토" });
  expect(review).toBeEnabled();
  fireEvent.click(review);
  return screen.findByRole("dialog", {
    name: `‘${currentClassFixture.name}’ 반 운영을 종료할까요?`,
  });
}

describe("TeacherClassArchivePage", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps the teacher shell and page heading while class data waits and fails", async () => {
    let resolveClass!: (response: Response) => void;
    const pendingClass = new Promise<Response>((resolve) => {
      resolveClass = resolve;
    });
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = requestUrl(input);
      if (url === "/api/v1/bootstrap") {
        return Promise.resolve(jsonResponse(bootstrapFixture));
      }
      if (url === "/api/v1/classes/current") return pendingClass;
      throw new Error(`Unexpected URL: ${url}`);
    });

    renderPage();

    await waitFor(() =>
      expect(screen.getAllByRole("navigation", { name: "주요 메뉴" })).toHaveLength(2),
    );
    expect(
      screen.getByRole("heading", {
        level: 1,
        name: "반 운영 종료",
      }),
    ).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent("반 종료 조건을 확인하고 있어요.");

    await act(async () => {
      resolveClass(
        jsonResponse(
          {
            error: {
              code: "QA_FORCED_503",
              message: "INTERNAL_QA_DIAGNOSTIC private_class_table",
              request_id: "qa-class-archive-load",
            },
          },
          503,
        ),
      );
    });

    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "반 운영 종료",
      }),
    ).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent("반 종료 정보를 불러오지 못했어요.");
    expect(screen.getAllByRole("navigation", { name: "주요 메뉴" })).toHaveLength(2);
    expect(screen.queryByText(/private_class_table/u)).not.toBeInTheDocument();
  });

  it("requires the exact class name and completes one accessible archive request", async () => {
    vi.spyOn(Document.prototype, "cookie", "get").mockReturnValue(
      "__Host-classhub_csrf=archive-class-token",
    );
    let resolveArchive!: (response: Response) => void;
    const pendingArchive = new Promise<Response>((resolve) => {
      resolveArchive = resolve;
    });
    const fetchMock = mockInitialLoads(pendingArchive);
    window.sessionStorage.setItem(
      "classhub:idempotent-create:invite-code-rotations:membership-1",
      "private-class-draft",
    );

    renderPage();

    expect(await screen.findByText(/반의 내용과 구성원 연결 정보/u)).toBeVisible();
    expect(screen.getByRole("heading", { level: 1, name: "반 운영 종료" })).toBeVisible();
    expect(screen.getByText(/개인정보가 없는 최소한의 반 기록/u)).toBeVisible();
    expect(screen.getByText(/반에 연결하지 않은 개인 평가는 자체 보관 기한/u)).toBeVisible();
    expect(screen.getByText("선생님과 학생의 이 반 활동은 즉시 종료됩니다.")).toBeVisible();
    // 종료 전에 반 기록을 받아 둘 수 있고, 종료 뒤에는 지난 반에서 받는다는 안내.
    expect(
      screen.getByText(/종료 후에도 365일이 지나기 전까지 ‘지난 반’에서 내려받을/u),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "반 기록 CSV 받기" })).toBeEnabled();
    expect(
      screen.getByText(/종료 당시 승인된 구성원은 종료 후 365일이 지나기 전까지/u),
    ).toBeVisible();
    expect(screen.queryByText(/이 반 앱 접근이 즉시 종료/u)).not.toBeInTheDocument();

    const input = screen.getByLabelText("확인할 반 이름");
    const review = screen.getByRole("button", { name: "반 운영 종료 검토" });
    expect(input).toBeRequired();
    expect(input).toHaveAttribute("aria-required", "true");
    expect(review).toBeDisabled();

    fireEvent.change(input, { target: { value: `${currentClassFixture.name} ` } });
    expect(screen.getByText("현재 반 이름과 일치하지 않습니다.")).toHaveAttribute("role", "alert");
    expect(review).toBeDisabled();

    fireEvent.change(input, { target: { value: currentClassFixture.name } });
    fireEvent.click(review);
    const firstDialog = await screen.findByRole("dialog", {
      name: `‘${currentClassFixture.name}’ 반 운영을 종료할까요?`,
    });
    expect(firstDialog).toHaveAccessibleDescription(
      "반 활동은 즉시 종료되고 초대 코드는 폐기됩니다. 종료 당시 승인된 구성원은 종료 후 365일이 지나기 전까지 지난 반 소식을 읽기 전용으로 볼 수 있습니다. 교사는 활성 교사 계정이어야 합니다. 365일이 지나면 반 내용과 멤버십을 삭제하고 개인정보 없는 최소 반 기록만 남깁니다. 반 연결 평가는 자체 보관 기한과 반 종료 후 365일 중 더 이른 기한에 삭제되며, 반에 연결하지 않은 개인 평가는 자체 기한을 따릅니다. 앱에서는 반을 복원할 수 없습니다.",
    );
    expect(within(firstDialog).getByRole("button", { name: "반 유지" })).toHaveFocus();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(review).toHaveFocus());

    fireEvent.click(review);
    const secondDialog = await screen.findByRole("dialog", {
      name: `‘${currentClassFixture.name}’ 반 운영을 종료할까요?`,
    });
    const finalConfirm = within(secondDialog).getByRole("button", {
      name: "반 운영 종료 실행",
    });
    fireEvent.click(finalConfirm);
    fireEvent.click(finalConfirm);

    expect(await screen.findByRole("button", { name: "종료하는 중" })).toBeDisabled();
    const archiveCalls = fetchMock.mock.calls.filter(
      (call: unknown[]) =>
        requestUrl(call[0] as RequestInfo | URL) === "/api/v1/classes/current/archive",
    );
    expect(archiveCalls).toHaveLength(1);
    const request = archiveCalls[0]?.[1] as RequestInit | undefined;
    expect(request).toMatchObject({ method: "POST", credentials: "include" });
    expect(new Headers(request?.headers).get("X-CSRF-Token")).toBe("archive-class-token");
    expect(JSON.parse(String(request?.body))).toEqual({
      class_name_confirmation: currentClassFixture.name,
      expected_class_id: currentClassFixture.id,
      expected_row_version: currentClassFixture.row_version,
    });

    await act(async () => {
      resolveArchive(
        jsonResponse({
          archived_at: "2026-07-18T09:00:00.000Z",
          class_id: currentClassFixture.id,
          next_action: "CREATE_CLASS",
          row_version: "8",
        }),
      );
    });

    expect(await screen.findByText("새 반 시작 상태 도착")).toBeVisible();
    expect(screen.queryByLabelText("확인할 반 이름")).not.toBeInTheDocument();
    expect(
      window.sessionStorage.getItem(
        "classhub:idempotent-create:invite-code-rotations:membership-1",
      ),
    ).toBeNull();
  });

  it("associates a server-side confirmation mismatch with the input and restores focus", async () => {
    vi.spyOn(Document.prototype, "cookie", "get").mockReturnValue(
      "__Host-classhub_csrf=archive-class-token",
    );
    mockInitialLoads(
      jsonResponse(
        {
          error: {
            code: "CLASS_NAME_CONFIRMATION_MISMATCH",
            message: "현재 반 이름을 정확히 입력해 주세요.",
          },
        },
        409,
      ),
    );
    renderPage();

    const dialog = await enterExactNameAndReview();
    fireEvent.click(within(dialog).getByRole("button", { name: "반 운영 종료 실행" }));

    const input = screen.getByLabelText("확인할 반 이름");
    await waitFor(() => expect(input).toHaveFocus());
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText("현재 반 이름을 공백까지 똑같이 입력해 주세요.")).toHaveAttribute(
      "role",
      "alert",
    );
  });

  it("announces a fail-closed server error and keeps the class unchanged for retry", async () => {
    vi.spyOn(Document.prototype, "cookie", "get").mockReturnValue(
      "__Host-classhub_csrf=archive-class-token",
    );
    mockInitialLoads(
      jsonResponse(
        { error: { code: "INTERNAL_ERROR", message: "서비스를 사용할 수 없습니다." } },
        503,
      ),
    );
    renderPage();

    const dialog = await enterExactNameAndReview();
    fireEvent.click(within(dialog).getByRole("button", { name: "반 운영 종료 실행" }));

    const alert = await screen.findByRole("alert", { name: "반 운영 종료 요청 오류" });
    expect(alert).toHaveFocus();
    expect(alert).toHaveTextContent("지금 확인한 반 상태는 운영 중이에요");
    expect(alert).not.toHaveTextContent("반은 변경되지 않았습니다");
    expect(screen.getByLabelText("확인할 반 이름")).toHaveValue(currentClassFixture.name);
    expect(screen.getByRole("button", { name: "반 운영 종료 검토" })).toBeEnabled();
  });

  it("redirects a user without active teacher management authority before loading the class", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        ...bootstrapFixture,
        allowed_actions: ["CHANGE_PASSWORD", "LOGOUT", "VIEW_CLASS"],
        current_membership: { ...bootstrapFixture.current_membership, role: "student" },
      }),
    );
    renderPage();

    expect(await screen.findByText("새 반 시작 상태 도착")).toBeVisible();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByLabelText("확인할 반 이름")).not.toBeInTheDocument();
  });
});

describe("archive uncertain outcome and lifetime", () => {
  afterEach(() => vi.restoreAllMocks());
  function harness(
    options: {
      archive?: () => Promise<Response>;
      past?: () => Promise<Response>;
      current?: () => Promise<Response>;
    } = {},
  ) {
    vi.spyOn(Document.prototype, "cookie", "get").mockReturnValue(
      "__Host-classhub_csrf=archive-class-token",
    );
    let currentCalls = 0;
    return vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = requestUrl(input);
      if (url === "/api/v1/bootstrap") return Promise.resolve(jsonResponse(bootstrapFixture));
      if (url === "/api/v1/classes/current") {
        currentCalls += 1;
        return currentCalls === 1
          ? Promise.resolve(jsonResponse(currentClassFixture))
          : (options.current?.() ?? Promise.resolve(jsonResponse(currentClassFixture)));
      }
      if (url === "/api/v1/classes/current/archive")
        return options.archive?.() ?? Promise.reject(new TypeError("lost response"));
      if (url === "/api/v1/past-classes")
        return options.past?.() ?? Promise.resolve(jsonResponse({ items: [] }));
      throw new Error("Unexpected URL: " + url);
    });
  }
  async function submit() {
    renderPage();
    const dialog = await enterExactNameAndReview();
    fireEvent.click(within(dialog).getByRole("button", { name: "반 운영 종료 실행" }));
  }
  it("recovers a committed archive from the exact original past class", async () => {
    const fetchMock = harness({
      past: () =>
        Promise.resolve(
          jsonResponse({ items: [{ class_id: currentClassFixture.id, role: "teacher" }] }),
        ),
    });
    await submit();
    expect(await screen.findByText("새 반 시작 상태 도착")).toBeVisible();
    expect(
      fetchMock.mock.calls.filter(
        ([input]) => requestUrl(input) === "/api/v1/classes/current/archive",
      ),
    ).toHaveLength(1);
  });
  it("allows review again only after the exact original active teacher class is read", async () => {
    harness();
    await submit();
    expect(await screen.findByRole("alert", { name: "반 운영 종료 요청 오류" })).toHaveTextContent(
      "지금 확인한 반 상태는 운영 중이에요",
    );
    expect(screen.getByRole("button", { name: "반 운영 종료 검토" })).toBeEnabled();
  });
  it.each(["different", "suspended", "missing", "no-role"])(
    "keeps an %s result locked and rechecks without a second POST",
    async (variant) => {
      const fetchMock = harness({
        current: () =>
          Promise.resolve(
            variant === "missing"
              ? jsonResponse({ error: { code: "NOT_FOUND", message: "none" } }, 404)
              : jsonResponse({
                  ...currentClassFixture,
                  ...(variant === "different"
                    ? { id: "999" }
                    : variant === "suspended"
                      ? { status: "suspended" }
                      : { role: "student" }),
                }),
          ),
      });
      await submit();
      expect(
        await screen.findByRole("alert", { name: "반 운영 종료 요청 오류" }),
      ).toHaveTextContent("중복 실행을 막기 위해");
      const review = screen.getByRole("button", { name: "반 운영 종료 검토" });
      expect(review).toBeDisabled();
      fireEvent.change(screen.getByLabelText("확인할 반 이름"), {
        target: { value: currentClassFixture.name },
      });
      expect(review).toBeDisabled();
      fireEvent.click(screen.getByRole("button", { name: "종료 결과 다시 확인" }));
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "종료 결과 다시 확인" })).toBeVisible(),
      );
      expect(
        fetchMock.mock.calls.filter(
          ([input]) => requestUrl(input) === "/api/v1/classes/current/archive",
        ),
      ).toHaveLength(1);
    },
  );
  it("clears authenticated drafts when verification returns 401", async () => {
    harness({
      past: () =>
        Promise.resolve(
          jsonResponse({ error: { code: "UNAUTHENTICATED", message: "expired" } }, 401),
        ),
    });
    window.sessionStorage.setItem("classhub:content-reuse:private", "draft");
    await submit();
    expect(await screen.findByText("로그인 도착")).toBeVisible();
    expect(window.sessionStorage.getItem("classhub:content-reuse:private")).toBeNull();
  });
  it("clears authenticated drafts when initial bootstrap returns 401", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ error: { code: "UNAUTHENTICATED", message: "expired" } }, 401),
    );
    window.sessionStorage.setItem("classhub:content-reuse:private", "draft");
    renderPage();
    expect(await screen.findByText("로그인 도착")).toBeVisible();
    expect(window.sessionStorage.getItem("classhub:content-reuse:private")).toBeNull();
  });
  it("treats an explicit 503 as uncertain and recognizes the exact archived class", async () => {
    harness({
      archive: () =>
        Promise.resolve(
          jsonResponse({ error: { code: "INTERNAL_ERROR", message: "unknown" } }, 503),
        ),
      past: () =>
        Promise.resolve(
          jsonResponse({ items: [{ class_id: currentClassFixture.id, role: "teacher" }] }),
        ),
    });
    await submit();
    expect(await screen.findByText("새 반 시작 상태 도착")).toBeVisible();
  });
  it("clears authenticated drafts when the archive request returns 401", async () => {
    harness({
      archive: () =>
        Promise.resolve(
          jsonResponse({ error: { code: "UNAUTHENTICATED", message: "expired" } }, 401),
        ),
    });
    window.sessionStorage.setItem("classhub:content-reuse:private", "draft");
    await submit();
    expect(await screen.findByText("로그인 도착")).toBeVisible();
    expect(window.sessionStorage.getItem("classhub:content-reuse:private")).toBeNull();
  });
  it("locks after failed verification and permits one verification at a time", async () => {
    let calls = 0;
    let resolve!: (r: Response) => void;
    const pending = new Promise<Response>((r) => {
      resolve = r;
    });
    const fetchMock = harness({
      past: () => (++calls === 1 ? Promise.reject(new TypeError("offline")) : pending),
    });
    await submit();
    const recheck = await screen.findByRole("button", { name: "종료 결과 다시 확인" });
    fireEvent.click(recheck);
    fireEvent.click(recheck);
    expect(await screen.findByText("현재 반의 종료 결과를 확인하고 있어요.")).toBeVisible();
    expect(screen.getByRole("button", { name: "반 운영 종료 검토" })).toBeDisabled();
    expect(calls).toBe(2);
    await act(async () =>
      resolve(jsonResponse({ items: [{ class_id: currentClassFixture.id, role: "teacher" }] })),
    );
    expect(await screen.findByText("새 반 시작 상태 도착")).toBeVisible();
    expect(
      fetchMock.mock.calls.filter(
        ([input]) => requestUrl(input) === "/api/v1/classes/current/archive",
      ),
    ).toHaveLength(1);
  });
  it("ignores a late archive success after leaving the page", async () => {
    let resolve!: (r: Response) => void;
    const pending = new Promise<Response>((r) => {
      resolve = r;
    });
    harness({ archive: () => pending });
    await submit();
    fireEvent.click(screen.getByRole("link", { name: "반 관리로 돌아가기" }));
    expect(await screen.findByText("반 관리 도착")).toBeVisible();
    window.sessionStorage.setItem("classhub:content-reuse:private", "new draft");
    await act(async () => resolve(jsonResponse({ class_id: currentClassFixture.id })));
    expect(screen.getByText("반 관리 도착")).toBeVisible();
    expect(window.sessionStorage.getItem("classhub:content-reuse:private")).toBe("new draft");
  });
  it("ignores a late verification 401 after leaving the page", async () => {
    let resolve!: (r: Response) => void;
    const pending = new Promise<Response>((r) => {
      resolve = r;
    });
    harness({ past: () => pending });
    await submit();
    expect(await screen.findByText("현재 반의 종료 결과를 확인하고 있어요.")).toBeVisible();
    fireEvent.click(screen.getByRole("link", { name: "반 관리로 돌아가기" }));
    expect(await screen.findByText("반 관리 도착")).toBeVisible();
    window.sessionStorage.setItem("classhub:content-reuse:private", "new draft");
    await act(async () =>
      resolve(jsonResponse({ error: { code: "UNAUTHENTICATED", message: "expired" } }, 401)),
    );
    expect(screen.getByText("반 관리 도착")).toBeVisible();
    expect(window.sessionStorage.getItem("classhub:content-reuse:private")).toBe("new draft");
  });
  it("ignores a late initial bootstrap after unmount", async () => {
    let resolve!: (r: Response) => void;
    const pending = new Promise<Response>((r) => {
      resolve = r;
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockReturnValue(pending);
    renderPage();
    cleanup();
    await act(async () => resolve(jsonResponse(bootstrapFixture)));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("ignores a late archive response after authenticated state was cleared", async () => {
    let resolve!: (r: Response) => void;
    const pending = new Promise<Response>((r) => {
      resolve = r;
    });
    harness({ archive: () => pending });
    await submit();
    window.dispatchEvent(new Event("classhub:authenticated-client-state-cleared"));
    window.sessionStorage.setItem("classhub:content-reuse:private", "new draft");
    await act(async () => resolve(jsonResponse({ class_id: currentClassFixture.id })));
    expect(window.sessionStorage.getItem("classhub:content-reuse:private")).toBe("new draft");
    expect(screen.queryByText("새 반 시작 상태 도착")).not.toBeInTheDocument();
  });
});

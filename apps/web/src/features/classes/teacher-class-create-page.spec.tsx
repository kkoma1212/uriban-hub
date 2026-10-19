import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as auth from "../../api/auth";
import { clearAuthenticatedClientState } from "../../lib/authenticated-client-state";
import type { BootstrapResponse } from "../../api/auth";
import {
  idempotentCreateStorageKey,
  persistIdempotentCreateAttempt,
} from "../../lib/idempotent-create";
import { TeacherClassCreatePage } from "./teacher-class-create-page";

// Shared system polling has separate contract tests; keep ordered fetch fixtures scoped to this flow.
vi.mock("../layout/system-state-banner", () => ({ SystemStateBanner: () => null }));

const createClassBootstrap = {
  account: { display_name: "박교사", email_verified: true, is_active: true },
  allowed_actions: ["CREATE_CLASS", "LOGOUT", "DELETE_ACCOUNT", "CHANGE_PASSWORD"],
  current_class: null,
  current_membership: null,
  destination: "CREATE_CLASS",
  last_membership_status: null,
  last_status_reason: null,
  server_today: "2026-08-01",
  teacher_profile: { status: "active", temporary_password_must_change: false },
} satisfies BootstrapResponse;

const SCHOOL = {
  edu_office_code: "B10",
  edu_office_name: "서울특별시교육청",
  region_name: "서울특별시",
  school_code: "7010084",
  school_kind: "high",
  school_name: "테스트고등학교",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
    status,
  });
}

function requestUrl(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
}

function renderPage(): void {
  render(
    <MemoryRouter initialEntries={["/class/create"]}>
      <Routes>
        <Route element={<TeacherClassCreatePage />} path="/class/create" />
        <Route element={<p>계정 안내 화면</p>} path="/bootstrap" />
        <Route element={<p>로그인 화면</p>} path="/login" />
        <Route element={<p>반 관리 화면</p>} path="/class/manage" />
      </Routes>
    </MemoryRouter>,
  );
}

describe("TeacherClassCreatePage", () => {
  it.each(["search", "create"])("returns an expired %s session to login", async (operation) => {
    vi.spyOn(auth, "getBootstrap").mockResolvedValue(createClassBootstrap);
    const expired = new auth.ApiRequestError("UNAUTHENTICATED", "로그인 필요", 401);
    vi.spyOn(auth, "searchSchools").mockImplementation(async () => {
      if (operation === "search") throw expired;
      return { schools: [SCHOOL] } as Awaited<ReturnType<typeof auth.searchSchools>>;
    });
    vi.spyOn(auth, "createClass").mockRejectedValue(expired);
    renderPage();
    await screen.findByRole("heading", { name: "반 만들기" });
    fireEvent.change(screen.getByLabelText("학교 이름"), { target: { value: "테스트" } });
    fireEvent.click(screen.getByRole("button", { name: "학교 검색" }));
    if (operation === "create") {
      fireEvent.click(await screen.findByRole("button", { name: /테스트고등학교/ }));
      fireEvent.change(screen.getByLabelText("반 이름"), { target: { value: "1반" } });
      fireEvent.click(screen.getByRole("button", { name: "반 만들기" }));
    }
    expect(await screen.findByText("로그인 화면")).toBeVisible();
    expect(
      sessionStorage.getItem(idempotentCreateStorageKey("classes", "pending-teacher")),
    ).toBeNull();
  });

  it("blocks school requests and selection during logout, then unlocks after failure", async () => {
    vi.spyOn(auth, "getBootstrap").mockResolvedValue(createClassBootstrap);
    const search = vi
      .spyOn(auth, "searchSchools")
      .mockResolvedValue({ schools: [SCHOOL] } as Awaited<ReturnType<typeof auth.searchSchools>>);
    let reject!: (error: unknown) => void;
    vi.spyOn(auth, "logout").mockReturnValue(
      new Promise((_, fail) => {
        reject = fail;
      }),
    );
    renderPage();
    await screen.findByRole("heading", { name: "반 만들기" });
    const query = screen.getByLabelText("학교 이름");
    fireEvent.change(query, { target: { value: "테스트" } });
    fireEvent.submit(query.closest("form")!);
    const school = await screen.findByRole("button", { name: /테스트고등학교/ });
    fireEvent.click(school);
    fireEvent.click(screen.getByRole("button", { name: "로그아웃" }));
    expect(query).toBeDisabled();
    expect(school).toBeDisabled();
    expect(screen.getByLabelText("반 이름")).toBeDisabled();
    fireEvent.submit(query.closest("form")!);
    expect(search).toHaveBeenCalledTimes(1);
    await act(async () => reject(new Error("로그아웃 실패")));
    expect(await screen.findByText("로그아웃 실패")).toBeVisible();
    expect(query).toBeEnabled();
    expect(school).toBeEnabled();
    expect(screen.getByLabelText("반 이름")).toBeEnabled();
    expect(screen.getByRole("button", { name: "반 만들기" })).toBeEnabled();
  });

  it.each(["failure", "success"])(
    "ignores late create %s after logout and preserves a new session record",
    async (outcome) => {
      vi.spyOn(auth, "getBootstrap").mockResolvedValue(createClassBootstrap);
      vi.spyOn(auth, "searchSchools").mockResolvedValue({ schools: [SCHOOL] } as Awaited<
        ReturnType<typeof auth.searchSchools>
      >);
      let finish!: (value: unknown) => void;
      let reject!: (value: unknown) => void;
      vi.spyOn(auth, "createClass").mockReturnValue(
        new Promise((resolve, fail) => {
          finish = resolve as typeof finish;
          reject = fail;
        }),
      );
      vi.spyOn(auth, "logout").mockImplementation(async () => clearAuthenticatedClientState());
      renderPage();
      await screen.findByRole("heading", { name: "반 만들기" });
      fireEvent.change(screen.getByLabelText("학교 이름"), { target: { value: "테스트" } });
      fireEvent.click(screen.getByRole("button", { name: "학교 검색" }));
      fireEvent.click(await screen.findByRole("button", { name: /테스트고등학교/ }));
      fireEvent.change(screen.getByLabelText("반 이름"), { target: { value: "1반" } });
      fireEvent.click(screen.getByRole("button", { name: "반 만들기" }));
      await waitFor(() => expect(auth.createClass).toHaveBeenCalledTimes(1));
      const key = idempotentCreateStorageKey("classes", "pending-teacher");
      expect(sessionStorage.getItem(key)).not.toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "로그아웃" }));
      await screen.findByText("로그인 화면");
      expect(sessionStorage.getItem(key)).toBeNull();
      sessionStorage.setItem(key, "new-session-record");
      await act(async () =>
        outcome === "failure"
          ? reject(new auth.ApiRequestError("NETWORK_ERROR", "연결 실패", 0))
          : finish({}),
      );
      expect(sessionStorage.getItem(key)).toBe("new-session-record");
      expect(screen.getByText("로그인 화면")).toBeInTheDocument();
      expect(screen.queryByText("반 관리 화면")).not.toBeInTheDocument();
    },
  );

  it.each([0, 401])(
    "keeps the original retry after failed logout and ignores the superseded create response %s",
    async (status) => {
      vi.spyOn(auth, "getBootstrap").mockResolvedValue(createClassBootstrap);
      vi.spyOn(auth, "searchSchools").mockResolvedValue({ schools: [SCHOOL] } as Awaited<
        ReturnType<typeof auth.searchSchools>
      >);
      let reject!: (value: unknown) => void;
      vi.spyOn(auth, "createClass").mockReturnValue(
        new Promise((_, fail) => {
          reject = fail;
        }),
      );
      vi.spyOn(auth, "logout").mockRejectedValue(new Error("로그아웃 실패"));
      renderPage();
      await screen.findByRole("heading", { name: "반 만들기" });
      fireEvent.change(screen.getByLabelText("학교 이름"), { target: { value: "테스트" } });
      fireEvent.click(screen.getByRole("button", { name: "학교 검색" }));
      fireEvent.click(await screen.findByRole("button", { name: /테스트고등학교/ }));
      fireEvent.change(screen.getByLabelText("반 이름"), { target: { value: "1반" } });
      fireEvent.click(screen.getByRole("button", { name: "반 만들기" }));
      const key = idempotentCreateStorageKey("classes", "pending-teacher");
      const original = sessionStorage.getItem(key);
      fireEvent.click(screen.getByRole("button", { name: "로그아웃" }));
      await screen.findByText("로그아웃 실패");
      expect(screen.getByRole("button", { name: "결과 다시 확인" })).toBeEnabled();
      await act(async () =>
        reject(
          new auth.ApiRequestError(
            status === 401 ? "UNAUTHENTICATED" : "NETWORK_ERROR",
            "늦은 오류",
            status,
          ),
        ),
      );
      expect(sessionStorage.getItem(key)).toBe(original);
      expect(screen.getByRole("button", { name: "결과 다시 확인" })).toBeEnabled();
      expect(screen.getByLabelText("반 이름")).toHaveValue("1반");
    },
  );

  it("unlocks school search after failed logout while ignoring its superseded response", async () => {
    vi.spyOn(auth, "getBootstrap").mockResolvedValue(createClassBootstrap);
    let finish!: (value: Awaited<ReturnType<typeof auth.searchSchools>>) => void;
    vi.spyOn(auth, "searchSchools")
      .mockReturnValueOnce(
        new Promise((resolve) => {
          finish = resolve;
        }),
      )
      .mockResolvedValue({ schools: [SCHOOL] } as Awaited<ReturnType<typeof auth.searchSchools>>);
    vi.spyOn(auth, "logout").mockRejectedValue(new Error("로그아웃 실패"));
    renderPage();
    await screen.findByRole("heading", { name: "반 만들기" });
    fireEvent.change(screen.getByLabelText("학교 이름"), { target: { value: "테스트" } });
    fireEvent.click(screen.getByRole("button", { name: "학교 검색" }));
    expect(screen.getByRole("button", { name: "학교 검색" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "로그아웃" }));
    await screen.findByText("로그아웃 실패");
    expect(screen.getByRole("button", { name: "학교 검색" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "학교 검색" }));
    await screen.findByRole("button", { name: /테스트고등학교/ });
    await act(async () =>
      finish({ schools: [{ ...SCHOOL, school_name: "이전검색학교" }] } as Awaited<
        ReturnType<typeof auth.searchSchools>
      >),
    );
    expect(screen.queryByRole("button", { name: /이전검색학교/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /테스트고등학교/ })).toBeVisible();
    expect(screen.getByRole("button", { name: "학교 검색" })).toBeEnabled();
  });

  it("focuses a creation error beside its retry action without turning a search error into a creation error", async () => {
    vi.spyOn(auth, "getBootstrap").mockResolvedValue(createClassBootstrap);
    vi.spyOn(auth, "searchSchools").mockResolvedValue({ schools: [SCHOOL] } as Awaited<
      ReturnType<typeof auth.searchSchools>
    >);
    vi.spyOn(auth, "createClass").mockRejectedValue(
      new auth.ApiRequestError("CLASS_FAILED", "반 생성 실패", 400),
    );
    renderPage();
    await screen.findByRole("heading", { name: "반 만들기" });
    fireEvent.change(screen.getByLabelText("학교 이름"), { target: { value: "테스트" } });
    fireEvent.click(screen.getByRole("button", { name: "학교 검색" }));
    fireEvent.click(await screen.findByRole("button", { name: /테스트고등학교/ }));
    fireEvent.change(screen.getByLabelText("반 이름"), { target: { value: "1반" } });
    fireEvent.click(screen.getByRole("button", { name: "반 만들기" }));
    const error = await screen.findByText("반 생성 실패");
    expect(error).toHaveFocus();
    const button = screen.getByRole("button", { name: "반 만들기" });
    expect(button).toHaveAttribute("aria-describedby", error.id);
    expect(error.closest("form")).toBe(button.closest("form"));
  });

  it("keeps header logout pending state and navigation while title and description stay ordered", async () => {
    let finishLogout!: (value: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      finishLogout = resolve;
    });
    vi.spyOn(globalThis, "fetch").mockImplementation((input) =>
      requestUrl(input) === "/api/v1/bootstrap"
        ? Promise.resolve(jsonResponse(createClassBootstrap))
        : pending,
    );
    renderPage();
    const title = await screen.findByRole("heading", { name: "반 만들기" });
    const description = screen.getByText(
      "학교를 검색해 선택하고 반 정보를 입력하면 반 초대 코드가 자동으로 발급됩니다.",
    );
    expect(
      title.compareDocumentPosition(description) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    const button = screen.getByRole("button", { name: "로그아웃" });
    expect(button).toHaveClass("h-11");
    fireEvent.click(button);
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
    finishLogout(jsonResponse({}));
    await screen.findByText("로그인 화면");
  });
  const originalScroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");
  afterEach(() => {
    window.sessionStorage.clear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    if (originalScroll)
      Object.defineProperty(HTMLElement.prototype, "scrollIntoView", originalScroll);
    else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  });

  it.each([false, true, "expired"] as const)(
    "ignores an older school completion while latest search is pending; error=%s",
    async (error) => {
      let oldResolve!: (response: Response) => void;
      let newResolve!: (response: Response) => void;
      const oldResponse = new Promise<Response>((resolve) => {
        oldResolve = resolve;
      });
      const newResponse = new Promise<Response>((resolve) => {
        newResolve = resolve;
      });
      vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
        const url = requestUrl(input);
        if (url === "/api/v1/bootstrap") return Promise.resolve(jsonResponse(createClassBootstrap));
        return url.includes("old") ? oldResponse : newResponse;
      });
      renderPage();
      await screen.findByRole("heading", { name: "반 만들기" });
      const query = screen.getByLabelText("학교 이름");
      fireEvent.change(query, { target: { value: "old" } });
      fireEvent.submit(query.closest("form")!);
      fireEvent.change(query, { target: { value: "new" } });
      fireEvent.submit(query.closest("form")!);
      await act(async () =>
        oldResolve(
          error
            ? jsonResponse(
                { error: { code: "SEARCH_FAILED", message: "이전 검색 오류" } },
                error === "expired" ? 401 : 500,
              )
            : jsonResponse({ schools: [SCHOOL] }),
        ),
      );
      await waitFor(() =>
        expect(screen.queryByRole("button", { name: /테스트고등학교/ })).not.toBeInTheDocument(),
      );
      expect(screen.getByRole("button", { name: "학교 검색" })).toBeDisabled();
      expect(screen.queryByText("이전 검색 오류")).not.toBeInTheDocument();
      await act(async () =>
        newResolve(jsonResponse({ schools: [{ ...SCHOOL, school_name: "최신고등학교" }] })),
      );
      expect(await screen.findByRole("button", { name: /최신고등학교/ })).toBeVisible();
    },
  );

  it("keeps the selected school while replacing pending search results", async () => {
    let lateResolve!: (response: Response) => void;
    const late = new Promise<Response>((resolve) => {
      lateResolve = resolve;
    });
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = requestUrl(input);
      if (url === "/api/v1/bootstrap") return Promise.resolve(jsonResponse(createClassBootstrap));
      return url.includes("late") ? late : Promise.resolve(jsonResponse({ schools: [SCHOOL] }));
    });
    renderPage();
    await screen.findByRole("heading", { name: "반 만들기" });
    const query = screen.getByLabelText("학교 이름");
    fireEvent.change(query, { target: { value: "first" } });
    fireEvent.submit(query.closest("form")!);
    fireEvent.click(await screen.findByRole("button", { name: /테스트고등학교/ }));
    fireEvent.change(query, { target: { value: "late" } });
    fireEvent.submit(query.closest("form")!);
    expect(screen.queryByRole("button", { name: /테스트고등학교/ })).toBeNull();
    expect(screen.getByRole("heading", { name: "반 정보 입력" })).toBeInTheDocument();
    await act(async () =>
      lateResolve(
        jsonResponse({
          schools: [{ ...SCHOOL, school_code: "9999999", school_name: "늦은고등학교" }],
        }),
      ),
    );
    expect(await screen.findByRole("button", { name: /늦은고등학교/ })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(screen.queryByRole("button", { name: /테스트고등학교/ })).toBeNull();
    expect(screen.getByRole("heading", { name: "반 정보 입력" })).toBeInTheDocument();
  });

  it.each([true, false])(
    "moves explicit school selection to step two, mobile=%s",
    async (mobile) => {
      vi.stubGlobal("matchMedia", () => ({ matches: mobile }));
      const scroll = vi.fn();
      Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
        configurable: true,
        value: scroll,
      });
      const focus = vi.spyOn(HTMLElement.prototype, "focus");
      vi.spyOn(globalThis, "fetch").mockImplementation((input) =>
        Promise.resolve(
          jsonResponse(
            requestUrl(input) === "/api/v1/bootstrap"
              ? createClassBootstrap
              : {
                  schools: [
                    SCHOOL,
                    { ...SCHOOL, school_code: "7010085", school_name: "다른고등학교" },
                  ],
                },
          ),
        ),
      );
      renderPage();
      await screen.findByRole("heading", { name: "반 만들기" });
      fireEvent.change(screen.getByLabelText("학교 이름"), { target: { value: "고등학교" } });
      fireEvent.click(screen.getByRole("button", { name: "학교 검색" }));
      fireEvent.click(await screen.findByRole("button", { name: /테스트고등학교/ }));
      expect(screen.getByRole("heading", { name: "반 정보 입력" })).toHaveFocus();
      expect(focus).toHaveBeenCalledWith({ preventScroll: true });
      expect(scroll).toHaveBeenCalledTimes(mobile ? 1 : 0);
      fireEvent.click(screen.getByRole("button", { name: /다른고등학교/ }));
      expect(screen.getByRole("heading", { name: "반 정보 입력" })).toHaveFocus();
      expect(scroll).toHaveBeenCalledTimes(mobile ? 2 : 0);
    },
  );

  it("does not focus a school restored for an uncertain request", async () => {
    persistIdempotentCreateAttempt(idempotentCreateStorageKey("classes", "pending-teacher"), {
      idempotencyKey: "00000000-0000-4000-8000-000000000001",
      serverDate: "2026-08-01",
      startedAt: Date.now(),
      request: {
        school: SCHOOL,
        request: {
          academic_year: 2026,
          grade: 1,
          name: "시험반",
          expected_student_count: 30,
          edu_office_code: SCHOOL.edu_office_code,
          school_code: SCHOOL.school_code,
        },
      },
    });
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse(createClassBootstrap));
    renderPage();
    await screen.findByRole("button", { name: "결과 다시 확인" });
    expect(focus).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "학교 변경" })).toBeDisabled();
  });

  it("expands mobile school search without changing selection, grade or focus", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((input) =>
      Promise.resolve(
        jsonResponse(
          requestUrl(input) === "/api/v1/bootstrap" ? createClassBootstrap : { schools: [SCHOOL] },
        ),
      ),
    );
    renderPage();
    await screen.findByRole("heading", { name: "반 만들기" });
    fireEvent.change(screen.getByLabelText("학교 이름"), { target: { value: "고등학교" } });
    fireEvent.click(screen.getByRole("button", { name: "학교 검색" }));
    fireEvent.click(await screen.findByRole("button", { name: /테스트고등학교/ }));
    fireEvent.change(screen.getByLabelText("학년"), { target: { value: "3" } });
    const heading = screen.getByRole("heading", { name: "반 정보 입력" });
    expect(heading).toHaveFocus();
    const button = screen.getByRole("button", { name: "학교 변경" });
    expect(button).toHaveAttribute("aria-controls", "class-school-search");
    expect(document.getElementById("class-school-search")).toHaveClass("hidden", "sm:block");
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    focus.mockClear();
    fireEvent.click(button);
    expect(document.getElementById("class-school-search")).not.toHaveClass("hidden");
    expect(screen.getByLabelText("학년")).toHaveValue("3");
    expect(screen.getByRole("button", { name: /테스트고등학교/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(focus).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "검색 접기" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });

  it("sends accounts that are not in the CREATE_CLASS step to bootstrap", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ ...createClassBootstrap, destination: "HOME" }),
    );
    renderPage();

    expect(await screen.findByText("계정 안내 화면")).toBeVisible();
  });

  it("redirects to login when the session is gone", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ error: { code: "UNAUTHENTICATED", message: "로그인이 필요합니다." } }, 401),
    );
    renderPage();

    expect(await screen.findByText("로그인 화면")).toBeVisible();
  });

  it("rejects a too-short school query before any request leaves", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(createClassBootstrap));
    renderPage();

    expect(await screen.findByRole("heading", { name: "반 만들기" })).toBeVisible();
    fireEvent.change(screen.getByPlaceholderText("학교 이름을 두 글자 이상 입력"), {
      target: { value: "테" },
    });
    fireEvent.click(screen.getByRole("button", { name: "학교 검색" }));

    expect(
      await screen.findByText("학교 이름은 2자 이상 100자 이하로 입력해 주세요."),
    ).toBeVisible();
    expect(
      fetchMock.mock.calls.some(([input]) => requestUrl(input).startsWith("/api/v1/schools")),
    ).toBe(false);
  });

  it("searches schools with the encoded query and lists the results", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = requestUrl(input);
      if (url === "/api/v1/bootstrap") return Promise.resolve(jsonResponse(createClassBootstrap));
      if (url.startsWith("/api/v1/schools")) {
        return Promise.resolve(jsonResponse({ schools: [SCHOOL] }));
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    renderPage();

    expect(await screen.findByRole("heading", { name: "반 만들기" })).toBeVisible();
    fireEvent.change(screen.getByPlaceholderText("학교 이름을 두 글자 이상 입력"), {
      target: { value: "테스트 고" },
    });
    fireEvent.click(screen.getByRole("button", { name: "학교 검색" }));

    expect(await screen.findByText("테스트고등학교")).toBeVisible();
    const searchCall = fetchMock.mock.calls.find(([input]) =>
      requestUrl(input).startsWith("/api/v1/schools"),
    );
    expect(requestUrl(searchCall?.[0] as RequestInfo)).toBe(
      "/api/v1/schools?q=%ED%85%8C%EC%8A%A4%ED%8A%B8%20%EA%B3%A0",
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "학교 검색" })).toBeEnabled());
  });
  it.each(["failure", "same", "different"])(
    "preserves the draft during school research and applies selection identity (%s)",
    async (outcome) => {
      vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("synthetic non-network fallback"));
      vi.spyOn(auth, "getBootstrap").mockResolvedValue(createClassBootstrap);
      let resolveSearch!: (value: Awaited<ReturnType<typeof auth.searchSchools>>) => void;
      let rejectSearch!: (error: Error) => void;
      const pending = new Promise<Awaited<ReturnType<typeof auth.searchSchools>>>(
        (resolve, reject) => {
          resolveSearch = resolve;
          rejectSearch = reject;
        },
      );
      const search = vi
        .spyOn(auth, "searchSchools")
        .mockResolvedValueOnce({ schools: [SCHOOL] } as Awaited<
          ReturnType<typeof auth.searchSchools>
        >)
        .mockReturnValueOnce(pending);
      const create = vi
        .spyOn(auth, "createClass")
        .mockRejectedValue(new auth.ApiRequestError("QA_SYNTHETIC", "합성 생성 차단", 400));
      renderPage();
      await screen.findByRole("heading", { name: "반 만들기" });
      const query = screen.getByLabelText("학교 이름");
      fireEvent.change(query, { target: { value: "테스트" } });
      fireEvent.click(screen.getByRole("button", { name: "학교 검색" }));
      fireEvent.click(await screen.findByRole("button", { name: /테스트고등학교/ }));
      fireEvent.change(screen.getByLabelText("학년"), { target: { value: "3" } });
      fireEvent.change(screen.getByLabelText("반 이름"), { target: { value: "작성 중인 반" } });
      fireEvent.change(screen.getByLabelText("예상 학생 수"), { target: { value: "24" } });
      fireEvent.click(screen.getByRole("button", { name: "학교 변경" }));
      fireEvent.change(query, { target: { value: "다른 학교" } });
      fireEvent.click(screen.getByRole("button", { name: "학교 검색" }));
      expect(screen.getByLabelText("학년")).toHaveValue("3");
      expect(screen.getByLabelText("반 이름")).toHaveValue("작성 중인 반");
      expect(screen.queryByRole("button", { name: /테스트고등학교/ })).toBeNull();
      const next =
        outcome === "different"
          ? {
              ...SCHOOL,
              school_code: "different",
              school_name: "새 초등학교",
              school_kind: "elementary",
            }
          : SCHOOL;
      await act(async () => {
        if (outcome === "failure") rejectSearch(new Error("합성 학교 검색 실패"));
        else resolveSearch({ schools: [next] } as Awaited<ReturnType<typeof auth.searchSchools>>);
      });
      if (outcome === "failure") {
        expect(screen.getByText("합성 학교 검색 실패")).toBeVisible();
        expect(screen.queryByRole("button", { name: /테스트고등학교/ })).toBeNull();
      } else {
        fireEvent.click(screen.getByRole("button", { name: new RegExp(next.school_name) }));
      }
      expect(screen.getByLabelText("학년")).toHaveValue(outcome === "different" ? "1" : "3");
      expect(screen.getByLabelText("반 이름")).toHaveValue("작성 중인 반");
      expect(screen.getByLabelText("예상 학생 수")).toHaveValue(24);
      fireEvent.click(screen.getByRole("button", { name: "반 만들기" }));
      await screen.findByText("합성 생성 차단");
      expect(create).toHaveBeenCalledOnce();
      expect(create.mock.calls[0]?.[0]).toMatchObject({
        school_code: next.school_code,
        grade: outcome === "different" ? 1 : 3,
        name: "작성 중인 반",
        expected_student_count: 24,
      });
      expect(search.mock.calls.map(([value]) => value)).toEqual(["테스트", "다른 학교"]);
    },
  );
});

describe("expected student count input", () => {
  afterEach(() => {
    window.sessionStorage.clear();
    vi.restoreAllMocks();
  });

  async function prepareCountInput() {
    vi.spyOn(auth, "getBootstrap").mockResolvedValue(createClassBootstrap);
    vi.spyOn(auth, "searchSchools").mockResolvedValue({ schools: [SCHOOL] } as Awaited<
      ReturnType<typeof auth.searchSchools>
    >);
    const create = vi
      .spyOn(auth, "createClass")
      .mockRejectedValue(new auth.ApiRequestError("QA_SYNTHETIC", "합성 생성 차단", 400));
    renderPage();
    await screen.findByRole("heading", { name: "반 만들기" });
    fireEvent.change(screen.getByLabelText("학교 이름"), { target: { value: "테스트" } });
    fireEvent.click(screen.getByRole("button", { name: "학교 검색" }));
    fireEvent.click(await screen.findByRole("button", { name: /테스트고등학교/ }));
    fireEvent.change(screen.getByLabelText("반 이름"), { target: { value: "1반" } });
    return { count: screen.getByLabelText("예상 학생 수") as HTMLInputElement, create };
  }

  it("keeps a cleared count empty and submits the replacement without a leading zero", async () => {
    const { count, create } = await prepareCountInput();
    fireEvent.change(count, { target: { value: "" } });
    expect(count.value).toBe("");
    fireEvent.change(count, { target: { value: "2" } });
    expect(count.value).toBe("2");
    fireEvent.click(screen.getByRole("button", { name: "반 만들기" }));
    await screen.findByText("합성 생성 차단");
    expect(create).toHaveBeenCalledOnce();
    expect(create.mock.calls[0]?.[0].expected_student_count).toBe(2);
  });

  it.each(["", "0", "-1", "61", "200", "1.5", "1e-1", "1e3"])(
    "does not send invalid count %j even when native form validation is bypassed",
    async (value) => {
      const { count, create } = await prepareCountInput();
      fireEvent.change(count, { target: { value } });
      expect(count.checkValidity()).toBe(false);
      fireEvent.submit(count.closest("form")!);
      const error = await screen.findByText(
        "예상 학생 수는 1명 이상 60명 이하의 정수로 입력해 주세요.",
      );
      expect(error).toHaveFocus();
      expect(create).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["1", 1],
    ["60", 60],
    ["2e1", 20],
  ] as const)("submits valid count %s as number %s", async (value, expected) => {
    const { count, create } = await prepareCountInput();
    fireEvent.change(count, { target: { value } });
    expect(count.checkValidity()).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "반 만들기" }));
    await screen.findByText("합성 생성 차단");
    expect(create).toHaveBeenCalledOnce();
    expect(create.mock.calls[0]?.[0].expected_student_count).toBe(expected);
  });
});

describe("school research final submission guard", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each(["success", "failure"])(
    "blocks the preserved old school while research is pending and releases after %s",
    async (outcome) => {
      vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("synthetic non-network fallback"));
      vi.spyOn(auth, "getBootstrap").mockResolvedValue(createClassBootstrap);
      let resolveSearch!: (value: Awaited<ReturnType<typeof auth.searchSchools>>) => void;
      let rejectSearch!: (error: Error) => void;
      const pending = new Promise<Awaited<ReturnType<typeof auth.searchSchools>>>(
        (resolve, reject) => {
          resolveSearch = resolve;
          rejectSearch = reject;
        },
      );
      const search = vi
        .spyOn(auth, "searchSchools")
        .mockResolvedValueOnce({ schools: [SCHOOL] } as Awaited<
          ReturnType<typeof auth.searchSchools>
        >)
        .mockReturnValueOnce(pending);
      const create = vi
        .spyOn(auth, "createClass")
        .mockRejectedValue(new auth.ApiRequestError("QA_SYNTHETIC", "합성 생성 차단", 400));
      renderPage();
      await screen.findByRole("heading", { name: "반 만들기" });
      const query = screen.getByLabelText("학교 이름");
      fireEvent.change(query, { target: { value: "학교 A" } });
      fireEvent.click(screen.getByRole("button", { name: "학교 검색" }));
      fireEvent.click(await screen.findByRole("button", { name: /테스트고등학교/ }));
      fireEvent.change(screen.getByLabelText("학년"), { target: { value: "3" } });
      fireEvent.change(screen.getByLabelText("반 이름"), { target: { value: "작성 중인 반" } });
      fireEvent.change(screen.getByLabelText("예상 학생 수"), { target: { value: "24" } });
      fireEvent.click(screen.getByRole("button", { name: "학교 변경" }));
      const submit = screen.getByRole("button", { name: "반 만들기" });
      expect(submit).toBeEnabled();
      fireEvent.change(query, { target: { value: "학교 B" } });
      fireEvent.click(screen.getByRole("button", { name: "학교 검색" }));
      await act(async () => {
        fireEvent.click(submit);
        fireEvent.submit(submit.closest("form")!);
      });
      expect(create.mock.calls.map(([request]) => request)).toEqual([]);
      expect(submit).toBeDisabled();
      expect(screen.getByLabelText("학년")).toHaveValue("3");
      expect(screen.getByLabelText("반 이름")).toHaveValue("작성 중인 반");
      expect(screen.getByLabelText("예상 학생 수")).toHaveValue(24);
      const otherSchool = { ...SCHOOL, school_code: "7010999", school_name: "학교 B 고등학교" };
      await act(async () => {
        if (outcome === "success")
          resolveSearch({ schools: [otherSchool] } as Awaited<
            ReturnType<typeof auth.searchSchools>
          >);
        else rejectSearch(new Error("합성 학교 B 검색 실패"));
      });
      expect(submit).toBeEnabled();
      if (outcome === "success")
        fireEvent.click(screen.getByRole("button", { name: /학교 B 고등학교/ }));
      else expect(screen.getByText("합성 학교 B 검색 실패")).toBeVisible();
      fireEvent.click(submit);
      await screen.findByText("합성 생성 차단");
      expect(create).toHaveBeenCalledOnce();
      expect(create.mock.calls[0]?.[0]).toMatchObject({
        school_code: outcome === "success" ? otherSchool.school_code : SCHOOL.school_code,
        grade: outcome === "success" ? 1 : 3,
        name: "작성 중인 반",
        expected_student_count: 24,
      });
      expect(search.mock.calls.map(([value]) => value)).toEqual(["학교 A", "학교 B"]);
    },
  );
});

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { BootstrapResponse, HomeResponse } from "../../api/auth";
// 옛 서버가 보내던 자리·모둠·당번 권한(P-016 은퇴, 2026-10-03 타입에서 제거). 화면이 무시하는지 계속 지킨다.
const RETIRED_VIEW_ACTIONS = [
  "VIEW_SEAT_DRAWS",
  "VIEW_TEAM_DRAWS",
  "VIEW_DUTY_ROSTERS",
] as unknown as BootstrapResponse["allowed_actions"];

import { HomePage } from "./home-page";

function bootstrapPayload(classId = "class-1"): BootstrapResponse {
  return {
    account: {
      display_name: "학생 하나",
      email_verified: true,
      is_active: true,
    },
    allowed_actions: ["CHANGE_PASSWORD", "LOGOUT", "VIEW_CLASS", ...RETIRED_VIEW_ACTIONS],
    current_class: { id: classId, name: `${classId} 반`, status: "active" },
    current_membership: {
      class_id: classId,
      display_name_in_class: "학생 하나",
      id: `membership-${classId}`,
      role: "student",
      status: "approved",
      student_number: 1,
    },
    destination: "HOME",
    last_membership_status: null,
    last_status_reason: null,
    server_today: "2026-09-01",
    teacher_profile: null,
  };
}

function teacherBootstrapPayload(classId = "class-1"): BootstrapResponse {
  const studentBootstrap = bootstrapPayload(classId);
  return {
    ...studentBootstrap,
    allowed_actions: ["CHANGE_PASSWORD", "LOGOUT", "VIEW_CLASS", "MANAGE_CLASS"],
    current_membership: {
      ...studentBootstrap.current_membership!,
      role: "teacher",
      student_number: null,
    },
    teacher_profile: { status: "active", temporary_password_must_change: false },
  };
}

function LocationProbe(): React.JSX.Element {
  const location = useLocation();
  return <output data-testid="location-probe">{location.pathname}</output>;
}

const homePayload = {
  attendance: { data: null, status: "empty" },
  meal: { data: null, status: "empty" },
  notices: { data: [], status: "empty" },
  pending_member_count: null,
  reminders: { data: [], status: "empty" },
  schedules: { data: [], status: "empty" },
  server_today: "2026-09-01",
  supplies: { data: [], status: "empty" },
  teacher_followups: null,
} as HomeResponse;

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    headers: { "Content-Type": "application/json" },
    status,
  });
}

const HELP_REQUESTS_OPEN = "/api/v1/help-requests?status=open";
// 홈의 '지난 반 기록' 입구가 지난 반 수를 한 번 조회한다(S1). 홈 본문 요청과 따로 센다.
const PAST_CLASSES = "/api/v1/past-classes";

function requestedUrl(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
}

function renderHome(): void {
  render(
    <MemoryRouter initialEntries={["/home"]}>
      <HomePage />
      <LocationProbe />
    </MemoryRouter>,
  );
}

describe("HomePage request and authorization boundaries", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each(["student", "teacher"] as const)(
    "never requests retired features for %s even when old bootstrap allows them",
    async (role) => {
      const bootstrap = role === "student" ? bootstrapPayload() : teacherBootstrapPayload();
      bootstrap.allowed_actions.push(
        ...([
          "MANAGE_SEAT_DRAWS",
          "MANAGE_TEAM_DRAWS",
          "MANAGE_DUTY_ROSTERS",
        ] as unknown as BootstrapResponse["allowed_actions"]),
      );
      const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
        if (requestedUrl(input) === PAST_CLASSES) return jsonResponse({ items: [] });
        const url = requestedUrl(input);
        if (url === "/api/v1/bootstrap") return jsonResponse(bootstrap);
        if (url === "/api/v1/home") return jsonResponse(homePayload);
        // 교사 홈의 도움 요청 입구는 현재 기능이라 건수를 한 번 조회한다.
        if (role === "teacher" && url === HELP_REQUESTS_OPEN) return jsonResponse({ items: [] });
        throw new Error("Retired API must not be requested");
      });
      renderHome();
      await screen.findByText("class-1 반");
      fireEvent.click(screen.getByRole("button", { name: "홈 새로고침" }));
      await waitFor(() =>
        expect(
          fetchMock.mock.calls.filter(([input]) => requestedUrl(input) === "/api/v1/home"),
        ).toHaveLength(2),
      );
      expect(new Set(fetchMock.mock.calls.map(([input]) => requestedUrl(input)))).toEqual(
        new Set([
          "/api/v1/bootstrap",
          "/api/v1/home",
          PAST_CLASSES,
          ...(role === "teacher" ? [HELP_REQUESTS_OPEN] : []),
        ]),
      );
      for (const path of ["/seating", "/grouping", "/duty"])
        expect(document.querySelector(`a[href="${path}"]`)).not.toBeInTheDocument();
      expect(screen.queryByText(/교실 배치|당번표|모둠표/u)).not.toBeInTheDocument();
    },
  );

  it("keeps an initial core failure on the full-page failure path", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) =>
        requestedUrl(input) === "/api/v1/bootstrap"
          ? jsonResponse(bootstrapPayload())
          : jsonResponse(
              { error: { code: "HOME_LOOKUP_FAILED", message: "private failure" } },
              503,
            ),
      );
    renderHome();
    expect(await screen.findByRole("heading", { name: "홈을 열지 못했어요." })).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent("홈을 불러오지 못했어요.");
    expect(screen.queryByText("private failure")).not.toBeInTheDocument();
    expect(fetchMock.mock.calls).toHaveLength(2);
  });

  it.each([
    [401, "/login"],
    [403, "/bootstrap"],
  ] as const)("clears cached private home after core %s", async (status, destination) => {
    let reads = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (requestedUrl(input) === PAST_CLASSES) return jsonResponse({ items: [] });
      if (requestedUrl(input) === "/api/v1/bootstrap") return jsonResponse(bootstrapPayload());
      return ++reads === 1
        ? jsonResponse(homePayload)
        : jsonResponse(
            { error: { code: "HOME_ACCESS_REVOKED", message: "private access" } },
            status,
          );
    });
    renderHome();
    await screen.findByText("오늘 등록된 급식이 없어요.");
    fireEvent.click(screen.getByRole("button", { name: "홈 새로고침" }));
    await waitFor(() =>
      expect(screen.getByTestId("location-probe")).toHaveTextContent(destination),
    );
    expect(screen.queryByText("class-1 반")).not.toBeInTheDocument();
    expect(screen.queryByText("오늘 등록된 급식이 없어요.")).not.toBeInTheDocument();
    expect(screen.queryByText("private access")).not.toBeInTheDocument();
  });

  it("keeps same-context stale home after a core 5xx", async () => {
    let reads = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) =>
      requestedUrl(input) === PAST_CLASSES
        ? jsonResponse({ items: [] })
        : requestedUrl(input) === "/api/v1/bootstrap"
          ? jsonResponse(bootstrapPayload())
          : ++reads === 1
            ? jsonResponse(homePayload)
            : jsonResponse(
                { error: { code: "HOME_LOOKUP_FAILED", message: "private failure" } },
                503,
              ),
    );
    renderHome();
    await screen.findByText("오늘 등록된 급식이 없어요.");
    fireEvent.click(screen.getByRole("button", { name: "홈 새로고침" }));
    expect(await screen.findByText("최신 홈 정보를 확인하지 못했어요.")).toBeVisible();
    expect(screen.getByText("오늘 등록된 급식이 없어요.")).toBeVisible();
    expect(screen.getByTestId("location-probe")).toHaveTextContent("/home");
  });

  it("deduplicates overlapping manual and visibility reloads", async () => {
    let reads = 0,
      bootstraps = 0;
    let finish: ((response: Response) => void) | undefined;
    const pending = new Promise<Response>((resolve) => {
      finish = resolve;
    });
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (requestedUrl(input) === PAST_CLASSES) return jsonResponse({ items: [] });
      if (requestedUrl(input) === "/api/v1/bootstrap") {
        bootstraps++;
        return jsonResponse(bootstrapPayload());
      }
      return ++reads === 1 ? jsonResponse(homePayload) : pending;
    });
    renderHome();
    await screen.findByText("오늘 등록된 급식이 없어요.");
    fireEvent.click(screen.getByRole("button", { name: "홈 새로고침" }));
    fireEvent(document, new Event("visibilitychange"));
    await waitFor(() => expect(reads).toBe(2));
    expect(bootstraps).toBe(2);
    await act(async () => finish?.(jsonResponse(homePayload)));
    expect(reads).toBe(2);
  });

  it("removes old-class cards as soon as new bootstrap is known even if its home fails", async () => {
    let bootstraps = 0,
      reads = 0;
    let finish: ((response: Response) => void) | undefined;
    const pending = new Promise<Response>((resolve) => {
      finish = resolve;
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (requestedUrl(input) === PAST_CLASSES) return jsonResponse({ items: [] });
      if (requestedUrl(input) === "/api/v1/bootstrap")
        return jsonResponse(bootstrapPayload(++bootstraps === 1 ? "class-old" : "class-new"));
      return ++reads === 1 ? jsonResponse(homePayload) : pending;
    });
    renderHome();
    await screen.findByText("class-old 반");
    fireEvent.click(screen.getByRole("button", { name: "홈 새로고침" }));
    await waitFor(() => expect(reads).toBe(2));
    expect(screen.queryByText("class-old 반")).not.toBeInTheDocument();
    expect(screen.queryByText("오늘 등록된 급식이 없어요.")).not.toBeInTheDocument();
    await act(async () =>
      finish?.(
        jsonResponse({ error: { code: "HOME_LOOKUP_FAILED", message: "private new class" } }, 503),
      ),
    );
    expect(await screen.findByRole("heading", { name: "홈을 열지 못했어요." })).toBeVisible();
  });

  it("switches role without retaining retired student surfaces", async () => {
    let bootstraps = 0;
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) =>
        requestedUrl(input) === "/api/v1/bootstrap"
          ? jsonResponse(++bootstraps === 1 ? bootstrapPayload() : teacherBootstrapPayload())
          : jsonResponse(homePayload),
      );
    renderHome();
    await screen.findByText("학생 홈");
    fireEvent.click(screen.getByRole("button", { name: "홈 새로고침" }));
    await waitFor(() => expect(document.querySelector("[data-teacher-home]")).toBeInTheDocument());
    expect(document.querySelector("[data-student-home]")).not.toBeInTheDocument();
    expect(
      fetchMock.mock.calls.every(([input]) =>
        ["/api/v1/bootstrap", "/api/v1/home", HELP_REQUESTS_OPEN, PAST_CLASSES].includes(
          requestedUrl(input),
        ),
      ),
    ).toBe(true);
  });
});

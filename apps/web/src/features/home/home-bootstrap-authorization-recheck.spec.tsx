import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { BootstrapResponse } from "../../api/auth";
// 옛 서버가 보내던 자리·모둠·당번 권한(P-016 은퇴, 2026-10-03 타입에서 제거). 화면이 무시하는지 계속 지킨다.
const RETIRED_VIEW_ACTIONS = [
  "VIEW_SEAT_DRAWS",
  "VIEW_TEAM_DRAWS",
  "VIEW_DUTY_ROSTERS",
] as unknown as BootstrapResponse["allowed_actions"];

import { BootstrapPage } from "../bootstrap/bootstrap-page";
import {
  createHomeAuthorizationRecheckRouteState,
  HOME_AUTHORIZATION_RECHECK_REASON,
} from "../bootstrap/bootstrap-route-state";
import { HomePage } from "./home-page";

function bootstrapPayload(): BootstrapResponse {
  return {
    account: {
      display_name: "학생 하나",
      email_verified: true,
      is_active: true,
    },
    allowed_actions: ["CHANGE_PASSWORD", "LOGOUT", "VIEW_CLASS", ...RETIRED_VIEW_ACTIONS],
    current_class: { id: "class-private", name: "비공개 1반", status: "active" },
    current_membership: {
      class_id: "class-private",
      display_name_in_class: "학생 하나",
      id: "membership-private",
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

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    headers: { "Content-Type": "application/json" },
    status,
  });
}

function requestedUrl(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
}

function AuthorizationRoutes(): React.JSX.Element {
  return (
    <Routes>
      <Route element={<HomePage />} path="/home" />
      <Route element={<BootstrapPage />} path="/bootstrap" />
      <Route element={<p>로그인 화면</p>} path="/login" />
    </Routes>
  );
}

function inviteBootstrapPayload(): BootstrapResponse {
  return {
    ...bootstrapPayload(),
    allowed_actions: ["CHANGE_PASSWORD", "LOGOUT"],
    current_class: null,
    current_membership: null,
    destination: "ENTER_INVITE_CODE",
  };
}

function HistoryControls(): React.JSX.Element {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <button onClick={() => void navigate(-1)} type="button">
        뒤로
      </button>
      <button onClick={() => void navigate(1)} type="button">
        앞으로
      </button>
      <output data-testid="history-entry">{location.key}</output>
    </>
  );
}

describe("Home and bootstrap authorization recheck", () => {
  afterEach(() => {
    sessionStorage.clear();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("revalidates marked and unmarked same-path history entries while preserving same-key back", async () => {
    const marker = createHomeAuthorizationRecheckRouteState();
    let requestCount = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      // '지난 반 기록' 입구 조회는 교대로 돌려주는 계정 상태 응답 순서에 끼우지 않는다(S1).
      if (String(input instanceof Request ? input.url : input).includes("/past-classes"))
        return Promise.resolve(jsonResponse({ items: [] }));
      requestCount += 1;
      return Promise.resolve(
        jsonResponse(requestCount % 2 === 1 ? inviteBootstrapPayload() : bootstrapPayload()),
      );
    });

    render(
      <MemoryRouter
        initialEntries={[
          {
            hash: "",
            key: "unmarked-entry",
            pathname: "/bootstrap",
            search: "",
            state: null,
          },
          {
            hash: "",
            key: "marked-entry",
            pathname: "/bootstrap",
            search: "",
            state: marker,
          },
        ]}
        initialIndex={0}
      >
        <HistoryControls />
        <AuthorizationRoutes />
      </MemoryRouter>,
    );

    expect(await screen.findByRole("heading", { name: "반에 참여해 주세요" })).toBeVisible();
    expect(screen.getByTestId("history-entry")).toHaveTextContent("unmarked-entry");

    fireEvent.click(screen.getByRole("button", { name: "앞으로" }));
    expect(
      await screen.findByRole("heading", { name: "홈 화면 권한을 다시 확인해 주세요." }),
    ).toBeVisible();
    expect(screen.getByTestId("history-entry")).toHaveTextContent("marked-entry");

    fireEvent.click(screen.getByRole("button", { name: "뒤로" }));
    expect(await screen.findByRole("heading", { name: "반에 참여해 주세요" })).toBeVisible();
    expect(screen.getByTestId("history-entry")).toHaveTextContent("unmarked-entry");

    fireEvent.click(screen.getByRole("button", { name: "앞으로" }));
    expect(
      await screen.findByRole("heading", { name: "홈 화면 권한을 다시 확인해 주세요." }),
    ).toBeVisible();
    expect(screen.getByTestId("history-entry")).toHaveTextContent("marked-entry");
    expect(requestCount).toBe(4);
  });

  it("accepts an issued marker after a same-entry refresh remount", async () => {
    const marker = createHomeAuthorizationRecheckRouteState();
    const entry = {
      hash: "",
      key: "refresh-entry",
      pathname: "/bootstrap",
      search: "",
      state: marker,
    };
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(() => Promise.resolve(jsonResponse(bootstrapPayload())));

    const first = render(
      <StrictMode>
        <MemoryRouter initialEntries={[entry]}>
          <AuthorizationRoutes />
        </MemoryRouter>
      </StrictMode>,
    );
    expect(
      await screen.findByRole("heading", { name: "홈 화면 권한을 다시 확인해 주세요." }),
    ).toBeVisible();
    first.unmount();

    render(
      <StrictMode>
        <MemoryRouter initialEntries={[{ ...entry, state: structuredClone(marker) }]}>
          <AuthorizationRoutes />
        </MemoryRouter>
      </StrictMode>,
    );
    expect(
      await screen.findByRole("heading", { name: "홈 화면 권한을 다시 확인해 주세요." }),
    ).toBeVisible();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects a directly injected marker without false mismatch and recovers a normal HOME", async () => {
    let requestCount = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      requestCount += 1;
      return Promise.resolve(jsonResponse(bootstrapPayload()));
    });

    render(
      <MemoryRouter
        initialEntries={[
          {
            hash: "",
            key: "forged-entry",
            pathname: "/bootstrap",
            search: "",
            state: {
              nonce: "caller-controlled",
              reason: HOME_AUTHORIZATION_RECHECK_REASON,
            },
          },
        ]}
      >
        <Routes>
          <Route element={<BootstrapPage />} path="/bootstrap" />
          <Route element={<p>실제 홈 화면</p>} path="/home" />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByText("계정 상태를 확인하지 못했어요.")).toBeVisible();
    expect(screen.queryByText("홈 화면 권한을 다시 확인해 주세요.")).not.toBeInTheDocument();
    expect(
      screen.getByText("이 주소는 더 이상 쓸 수 없어요. 처음 화면에서 다시 시작해 주세요."),
    ).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
    expect(await screen.findByText("실제 홈 화면")).toBeVisible();
    expect(requestCount).toBe(2);
  });

  it("allows an unmarked direct bootstrap entry to reach a normal HOME", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse(bootstrapPayload()));

    render(
      <MemoryRouter initialEntries={["/bootstrap"]}>
        <Routes>
          <Route element={<BootstrapPage />} path="/bootstrap" />
          <Route element={<p>실제 홈 화면</p>} path="/home" />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByText("실제 홈 화면")).toBeVisible();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("bounds persistent HOME plus Home 403 and makes each manual retry a single bootstrap request", async () => {
    let bootstrapRequestCount = 0;
    let homeRequestCount = 0;
    let resolveManualRetry: ((response: Response) => void) | undefined;
    const manualRetryResponse = new Promise<Response>((resolve) => {
      resolveManualRetry = resolve;
    });

    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = requestedUrl(input);
      if (url === "/api/v1/bootstrap") {
        bootstrapRequestCount += 1;
        if (bootstrapRequestCount === 3) return manualRetryResponse;
        return Promise.resolve(jsonResponse(bootstrapPayload()));
      }
      if (url === "/api/v1/home") {
        homeRequestCount += 1;
        return Promise.resolve(
          jsonResponse(
            { error: { code: "HOME_ACCESS_REVOKED", message: "raw private permission detail" } },
            403,
          ),
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    render(
      <MemoryRouter initialEntries={["/home"]}>
        <AuthorizationRoutes />
      </MemoryRouter>,
    );

    expect(
      await screen.findByRole("heading", { name: "홈 화면 권한을 다시 확인해 주세요." }),
    ).toBeVisible();
    expect(bootstrapRequestCount).toBe(2);
    expect(homeRequestCount).toBe(1);
    expect(screen.queryByText("비공개 1반")).not.toBeInTheDocument();
    expect(screen.queryByText("raw private permission detail")).not.toBeInTheDocument();

    const retry = screen.getByRole("button", { name: "다시 확인" });
    fireEvent.click(retry);
    fireEvent.click(retry);
    await waitFor(() => expect(bootstrapRequestCount).toBe(3));
    expect(homeRequestCount).toBe(1);

    await act(async () => {
      resolveManualRetry?.(jsonResponse(bootstrapPayload()));
      await Promise.resolve();
    });

    expect(
      await screen.findByRole("heading", { name: "홈 화면 권한을 다시 확인해 주세요." }),
    ).toBeVisible();
    expect(bootstrapRequestCount).toBe(3);
    expect(homeRequestCount).toBe(1);
  });

  it("keeps bootstrap 403 and 5xx failures generic and single-flight while retrying", async () => {
    let requestCount = 0;
    let resolveRetry: ((response: Response) => void) | undefined;
    const retryResponse = new Promise<Response>((resolve) => {
      resolveRetry = resolve;
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      requestCount += 1;
      if (requestCount === 1) {
        return Promise.resolve(
          jsonResponse(
            { error: { code: "PRIVATE_BOOTSTRAP_REASON", message: "raw bootstrap 403 detail" } },
            403,
          ),
        );
      }
      return retryResponse;
    });

    render(
      <MemoryRouter initialEntries={["/bootstrap"]}>
        <AuthorizationRoutes />
      </MemoryRouter>,
    );

    expect(await screen.findByText("계정 상태를 확인하지 못했어요.")).toBeVisible();
    expect(screen.queryByText("raw bootstrap 403 detail")).not.toBeInTheDocument();
    const retry = screen.getByRole("button", { name: "다시 시도" });
    fireEvent.click(retry);
    fireEvent.click(retry);
    await waitFor(() => expect(requestCount).toBe(2));

    await act(async () => {
      resolveRetry?.(
        jsonResponse(
          { error: { code: "PRIVATE_SERVER_FAILURE", message: "raw bootstrap 5xx detail" } },
          503,
        ),
      );
      await Promise.resolve();
    });

    expect(await screen.findByText("계정 상태를 확인하지 못했어요.")).toBeVisible();
    expect(screen.queryByText("raw bootstrap 5xx detail")).not.toBeInTheDocument();
    expect(requestCount).toBe(2);
  });
});

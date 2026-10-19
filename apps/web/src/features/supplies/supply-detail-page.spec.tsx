import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SupplyDetailPage } from "./supply-detail-page";
import { itemListOriginState, rememberItemListPosition } from "../layout/item-list-history";

const teacherBootstrap = {
  account: { email_verified: true, is_active: true },
  allowed_actions: ["CHANGE_PASSWORD", "LOGOUT", "VIEW_CLASS", "MANAGE_CLASS"],
  current_class: { id: "1", name: "테스트 1반", status: "active" },
  current_membership: {
    class_id: "1",
    id: "1",
    role: "teacher",
    status: "approved",
  },
  destination: "HOME",
  last_membership_status: null,
  last_status_reason: null,
  server_today: "2026-07-14",
  teacher_profile: { status: "active", temporary_password_must_change: false },
};

const supply = {
  category: "general",
  content_revision: "2",
  description: "자와 컴퍼스를 함께 가져오세요.",
  id: "17",
  needed_on: "2026-07-15",
  row_version: "4",
  title: "수학 준비물",
};

function jsonResponse(body: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function requestUrl(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
}

function SuppliesRouteProbe(): React.JSX.Element {
  const location = useLocation();
  return <output aria-label="준비물 목록 검색 조건">{location.search}</output>;
}

function renderDetail(
  role: "student" | "teacher" = "teacher",
  options: {
    deleteFails?: boolean;
    hash?: string;
    originEntryKey?: string;
    supplyOverride?: Partial<typeof supply>;
  } = {},
) {
  const responseSupply = { ...supply, ...options.supplyOverride };
  vi.spyOn(Document.prototype, "cookie", "get").mockReturnValue(
    "__Host-classhub_csrf=test-csrf-token",
  );
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const url = requestUrl(input);
    if (url === "/api/v1/bootstrap") {
      return Promise.resolve(
        jsonResponse(
          role === "teacher"
            ? teacherBootstrap
            : {
                ...teacherBootstrap,
                allowed_actions: ["CHANGE_PASSWORD", "LOGOUT", "LEAVE_CLASS", "VIEW_CLASS"],
                current_membership: { ...teacherBootstrap.current_membership, role: "student" },
                teacher_profile: null,
              },
        ),
      );
    }
    if (url === "/api/v1/supplies/17" && (init?.method === undefined || init.method === "GET")) {
      return Promise.resolve(
        jsonResponse(
          role === "student"
            ? { ...responseSupply, check_state: "modified_unconfirmed" }
            : responseSupply,
          200,
          { ETag: '"4"' },
        ),
      );
    }
    if (url === "/api/v1/supplies/17/checks?state=unchecked") {
      return Promise.resolve(
        jsonResponse({
          content_revision: responseSupply.content_revision,
          counts: { checked: 1, unchecked: 2, modified_unconfirmed: 0 },
          items: [
            {
              member_id: "2",
              display_name: "학생 하나",
              student_number: 1,
              check_state: "unchecked",
            },
          ],
          last_reminder_requested_at: null,
          next_cursor: null,
          server_today: "2026-07-14",
        }),
      );
    }
    if (url === "/api/v1/supplies/17/check" && init?.method === "PUT") {
      return Promise.resolve(
        jsonResponse({ supply_id: "17", check_state: "checked", content_revision: "2" }),
      );
    }
    if (url === "/api/v1/supplies/17" && init?.method === "DELETE") {
      if (options.deleteFails) {
        return Promise.resolve(
          jsonResponse(
            {
              error: {
                code: "INTERNAL_ERROR",
                message: "삭제 테스트 오류",
                request_id: "request-1",
              },
            },
            500,
          ),
        );
      }
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    throw new Error(`Unexpected URL: ${url}`);
  });

  const initialEntries =
    options.originEntryKey === undefined
      ? [`/supplies/17${options.hash ?? ""}`]
      : [
          { key: options.originEntryKey, pathname: "/supplies", search: "?scope=past&from=kept" },
          {
            pathname: "/supplies/17",
            state: itemListOriginState("supplies", options.originEntryKey),
          },
        ];
  if (options.originEntryKey !== undefined) {
    rememberItemListPosition("supplies", options.originEntryKey, "17", 320);
  }

  render(
    <MemoryRouter initialEntries={initialEntries} initialIndex={initialEntries.length - 1}>
      <Routes>
        <Route element={<SupplyDetailPage />} path="/supplies/:supplyId" />
        <Route element={<SuppliesRouteProbe />} path="/supplies" />
      </Routes>
    </MemoryRouter>,
  );
  return fetchMock;
}

async function openDeletePanel(): Promise<HTMLElement> {
  const disclosure = await screen.findByRole("button", { name: "준비물 삭제 옵션" });
  expect(disclosure).toHaveAttribute("aria-expanded", "false");
  fireEvent.click(disclosure);
  expect(disclosure).toHaveAttribute("aria-expanded", "true");
  return disclosure;
}

describe("SupplyDetailPage", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps the teacher shell and page heading while the supply load waits and fails", async () => {
    let resolveSupply!: (response: Response) => void;
    const pendingSupply = new Promise<Response>((resolve) => {
      resolveSupply = resolve;
    });
    let supplyRequestCount = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = requestUrl(input);
      if (url === "/api/v1/public/system-state") {
        return Promise.resolve(jsonResponse({ maintenance: false, announcement: null }));
      }
      if (url === "/api/v1/bootstrap") {
        return Promise.resolve(jsonResponse(teacherBootstrap));
      }
      if (url === "/api/v1/supplies/17") {
        supplyRequestCount += 1;
        return supplyRequestCount === 1
          ? pendingSupply
          : Promise.resolve(jsonResponse(supply, 200, { ETag: '"4"' }));
      }
      if (url === "/api/v1/supplies/17/checks?state=unchecked") {
        return Promise.resolve(
          jsonResponse({
            content_revision: supply.content_revision,
            counts: { checked: 0, modified_unconfirmed: 0, unchecked: 0 },
            items: [],
            last_reminder_requested_at: null,
            next_cursor: null,
            server_today: "2026-07-14",
          }),
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    render(
      <MemoryRouter initialEntries={["/supplies/17"]}>
        <Routes>
          <Route element={<SupplyDetailPage />} path="/supplies/:supplyId" />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() =>
      expect(screen.getAllByRole("navigation", { name: "주요 메뉴" })).toHaveLength(2),
    );
    expect(screen.getByRole("heading", { level: 1, name: "준비물·숙제" })).toBeVisible();
    expect(
      screen.getByText("안내 내용을 불러오고 있어요.").closest('[role="status"]'),
    ).toBeVisible();

    await act(async () => {
      resolveSupply(
        jsonResponse(
          {
            error: {
              code: "QA_FORCED_503",
              message: "INTERNAL_QA_DIAGNOSTIC private_supply_table",
              request_id: "qa-supply-load",
            },
          },
          503,
        ),
      );
    });

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("안내 내용을 불러오지 못했어요.");
    expect(screen.getByRole("heading", { level: 1, name: "준비물·숙제" })).toBeVisible();
    expect(screen.getAllByRole("navigation", { name: "주요 메뉴" })).toHaveLength(2);
    expect(screen.queryByText(/private_supply_table/u)).not.toBeInTheDocument();

    const retry = within(alert).getByRole("button", { name: "다시 불러오기" });
    expect(retry).toHaveClass("ui-button-primary");
    expect(retry).not.toHaveClass("ui-button-danger");
    expect(within(alert).getByRole("button", { name: "목록으로 돌아가기" })).toHaveClass(
      "ui-button-secondary",
    );

    fireEvent.click(retry);
    expect(await screen.findByRole("heading", { level: 1, name: supply.title })).toBeVisible();
    expect(supplyRequestCount).toBe(2);
  });

  it("shows teacher edit/check management and restores focus when editing is cancelled", async () => {
    renderDetail();

    expect(await screen.findByRole("heading", { name: "수학 준비물", level: 1 })).toBeVisible();
    expect(screen.getByText("선생님이 글을 고쳤어요")).toBeVisible();
    expect(screen.queryByText(/번째 내용/u)).not.toBeInTheDocument();
    expect(await screen.findByText("학생 하나")).toBeVisible();
    expect(screen.getByRole("tablist", { name: "준비물 확인 상태" })).toBeVisible();

    const editButton = screen.getByRole("button", { name: "내용 수정" });
    editButton.focus();
    fireEvent.click(editButton);
    expect(screen.getByRole("textbox", { name: "준비물 제목" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "취소" }));
    expect(editButton).toHaveFocus();
  });

  it("focuses the async status heading only when the follow-up anchor is present", async () => {
    renderDetail("teacher", { hash: "#supply-check-status" });

    expect(await screen.findByText("학생 하나")).toBeVisible();
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "학생 준비물 현황", level: 2 })).toHaveFocus(),
    );
  });

  it("keeps the destructive form closed until the teacher expands its disclosure", async () => {
    renderDetail();

    const disclosure = await screen.findByRole("button", { name: "준비물 삭제 옵션" });
    const panelId = disclosure.getAttribute("aria-controls");
    expect(disclosure).toHaveAttribute("aria-expanded", "false");
    expect(panelId).toBeTruthy();
    expect(document.getElementById(panelId as string)).toHaveAttribute("hidden");
    expect(document.getElementById(panelId as string)).not.toBeVisible();
    expect(screen.queryByRole("textbox", { name: /삭제 사유/u })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "준비물 삭제" })).not.toBeInTheDocument();

    fireEvent.click(disclosure);

    expect(disclosure).toHaveAttribute("aria-expanded", "true");
    expect(document.getElementById(panelId as string)).not.toHaveAttribute("hidden");
    expect(document.getElementById(panelId as string)).toBeVisible();
    expect(screen.getByRole("textbox", { name: /삭제 사유/u })).toBeVisible();
    expect(screen.getByRole("button", { name: "준비물 삭제" })).toBeVisible();

    fireEvent.click(disclosure);
    expect(disclosure).toHaveAttribute("aria-expanded", "false");
    expect(document.getElementById(panelId as string)).toHaveAttribute("hidden");
    expect(document.getElementById(panelId as string)).not.toBeVisible();
  });

  it("returns a past item to the past list and keeps that scope after deletion", async () => {
    renderDetail("teacher", { supplyOverride: { needed_on: "2026-07-13" } });

    expect(await screen.findByRole("heading", { name: "수학 준비물", level: 1 })).toBeVisible();
    expect(
      within(document.querySelector("[data-detail-backbar]") as HTMLElement).getByRole("link", {
        name: "소식",
      }),
    ).toHaveAttribute("href", "/supplies?scope=past");

    await openDeletePanel();
    fireEvent.click(screen.getByRole("button", { name: "준비물 삭제" }));
    fireEvent.click(
      within(screen.getByRole("dialog", { name: /준비물을 삭제할까요/u })).getByRole("button", {
        name: "준비물 삭제",
      }),
    );

    expect(await screen.findByRole("status", { name: "준비물 목록 검색 조건" })).toHaveTextContent(
      "?scope=past",
    );
  });

  it("keeps the reminder action at the inclusive 90-day student history boundary", async () => {
    renderDetail("teacher", { supplyOverride: { needed_on: "2026-04-15" } });

    expect(await screen.findByText("학생 하나")).toBeVisible();
    expect(screen.getByRole("button", { name: "현재 미해결 2명에게 다시 알려주기" })).toBeVisible();
    expect(screen.queryByLabelText("재알림 등록 제한")).not.toBeInTheDocument();
  });

  it("replaces the reminder action with a clear explanation beyond 90 days", async () => {
    renderDetail("teacher", { supplyOverride: { needed_on: "2026-04-14" } });

    expect(await screen.findByText("학생 하나")).toBeVisible();
    expect(screen.queryByRole("button", { name: /다시 알려주기/u })).not.toBeInTheDocument();
    const limitation = screen.getByLabelText("재알림 등록 제한");
    expect(limitation).toBeVisible();
    expect(limitation).toHaveTextContent("학생의 최근 90일 이력 범위를 지난 준비물입니다.");
    expect(limitation).toHaveTextContent("학생별 챙김 현황은 계속 확인할 수 있어요.");
  });

  it("uses history for an internal return to the exact originating list entry", async () => {
    renderDetail("teacher", { originEntryKey: "supply-origin" });

    expect(await screen.findByRole("heading", { name: "수학 준비물", level: 1 })).toBeVisible();
    const backButton = screen.getByRole("button", { name: "소식" });
    expect(
      within(document.querySelector("[data-detail-backbar]") as HTMLElement).queryByRole("link", {
        name: "소식",
      }),
    ).not.toBeInTheDocument();
    fireEvent.click(backButton);

    expect(await screen.findByRole("status", { name: "준비물 목록 검색 조건" })).toHaveTextContent(
      "?scope=past&from=kept",
    );
  });

  it("validates a Unicode delete reason and only opens the custom dialog without deleting", async () => {
    const fetchMock = renderDetail();
    await openDeletePanel();
    const reason = await screen.findByRole("textbox", { name: /삭제 사유/u });
    const deleteButton = screen.getByRole("button", { name: "준비물 삭제" });

    fireEvent.change(reason, { target: { value: "😀".repeat(301) } });
    fireEvent.click(deleteButton);
    expect(await screen.findByText("삭제 사유는 300자 이하로 입력해 주세요.")).toBeVisible();
    expect(reason).toHaveAttribute("aria-invalid", "true");
    expect(reason.getAttribute("aria-describedby")).toContain(
      screen.getByText("삭제 사유는 300자 이하로 입력해 주세요.").id,
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    fireEvent.change(reason, { target: { value: "😀".repeat(300) } });
    expect(reason).not.toHaveAttribute("aria-invalid");
    deleteButton.focus();
    fireEvent.click(deleteButton);
    const dialog = screen.getByRole("dialog", { name: /준비물을 삭제할까요/u });
    expect(
      fetchMock.mock.calls.filter(
        ([input, init]) => requestUrl(input) === "/api/v1/supplies/17" && init?.method === "DELETE",
      ),
    ).toHaveLength(0);

    fireEvent.click(within(dialog).getByRole("button", { name: "취소" }));
    await waitFor(() => expect(deleteButton).toHaveFocus());
    expect(
      fetchMock.mock.calls.filter(
        ([input, init]) => requestUrl(input) === "/api/v1/supplies/17" && init?.method === "DELETE",
      ),
    ).toHaveLength(0);
  });

  it("returns focus to the delete trigger and shows a nearby error when deletion fails", async () => {
    renderDetail("teacher", { deleteFails: true });
    await openDeletePanel();
    const deleteButton = await screen.findByRole("button", { name: "준비물 삭제" });

    deleteButton.focus();
    fireEvent.click(deleteButton);
    fireEvent.click(
      within(screen.getByRole("dialog", { name: /준비물을 삭제할까요/u })).getByRole("button", {
        name: "준비물 삭제",
      }),
    );

    expect(await screen.findByText("삭제 테스트 오류")).toBeVisible();
    await waitFor(() => expect(deleteButton).toHaveFocus());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("lets a student explicitly check the current numeric revision", async () => {
    const fetchMock = renderDetail("student");

    expect(await screen.findByText("선생님이 글을 고쳤어요")).toBeVisible();
    expect(screen.queryByRole("button", { name: "내용 수정" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "학생 준비물 현황" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "챙겼어요" }));

    expect(await screen.findByText("챙긴 준비물로 표시했습니다.")).toBeVisible();
    const checkCall = fetchMock.mock.calls.find(
      ([input, init]) =>
        requestUrl(input) === "/api/v1/supplies/17/check" && init?.method === "PUT",
    );
    expect(checkCall?.[1]?.body).toBe(JSON.stringify({ is_checked: true, content_revision: 2 }));
    expect(new Headers(checkCall?.[1]?.headers).get("X-CSRF-Token")).toBe("test-csrf-token");
    expect(screen.getByRole("button", { name: "챙겼어요" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });
});

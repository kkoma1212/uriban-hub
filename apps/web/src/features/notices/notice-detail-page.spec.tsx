import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { NoticeDetailPage } from "./notice-detail-page";
import { rememberNoticeListPosition } from "./notice-list-history";

const teacherBootstrap = {
  account: { email_verified: true, is_active: true },
  allowed_actions: ["CHANGE_PASSWORD", "LOGOUT", "VIEW_CLASS", "MANAGE_CLASS"],
  current_class: { id: "1", name: "테스트 1반", status: "active" },
  current_membership: { class_id: "1", id: "1", role: "teacher", status: "approved" },
  destination: "HOME",
  last_membership_status: null,
  last_status_reason: null,
  server_today: "2026-07-14",
  teacher_profile: { status: "active", temporary_password_must_change: false },
};

const notice = {
  content: "금요일까지 수행평가를 제출해 주세요.",
  content_revision: "2",
  id: "17",
  is_important: true,
  published_at: "2026-07-14T03:00:00.000Z",
  row_version: "4",
  title: "수행평가 안내",
};
const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;

function jsonResponse(body: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function requestUrl(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
}

function NoticeListHistoryProbe(): React.JSX.Element {
  const location = useLocation();
  return <p>{`공지 목록 화면 · ${location.key}`}</p>;
}

function renderDetail(
  role: "student" | "teacher" = "teacher",
  initialNotice = notice,
  fromList = false,
  staleDirectState = false,
  followupHash = false,
) {
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
    if (url === "/api/v1/notices/17" && (init?.method === undefined || init.method === "GET")) {
      return Promise.resolve(
        jsonResponse(
          role === "student"
            ? { ...initialNotice, confirmation_state: "modified_unconfirmed" }
            : initialNotice,
          200,
          { ETag: '"4"' },
        ),
      );
    }
    if (url === "/api/v1/notices/17/confirmations?state=unread") {
      return Promise.resolve(
        jsonResponse({
          content_revision: initialNotice.content_revision,
          counts: { confirmed: 1, unread: 2, modified_unconfirmed: 0 },
          items: [
            {
              member_id: "2",
              display_name: "학생 하나",
              student_number: 1,
              confirmation_state: "unread",
            },
          ],
          last_reminder_requested_at: null,
          next_cursor: null,
          server_today: "2026-07-14",
        }),
      );
    }
    if (url === "/api/v1/notices/17" && init?.method === "PATCH") {
      return Promise.resolve(
        jsonResponse({ ...notice, is_important: false, row_version: "5" }, 200, { ETag: '"5"' }),
      );
    }
    if (url === "/api/v1/notices/17/confirmation" && init?.method === "PUT") {
      return Promise.resolve(
        jsonResponse({ notice_id: "17", confirmation_state: "confirmed", content_revision: "2" }),
      );
    }
    throw new Error(`Unexpected URL: ${url}`);
  });

  if (fromList) rememberNoticeListPosition("notice-list-entry", "17", 300);

  render(
    <MemoryRouter
      initialEntries={
        fromList
          ? [
              { key: "notice-list-entry", pathname: "/notices" },
              {
                key: "notice-detail-entry",
                pathname: "/notices/17",
                state: { noticeListEntryKey: "notice-list-entry" },
              },
            ]
          : [
              staleDirectState
                ? {
                    pathname: "/notices/17",
                    state: { noticeListEntryKey: "stale-direct-entry" },
                  }
                : followupHash
                  ? "/notices/17#notice-confirmation-status"
                  : "/notices/17",
            ]
      }
      {...(fromList ? { initialIndex: 1 } : {})}
    >
      <Routes>
        <Route element={<NoticeDetailPage />} path="/notices/:noticeId" />
        <Route element={<NoticeListHistoryProbe />} path="/notices" />
      </Routes>
    </MemoryRouter>,
  );
  return fetchMock;
}

describe("NoticeDetailPage", () => {
  afterEach(() => {
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: originalScrollIntoView,
    });
    vi.restoreAllMocks();
  });

  it("keeps the teacher shell and page heading while the notice load waits and fails", async () => {
    let resolveNotice!: (response: Response) => void;
    const pendingNotice = new Promise<Response>((resolve) => {
      resolveNotice = resolve;
    });
    let noticeRequestCount = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = requestUrl(input);
      if (url === "/api/v1/bootstrap") {
        return Promise.resolve(jsonResponse(teacherBootstrap));
      }
      if (url === "/api/v1/notices/17") {
        noticeRequestCount += 1;
        return noticeRequestCount === 1
          ? pendingNotice
          : Promise.resolve(jsonResponse(notice, 200, { ETag: '"4"' }));
      }
      if (url === "/api/v1/notices/17/confirmations?state=unread") {
        return Promise.resolve(
          jsonResponse({
            content_revision: notice.content_revision,
            counts: { confirmed: 0, modified_unconfirmed: 0, unread: 0 },
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
      <MemoryRouter initialEntries={["/notices/17"]}>
        <Routes>
          <Route element={<NoticeDetailPage />} path="/notices/:noticeId" />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() =>
      expect(screen.getAllByRole("navigation", { name: "주요 메뉴" })).toHaveLength(2),
    );
    expect(screen.getByRole("heading", { level: 1, name: "공지" })).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent("공지 내용을 불러오고 있어요.");

    await act(async () => {
      resolveNotice(
        jsonResponse(
          {
            error: {
              code: "QA_FORCED_503",
              message: "INTERNAL_QA_DIAGNOSTIC private_notice_table",
              request_id: "qa-notice-load",
            },
          },
          503,
        ),
      );
    });

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("공지 내용을 불러오지 못했어요.");
    expect(screen.getByRole("heading", { level: 1, name: "공지" })).toBeVisible();
    expect(screen.getAllByRole("navigation", { name: "주요 메뉴" })).toHaveLength(2);
    expect(screen.queryByText(/private_notice_table/u)).not.toBeInTheDocument();

    const retry = within(alert).getByRole("button", { name: "다시 불러오기" });
    expect(retry).toHaveClass("ui-button-primary");
    expect(retry).not.toHaveClass("ui-button-danger");
    expect(within(alert).getByRole("button", { name: "목록으로 돌아가기" })).toHaveClass(
      "ui-button-secondary",
    );

    fireEvent.click(retry);
    expect(await screen.findByRole("heading", { level: 1, name: notice.title })).toBeVisible();
    expect(noticeRequestCount).toBe(2);
  });

  it("lets a teacher change only importance without claiming reconfirmation", async () => {
    const fetchMock = renderDetail();
    const heading = await screen.findByRole("heading", { name: "수행평가 안내", level: 1 });
    expect(heading).toBeVisible();
    expect(heading.closest("header")).toHaveAttribute("data-detail-heading");
    expect(heading.closest("header")?.querySelector("[data-detail-changed]")).not.toBeNull();
    expect(screen.getByText("선생님이 글을 고쳤어요")).toBeVisible();
    expect(screen.queryByText(/번째 내용/u)).not.toBeInTheDocument();
    expect(await screen.findByText("학생 하나")).toBeVisible();
    const editButton = screen.getByRole("button", { name: "내용 수정" });
    editButton.focus();
    fireEvent.click(editButton);
    expect(screen.getByRole("textbox", { name: "공지 제목" })).toHaveFocus();
    fireEvent.click(screen.getByRole("checkbox", { name: /중요 공지로 표시/u }));
    fireEvent.click(screen.getByRole("button", { name: "수정 저장" }));
    expect(
      await screen.findByText("중요 표시를 변경했습니다. 학생들의 기존 확인 기록은 유지됩니다."),
    ).toBeVisible();
    await waitFor(() => expect(editButton).toHaveFocus());
    const patchCall = fetchMock.mock.calls.find(
      ([input, init]) => requestUrl(input) === "/api/v1/notices/17" && init?.method === "PATCH",
    );
    expect(new Headers(patchCall?.[1]?.headers).get("If-Match")).toBe('"4"');
    expect(JSON.parse(String(patchCall?.[1]?.body))).toMatchObject({ is_important: false });
    // 오타 수정을 고르지 않으면 요청에 싣지 않는다(서버는 지금처럼 판을 올린다).
    expect(JSON.parse(String(patchCall?.[1]?.body))).not.toHaveProperty("minor_edit");
    expect(
      within(document.querySelector("[data-detail-backbar]") as HTMLElement).getByRole("link", {
        name: "소식",
      }),
    ).toHaveAttribute("href", "/notices");
  });

  // 오타 수정 처리(2026-10-22 사용자 결정).
  it("saves a teacher-marked typo fix and says student confirmations stay", async () => {
    const fetchMock = renderDetail();
    const base = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((input, init) =>
      requestUrl(input) === "/api/v1/notices/17" && init?.method === "PATCH"
        ? Promise.resolve(
            jsonResponse(
              { ...notice, content: "금요일까지 수행평가를 제출해 주세요!", row_version: "5" },
              200,
              { ETag: '"5"' },
            ),
          )
        : base(input, init),
    );
    fireEvent.click(await screen.findByRole("button", { name: "내용 수정" }));
    fireEvent.change(screen.getByRole("textbox", { name: "공지 내용" }), {
      target: { value: "금요일까지 수행평가를 제출해 주세요!" },
    });
    const option = screen.getByRole("checkbox", { name: /오타·띄어쓰기만 고쳤어요/u });
    expect(option).not.toBeChecked();
    fireEvent.click(option);
    fireEvent.click(screen.getByRole("button", { name: "수정 저장" }));
    expect(
      await screen.findByText("오타 수정으로 저장했어요. 학생들의 기존 확인 기록은 그대로예요."),
    ).toBeVisible();
    const patchCall = fetchMock.mock.calls.find(
      ([input, init]) => requestUrl(input) === "/api/v1/notices/17" && init?.method === "PATCH",
    );
    expect(JSON.parse(String(patchCall?.[1]?.body))).toMatchObject({ minor_edit: true });

    // 다시 열면 꺼진 상태로 시작한다.
    fireEvent.click(screen.getByRole("button", { name: "내용 수정" }));
    expect(screen.getByRole("checkbox", { name: /오타·띄어쓰기만 고쳤어요/u })).not.toBeChecked();
  });

  it("keeps the edit open with the server's reason when a typo fix is refused", async () => {
    const fetchMock = renderDetail();
    const base = fetchMock.getMockImplementation()!;
    const reason =
      "바뀐 글자가 5자를 넘거나 숫자(날짜·시간·개수)가 바뀌어 오타 수정으로 저장할 수 없어요. '오타만 고쳤어요'를 끄고 저장하면 학생들이 다시 확인해요.";
    fetchMock.mockImplementation((input, init) =>
      requestUrl(input) === "/api/v1/notices/17" && init?.method === "PATCH"
        ? Promise.resolve(
            jsonResponse(
              { error: { code: "MINOR_EDIT_NOT_ALLOWED", message: reason, request_id: "r" } },
              400,
            ),
          )
        : base(input, init),
    );
    fireEvent.click(await screen.findByRole("button", { name: "내용 수정" }));
    fireEvent.change(screen.getByRole("textbox", { name: "공지 내용" }), {
      target: { value: "토요일까지 수행평가를 3번 제출해 주세요." },
    });
    const option = screen.getByRole("checkbox", { name: /오타·띄어쓰기만 고쳤어요/u });
    fireEvent.click(option);
    fireEvent.click(screen.getByRole("button", { name: "수정 저장" }));
    // 저장 단추가 화면 아래에 붙어 있어, 이유는 고른 선택 바로 아래에 보이고 초점이 그리로 간다.
    const refusal = await screen.findByText(reason);
    expect(refusal).toHaveAttribute("role", "alert");
    expect(option.closest("div")).toContainElement(refusal);
    await waitFor(() => expect(option).toHaveFocus());
    expect(option).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("textbox", { name: "공지 내용" })).toHaveValue(
      "토요일까지 수행평가를 3번 제출해 주세요.",
    );
    // 선택을 끄면 이유도 사라진다.
    fireEvent.click(option);
    expect(screen.queryByText(reason)).not.toBeInTheDocument();
  });

  it("returns a regular notice to the unified notice list", async () => {
    renderDetail("teacher", { ...notice, is_important: false });

    expect(await screen.findByRole("heading", { name: "수행평가 안내", level: 1 })).toBeVisible();
    expect(
      within(document.querySelector("[data-detail-backbar]") as HTMLElement).getByRole("link", {
        name: "소식",
      }),
    ).toHaveAttribute("href", "/notices");
    expect(screen.getByRole("article")).toHaveClass("border-app-border", "bg-app-surface");
    expect(screen.getByRole("article").querySelector("header")).toHaveAttribute(
      "data-detail-heading",
    );
  });

  it("uses the originating notice-list history entry for the app back control", async () => {
    renderDetail("teacher", notice, true);

    expect(await screen.findByRole("heading", { name: "수행평가 안내", level: 1 })).toBeVisible();
    const backButton = screen.getByRole("button", { name: "소식" });
    expect(
      within(document.querySelector("[data-detail-backbar]") as HTMLElement).queryByRole("link", {
        name: "소식",
      }),
    ).not.toBeInTheDocument();
    fireEvent.click(backButton);
    expect(await screen.findByText("공지 목록 화면 · notice-list-entry")).toBeVisible();
  });

  it("ignores stale list state on a direct detail entry", async () => {
    renderDetail("teacher", notice, false, true);

    expect(await screen.findByRole("heading", { name: "수행평가 안내", level: 1 })).toBeVisible();
    const listLink = within(
      document.querySelector("[data-detail-backbar]") as HTMLElement,
    ).getByRole("link", { name: "소식" });
    expect(screen.queryByRole("button", { name: "소식" })).not.toBeInTheDocument();
    expect(listLink).toHaveAttribute("href", "/notices");
    listLink.focus();
    fireEvent.click(listLink);
    expect(await screen.findByText(/공지 목록 화면/u)).toBeVisible();
  });

  it("focuses and scrolls to confirmation status only for the Home follow-up anchor", async () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
    renderDetail("teacher", notice, false, false, true);

    const statusHeading = await screen.findByRole("heading", {
      level: 2,
      name: "학생 확인 현황",
    });
    await waitFor(() => expect(statusHeading).toHaveFocus());
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "start" });
  });

  it("keeps delete validation and cancel focus behind the collapsed disclosure", async () => {
    const fetchMock = renderDetail();
    const disclosureButton = await screen.findByRole("button", { name: "공지 삭제 옵션" });
    expect(disclosureButton).toHaveAttribute("aria-expanded", "false");
    const controlledId = disclosureButton.getAttribute("aria-controls");
    expect(controlledId).not.toBeNull();
    if (controlledId === null) throw new Error("Delete disclosure controls are missing.");
    expect(document.getElementById(controlledId)).not.toBeVisible();
    expect(screen.queryByRole("textbox", { name: /삭제 사유/u })).not.toBeInTheDocument();
    fireEvent.click(disclosureButton);
    expect(screen.getByRole("button", { name: "공지 삭제 옵션" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    const deleteReason = screen.getByRole("textbox", { name: /삭제 사유/u });
    expect(deleteReason).toBeVisible();
    const deleteButton = await screen.findByRole("button", { name: "공지 삭제" });
    deleteButton.focus();
    fireEvent.change(deleteReason, { target: { value: "가".repeat(301) } });
    fireEvent.click(deleteButton);
    expect(screen.getByRole("alert")).toHaveTextContent("삭제 사유는 300자 이하");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(
      fetchMock.mock.calls.filter(
        ([input, init]) => requestUrl(input) === "/api/v1/notices/17" && init?.method === "DELETE",
      ),
    ).toHaveLength(0);
    fireEvent.change(deleteReason, { target: { value: "" } });
    fireEvent.click(deleteButton);
    const dialog = screen.getByRole("dialog", { name: /공지를 삭제할까요/u });
    expect(
      fetchMock.mock.calls.filter(
        ([input, init]) => requestUrl(input) === "/api/v1/notices/17" && init?.method === "DELETE",
      ),
    ).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole("button", { name: "취소" }));
    await waitFor(() => expect(deleteButton).toHaveFocus());
  });

  it("lets a student explicitly confirm the current numeric revision", async () => {
    const fetchMock = renderDetail("student");
    expect(await screen.findByText("선생님이 글을 고쳤어요")).toBeVisible();
    const heading = screen.getByRole("heading", { name: "수행평가 안내", level: 1 });
    expect(heading.closest("header")).toHaveAttribute("data-detail-heading");
    expect(screen.getByRole("button", { name: "질문" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "내용 수정" })).not.toBeInTheDocument();
    expect(screen.queryByText("학생 확인 현황")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "최신 내용 다시 확인" }));
    expect(await screen.findByText("현재 공지를 확인했어요.")).toBeVisible();
    const confirmCall = fetchMock.mock.calls.find(
      ([input, init]) =>
        requestUrl(input) === "/api/v1/notices/17/confirmation" && init?.method === "PUT",
    );
    expect(confirmCall?.[1]?.body).toBe(JSON.stringify({ content_revision: 2 }));
    expect(new Headers(confirmCall?.[1]?.headers).get("X-CSRF-Token")).toBe("test-csrf-token");
    expect(screen.getByRole("button", { name: "확인했어요" })).toBeDisabled();
  });
});

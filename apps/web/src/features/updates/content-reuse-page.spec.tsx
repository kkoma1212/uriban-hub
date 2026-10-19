import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { clearNavigationCapabilities } from "../../lib/navigation-capabilities";
import { ContentReusePage } from "./content-reuse-page";

const bootstrap = {
  account: { display_name: "검수교사", email_verified: true, is_active: true },
  allowed_actions: ["CHANGE_PASSWORD", "LOGOUT", "VIEW_CLASS", "MANAGE_CLASS"],
  current_class: { id: "1", name: "검수반", status: "active" },
  current_membership: { class_id: "1", id: "1", role: "teacher", status: "approved" },
  destination: "HOME",
  last_membership_status: null,
  last_status_reason: null,
  server_today: "2026-09-14",
  teacher_profile: { status: "active", temporary_password_must_change: false },
};
const notice = {
  id: "17",
  title: "지난 수행평가",
  content: "이번 안내에 맞게 검토할 내용",
  category: "performance",
  is_important: true,
  audience_mode: "selected",
  audience: { mode: "selected", member_ids: ["99"] },
  content_revision: "7",
  row_version: "9",
  published_at: "2026-08-01T00:00:00.000Z",
  confirmation_state: "confirmed",
  confirmations: [{ member_id: "99" }],
};
const homework = {
  id: "21",
  title: "지난 독서 숙제",
  description: "책을 읽고 생각을 적어요",
  category: "homework",
  needed_on: "2026-08-01",
  audience_mode: "selected",
  audience: { mode: "selected", member_ids: ["99"] },
  content_revision: "4",
  row_version: "6",
  check_state: "checked",
  checks: [{ member_id: "99" }],
};
const draftKey = "classhub:content-reuse:v1:1:notice:17";

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
function urlOf(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
}
function setupApi(
  options: {
    role?: "teacher" | "student";
    memberId?: string;
    selected?: boolean;
    missing?: boolean;
    generalSupply?: boolean;
    loseFirstResponse?: boolean;
  } = {},
) {
  vi.spyOn(Document.prototype, "cookie", "get").mockReturnValue("__Host-classhub_csrf=test-csrf");
  const posts: { key: string | null; body: unknown; path: string }[] = [];
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const url = urlOf(input);
    if (url === "/api/v1/bootstrap")
      return Promise.resolve(
        response({
          ...bootstrap,
          current_membership: {
            ...bootstrap.current_membership,
            id: options.memberId ?? "1",
            role: options.role ?? "teacher",
          },
          allowed_actions:
            options.role === "student" ? ["VIEW_CLASS", "LOGOUT"] : bootstrap.allowed_actions,
        }),
      );
    if (url === "/api/v1/updates?filter=all")
      return Promise.resolve(
        response({
          items: [],
          next_cursor: null,
          selected_audience_enabled: options.selected ?? false,
          server_today: bootstrap.server_today,
        }),
      );
    if (url === "/api/v1/members?status=approved")
      return Promise.resolve(
        response({
          members: [
            {
              id: "10",
              display_name: "현재 학생",
              display_name_in_class: null,
              student_number: 1,
              status: "approved",
              account_state: "active",
            },
          ],
        }),
      );
    if (
      url === "/api/v1/notices/17" ||
      url === "/api/v1/notices/18" ||
      url === "/api/v1/supplies/21"
    )
      return Promise.resolve(
        options.missing
          ? response({ error: { code: "NOT_FOUND", message: "원본을 찾을 수 없어요." } }, 404)
          : response(
              url.includes("notices")
                ? { ...notice, id: url.endsWith("18") ? "18" : "17" }
                : { ...homework, category: options.generalSupply ? "general" : "homework" },
            ),
      );
    if ((url === "/api/v1/notices" || url === "/api/v1/supplies") && init?.method === "POST") {
      posts.push({
        key: new Headers(init.headers).get("Idempotency-Key"),
        body: JSON.parse(String(init.body)) as unknown,
        path: url,
      });
      if (options.loseFirstResponse && posts.length === 1)
        return Promise.reject(new TypeError("response lost"));
      return Promise.resolve(
        response(
          { ...(url.includes("notices") ? notice : homework), id: "101", row_version: "1" },
          201,
        ),
      );
    }
    throw new Error(`Unexpected URL: ${url}`);
  });
  return { posts, fetchMock };
}
function PathProbe(): React.JSX.Element {
  return <output aria-label="현재 경로">{useLocation().pathname}</output>;
}
function openPage(path = "/updates/reuse/notice/17") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/updates/reuse/:kind/:sourceId" element={<ContentReusePage />} />
        <Route path="*" element={<p>이동 완료</p>} />
      </Routes>
      <PathProbe />
    </MemoryRouter>,
  );
}
async function ready(label = "공지") {
  return screen.findByRole("textbox", { name: `${label} 제목` });
}

function openAudience(): HTMLElement {
  const existing = screen.queryByRole("dialog", { name: "받는 사람" });
  if (existing !== null) return existing;
  fireEvent.click(screen.getByRole("button", { name: /^받는 사람:/u }));
  return screen.getByRole("dialog", { name: "받는 사람" });
}
function closeAudience(): void {
  const sheet = screen.queryByRole("dialog", { name: "받는 사람" });
  if (sheet !== null) fireEvent.click(within(sheet).getByRole("button", { name: "선택 완료" }));
}
function publish(): void {
  closeAudience();
  fireEvent.click(
    screen.getByRole("button", {
      name: /^(올리기|제목을 적어 주세요|내용을 적어 주세요|날짜를 선택해 주세요|받는 사람을 선택해 주세요)$/u,
    }),
  );
  const review = screen.queryByRole("dialog", { name: /게시 전 검토$/u });
  if (review !== null) fireEvent.click(within(review).getByRole("button", { name: "올리기" }));
}
function chooseAll(): void {
  fireEvent.click(within(openAudience()).getByRole("radio", { name: /올릴 때의 반 전체 학생/u }));
  closeAudience();
}

async function expectCreated(path: string): Promise<void> {
  await waitFor(() =>
    expect(screen.getByRole("status", { name: "현재 경로" })).toHaveTextContent(path),
  );
}

describe("ContentReusePage", () => {
  afterEach(() => {
    window.sessionStorage.clear();
    clearNavigationCapabilities();
    vi.restoreAllMocks();
  });

  it("requires an explicit new audience and posts only editable notice fields", async () => {
    const { posts } = setupApi();
    openPage();
    expect(await ready()).toHaveValue(notice.title);
    expect(screen.getByRole("textbox", { name: "공지 내용" })).toHaveValue(notice.content);
    expect(screen.getByRole("checkbox", { name: /중요 공지로 표시/u })).not.toBeChecked();
    for (const radio of within(openAudience()).getAllByRole("radio"))
      expect(radio).not.toBeChecked();
    closeAudience();
    publish();
    expect(await screen.findByText("이번 공지를 게시할 대상을 선택해 주세요.")).toBeVisible();
    expect(posts).toHaveLength(0);
    expect(screen.getByRole("radio", { name: /올릴 때의 반 전체 학생/u })).toHaveFocus();
    chooseAll();
    publish();
    await expectCreated("/notices/101");
    expect(posts).toEqual([
      {
        key: expect.any(String),
        path: "/api/v1/notices",
        body: {
          title: notice.title,
          content: notice.content,
          category: "performance",
          is_important: false,
          audience: { mode: "all" },
        },
      },
    ]);
    expect(window.sessionStorage.getItem(draftKey)).toBeNull();
  });

  it("clears the original homework deadline and requires a new date and audience", async () => {
    const { posts } = setupApi();
    openPage("/updates/reuse/homework/21");
    expect(await ready("숙제")).toHaveValue(homework.title);
    const date = screen.getByLabelText(/마감 날짜/u, { selector: "input" });
    expect(date).toHaveValue("");
    publish();
    expect(await screen.findByText("숙제 마감 날짜를 선택해 주세요.")).toBeVisible();
    expect(posts).toHaveLength(0);
    fireEvent.change(date, { target: { value: "2026-09-16" } });
    publish();
    expect(await screen.findByText("이번 숙제를 게시할 대상을 선택해 주세요.")).toBeVisible();
    expect(posts).toHaveLength(0);
    chooseAll();
    publish();
    await expectCreated("/supplies/101");
    expect(posts[0]?.body).toEqual({
      title: homework.title,
      description: homework.description,
      category: "homework",
      needed_on: "2026-09-16",
      audience: { mode: "all" },
    });
  });

  it("selects current students without restoring the original recipients", async () => {
    const { posts } = setupApi({ selected: true });
    openPage();
    await ready();
    fireEvent.click(within(openAudience()).getByRole("radio", { name: /학생 직접 선택/u }));
    const student = await screen.findByRole("checkbox", { name: /현재 학생/u });
    expect(student).not.toBeChecked();
    publish();
    expect(await screen.findByText("게시할 학생을 한 명 이상 선택해 주세요.")).toBeVisible();
    expect(posts).toHaveLength(0);
    fireEvent.click(await screen.findByRole("checkbox", { name: /현재 학생/u }));
    publish();
    await expectCreated("/notices/101");
    expect(posts[0]?.body).toMatchObject({ audience: { mode: "selected", member_ids: ["10"] } });
  });

  it("preserves the ordinary composer draft and pending creation while resuming its own draft", async () => {
    const { posts } = setupApi();
    const ordinaryDraft = "classhub:update-create:v1:1:notice";
    const ordinaryAttempt = "classhub:idempotent-create:notices:1";
    window.sessionStorage.setItem(ordinaryDraft, "ordinary draft");
    window.sessionStorage.setItem(ordinaryAttempt, "ordinary pending key");
    const page = openPage();
    await ready();
    fireEvent.change(screen.getByRole("textbox", { name: "공지 제목" }), {
      target: { value: "수정한 재사용 초안" },
    });
    chooseAll();
    fireEvent.click(screen.getByRole("button", { name: "취소" }));
    await expectCreated("/notices/17");
    page.unmount();
    openPage();
    expect(await ready()).toHaveValue("수정한 재사용 초안");
    expect(
      within(openAudience()).getByRole("radio", { name: /올릴 때의 반 전체 학생/u }),
    ).toBeChecked();
    closeAudience();
    publish();
    await expectCreated("/notices/101");
    expect(posts).toHaveLength(1);
    expect(window.sessionStorage.getItem(ordinaryDraft)).toBe("ordinary draft");
    expect(window.sessionStorage.getItem(ordinaryAttempt)).toBe("ordinary pending key");
    expect(window.sessionStorage.getItem(draftKey)).toBeNull();
  });

  it.each(["/updates/reuse/notice/18", "/updates/reuse/notice/17"])(
    "isolates saved drafts by source and membership: %s",
    async (path) => {
      setupApi({ memberId: path.endsWith("17") ? "2" : "1" });
      window.sessionStorage.setItem(
        draftKey,
        JSON.stringify({
          title: "다른 범위의 초안",
          content: "비공개 초안",
          category: "general",
          is_important: false,
          audience: { mode: "all" },
        }),
      );
      openPage(path);
      expect(await ready()).toHaveValue(notice.title);
      expect(
        within(openAudience()).getByRole("radio", { name: /올릴 때의 반 전체 학생/u }),
      ).not.toBeChecked();
    },
  );

  it("blocks a student direct URL before fetching reusable content", async () => {
    const { fetchMock } = setupApi({ role: "student" });
    openPage();
    // 막다른 오류 대신 공통 교사 전용 처리로 홈에 돌려보낸다(총검수 B2-05).
    await waitFor(() => expect(screen.getByLabelText("현재 경로")).toHaveTextContent("/home"));
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.map(([input]) => urlOf(input))).toEqual(["/api/v1/bootstrap"]);
  });

  it("revalidates source access before exposing a saved draft", async () => {
    const { posts } = setupApi({ missing: true });
    window.sessionStorage.setItem(
      draftKey,
      JSON.stringify({
        title: "저장된 초안",
        content: "보존할 내용",
        category: "general",
        is_important: false,
      }),
    );
    openPage();
    expect(await screen.findByText("원본을 찾을 수 없어요.")).toBeVisible();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(window.sessionStorage.getItem(draftKey)).not.toBeNull();
    expect(posts).toHaveLength(0);
  });

  it.each(["/updates/reuse/supply/21", "/updates/reuse/notice/bad-id"])(
    "rejects an unsupported reuse URL: %s",
    async (path) => {
      const { fetchMock } = setupApi();
      openPage(path);
      expect(await screen.findByText("재사용할 공지나 숙제를 확인해 주세요.")).toBeVisible();
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("refuses to reuse a general supply as homework", async () => {
    setupApi({ generalSupply: true });
    openPage("/updates/reuse/homework/21");
    expect(
      await screen.findByText("공지 또는 숙제 상세에서 재사용을 시작해 주세요."),
    ).toBeVisible();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("restores and locks a lost response attempt and retries with the same key and body", async () => {
    const { posts } = setupApi({ loseFirstResponse: true });
    const page = openPage();
    await ready();
    chooseAll();
    publish();
    expect(await screen.findByRole("button", { name: "결과 다시 확인" })).toBeVisible();
    page.unmount();
    openPage();
    await ready();
    expect(await screen.findByRole("button", { name: "결과 다시 확인" })).toBeVisible();
    expect(screen.getByRole("textbox", { name: "공지 제목" })).toBeDisabled();
    expect(screen.getByRole("button", { name: /^받는 사람:/u })).toBeDisabled();
    const retry = screen.getByRole("button", { name: "결과 다시 확인" });
    fireEvent.click(retry);
    fireEvent.click(retry);
    await expectCreated("/notices/101");
    expect(posts).toHaveLength(2);
    expect(posts[0]).toEqual(posts[1]);
    expect(
      window.sessionStorage.getItem("classhub:idempotent-create:reuse-notice-17:1"),
    ).toBeNull();
  });
});

import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearAuthenticatedClientState } from "../../lib/authenticated-client-state";
import { clearNavigationCapabilities } from "../../lib/navigation-capabilities";
import { getReviewSource, readReviewImpact } from "./change-review-api";
import {
  makeReviewPlan,
  makeReviewRow,
  readReviewPlan,
  reviewStorageKey,
  storeReviewPlan,
} from "./change-review-model";
import { ScheduleChangeReviewPage } from "./schedule-change-review-page";
import { useChangeReview } from "./use-change-review";

const bootstrap = {
  account: { display_name: "검수교사", email_verified: true, is_active: true },
  allowed_actions: ["VIEW_CLASS", "MANAGE_CLASS", "LOGOUT"],
  current_class: { id: "1", name: "1반", status: "active" },
  current_membership: { class_id: "1", id: "1", role: "teacher", status: "approved" },
  destination: "HOME",
  last_membership_status: null,
  last_status_reason: null,
  server_today: "2026-09-14",
  teacher_profile: { status: "active", temporary_password_must_change: false },
};
const fixtures = {
  schedule: {
    id: "17",
    row_version: "1",
    title: "체험학습",
    description: "금요일 체험학습",
    due_date: "2026-09-18",
    schedule_type: "other",
    subject: null,
    days_until: 4,
    d_day_label: "D-4",
  },
  notice: {
    id: "21",
    row_version: "1",
    content_revision: "1",
    title: "체험학습 안내",
    content: "2026-09-18 금요일에 출발합니다.",
    category: "general",
    is_important: true,
    audience_mode: "selected",
    published_at: "2026-09-14T00:00:00.000Z",
  },
  lunch: {
    id: "31",
    row_version: "1",
    content_revision: "1",
    title: "체험학습 도시락",
    description: "개인 도시락",
    needed_on: "2026-09-18",
    category: "general",
    audience_mode: "all_snapshot",
  },
  consent: {
    id: "32",
    row_version: "1",
    content_revision: "1",
    title: "체험학습 동의서",
    description: "동의서 마감은 유지",
    needed_on: "2026-09-17",
    category: "homework",
    audience_mode: "selected",
  },
};
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
function urlOf(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
}
function setup() {
  vi.spyOn(Document.prototype, "cookie", "get").mockReturnValue(
    "__Host-classhub_csrf=synthetic-csrf",
  );
  const records = new Map<string, Record<string, unknown>>([
    ["/api/v1/schedules/17", { ...fixtures.schedule }],
    ["/api/v1/notices/21", { ...fixtures.notice }],
    ["/api/v1/supplies/31", { ...fixtures.lunch }],
    ["/api/v1/supplies/32", { ...fixtures.consent }],
  ]);
  const control = {
    role: "teacher",
    membershipId: "1",
    confirmed: 1,
    missing: "",
    loseResponse: "",
    conflictOnPatch: "",
    holdPatch: "",
    paginated: false,
    repeatedCursor: false,
    links: { notices: [], supplies: [] } as Record<string, unknown[]>,
  };
  const linkWrites: unknown[] = [];
  const patches: { path: string; body: Record<string, unknown>; etag: string | null }[] = [];
  let releasePatch: (() => void) | undefined;
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = urlOf(input),
      path = url.split("?")[0] ?? url;
    if (url === "/api/v1/bootstrap")
      return json({
        ...bootstrap,
        current_membership: {
          ...bootstrap.current_membership,
          role: control.role,
          id: control.membershipId,
        },
      });
    if (path === control.missing)
      return json({ error: { code: "NOT_FOUND", message: "원본 접근 불가" } }, 404);
    if (path === "/api/v1/updates")
      return json({
        items: [...records.entries()]
          .filter(([key]) => !key.includes("schedules"))
          .map(([key, item]) => ({
            ...item,
            kind: key.includes("notices") ? "notice" : "supply",
            content: item.content ?? item.description,
            needed_on: item.needed_on ?? null,
          })),
        next_cursor: null,
        server_today: bootstrap.server_today,
        selected_audience_enabled: true,
      });
    if (path.endsWith("/confirmations") || path.endsWith("/checks")) {
      const item = records.get(path.replace(/\/(?:confirmations|checks)$/u, ""));
      if (item === undefined) throw new Error(url);
      const notice = path.includes("notices"),
        confirmed = item.content_revision === "1" ? control.confirmed : 0,
        count = control.paginated && confirmed > 0 ? 2 : confirmed;
      const member = url.includes("cursor=")
        ? { member_id: "3", display_name: "학생 나", student_number: 2 }
        : { member_id: "2", display_name: "학생 가", student_number: 1 };
      return json({
        content_revision: item.content_revision,
        counts: {
          ...(notice ? { confirmed: count, unread: 2 } : { checked: count, unchecked: 2 }),
          modified_unconfirmed: item.content_revision === "1" ? 0 : 1,
          excluded_member_count: 0,
        },
        items: count > 0 ? [member] : [],
        next_cursor:
          control.paginated && count > 0 && (!url.includes("cursor=") || control.repeatedCursor)
            ? "next-page"
            : null,
        server_today: bootstrap.server_today,
        last_reminder_requested_at: null,
      });
    }
    if (path === "/api/v1/schedules/17/links") {
      if (init?.method === "PUT") {
        const body = JSON.parse(String(init.body)) as {
          notice_ids: string[];
          supply_ids: string[];
        };
        linkWrites.push(body);
        control.links = {
          notices: body.notice_ids.map((id) => ({ id, is_important: false, title: id })),
          supplies: body.supply_ids.map((id) => ({
            id,
            category: "general",
            needed_on: "2026-09-18",
            title: id,
          })),
        };
      }
      return json(control.links);
    }
    const item = records.get(path);
    if (item !== undefined && init?.method !== "PATCH") return json(item);
    if (item !== undefined && init?.method === "PATCH") {
      if (control.conflictOnPatch === path) {
        control.conflictOnPatch = "";
        item.row_version = String(Number(item.row_version) + 1);
        item.content_revision = String(Number(item.content_revision) + 1);
        item.content = "다른 곳에서 수정한 내용";
      }
      const etag = new Headers(init.headers).get("If-Match");
      if (etag !== `"${String(item.row_version)}"`)
        return json(
          { error: { code: "RESOURCE_VERSION_CHANGED", message: "다른 수정과 충돌" } },
          412,
        );
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      patches.push({ path, body, etag });
      Object.assign(item, body, {
        row_version: String(Number(item.row_version) + 1),
        ...(item.content_revision === undefined
          ? {}
          : { content_revision: String(Number(item.content_revision) + 1) }),
      });
      if (control.holdPatch === path)
        await new Promise<void>((resolve) => {
          releasePatch = resolve;
        });
      if (control.loseResponse === path) {
        control.loseResponse = "";
        throw new TypeError("response lost after commit");
      }
      return json(item);
    }
    throw new Error(`Unexpected URL: ${url}`);
  });
  return { records, control, patches, linkWrites, fetchMock, release: () => releasePatch?.() };
}
async function fullPlan() {
  const plan = makeReviewPlan("1", await getReviewSource("schedule", "17"));
  plan.rows[0]!.draft = { title: "체험학습", body: "월요일 체험학습", date: "2026-09-21" };
  for (const [kind, id] of [
    ["notice", "21"],
    ["supply", "31"],
    ["supply", "32"],
  ] as const)
    plan.rows.push(makeReviewRow(await getReviewSource(kind, id)));
  plan.rows[1]!.decision = "change";
  plan.rows[1]!.draft.body = "2026-09-21 월요일에 출발합니다.";
  plan.rows[2]!.decision = "change";
  plan.rows[2]!.draft.date = "2026-09-21";
  plan.rows[3]!.decision = "keep";
  return plan;
}
function openPage(path = "/schedules/17/change-review") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/schedules/:scheduleId/change-review" element={<ScheduleChangeReviewPage />} />
        <Route path="*" element={<p>다른 화면</p>} />
      </Routes>
    </MemoryRouter>,
  );
}
afterEach(() => {
  window.sessionStorage.clear();
  window.localStorage.clear();
  clearNavigationCapabilities();
  vi.restoreAllMocks();
});

describe("conditional multi-item change review", () => {
  it("applies the reviewed event, notice and lunch while preserving the separate deadline and audience", async () => {
    const api = setup(),
      plan = await fullPlan(),
      consent = structuredClone(api.records.get("/api/v1/supplies/32"));
    const { result } = renderHook(() => useChangeReview(plan));
    await act(() => result.current.review());
    expect(api.patches).toHaveLength(0);
    expect(result.current.impacts["notice:21"]?.members.map((member) => member.id)).toEqual(["2"]);
    await act(() => result.current.apply());
    expect(api.patches.map((patch) => patch.path)).toEqual([
      "/api/v1/schedules/17",
      "/api/v1/notices/21",
      "/api/v1/supplies/31",
    ]);
    expect(api.patches.every((patch) => patch.etag === '"1"' && !("audience" in patch.body))).toBe(
      true,
    );
    expect(api.patches[1]?.body).toEqual({
      title: fixtures.notice.title,
      content: "2026-09-21 월요일에 출발합니다.",
      category: "general",
      is_important: true,
    });
    expect(api.records.get("/api/v1/supplies/32")).toEqual(consent);
    expect(result.current.complete).toBe(true);
    await act(() => result.current.apply());
    expect(api.patches).toHaveLength(3);
  });
  it.each(["date", "decision"])("does not write until the %s is explicit", async (missing) => {
    const api = setup(),
      plan = await fullPlan();
    if (missing === "date") plan.rows[0]!.draft.date = "";
    else plan.rows[3]!.decision = null;
    const { result } = renderHook(() => useChangeReview(plan));
    await act(() => result.current.review());
    await act(() => result.current.apply());
    expect(result.current.error).toMatch(missing === "date" ? /날짜/u : /변경할지 유지할지/u);
    expect(api.patches).toHaveLength(0);
  });
  it("checks every content version before applying the first change", async () => {
    const api = setup(),
      plan = await fullPlan(),
      { result } = renderHook(() => useChangeReview(plan));
    await act(() => result.current.review());
    api.records.get("/api/v1/supplies/31")!.row_version = "2";
    await act(() => result.current.apply());
    expect(api.patches).toHaveLength(0);
    expect(result.current.error).toMatch(/다른 곳에서 수정/u);
    expect(result.current.plan.rows[2]?.draft.date).toBe("2026-09-21");
  });
  it("requires reviewing newly changed student confirmation counts before any write", async () => {
    const api = setup(),
      plan = await fullPlan(),
      { result } = renderHook(() => useChangeReview(plan));
    await act(() => result.current.review());
    api.control.confirmed = 0;
    await act(() => result.current.apply());
    expect(api.patches).toHaveLength(0);
    expect(result.current.error).toMatch(/학생 확인 현황이 바뀌/u);
  });
  it("fails closed when storage cannot preserve the conditional write intent", async () => {
    const api = setup(),
      plan = await fullPlan(),
      { result } = renderHook(() => useChangeReview(plan));
    await act(() => result.current.review());
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota exceeded");
    });
    await act(() => result.current.apply());
    expect(api.patches).toHaveLength(0);
    expect(result.current.saveFailed).toBe(true);
  });
  it("rechecks membership before applying a reviewed plan", async () => {
    const api = setup(),
      plan = await fullPlan(),
      { result } = renderHook(() => useChangeReview(plan));
    await act(() => result.current.review());
    api.control.membershipId = "9";
    await act(() => result.current.apply());
    expect(api.patches).toHaveLength(0);
    expect(result.current.error).toMatch(/이 반의 선생님/u);
  });
  it("stops after a committed but lost response, then reloads and applies only the remaining item", async () => {
    const api = setup(),
      plan = await fullPlan();
    api.control.loseResponse = "/api/v1/notices/21";
    const first = renderHook(() => useChangeReview(plan));
    await act(() => first.result.current.review());
    await act(() => first.result.current.apply());
    expect(api.patches).toHaveLength(2);
    expect(first.result.current.plan.rows.map((row) => row.status)).toEqual([
      "done",
      "unknown",
      "waiting",
      "waiting",
    ]);
    first.unmount();
    const restored = readReviewPlan("1", "17");
    expect(restored).toBeDefined();
    const next = renderHook(() => useChangeReview(restored!));
    await act(() => next.result.current.review());
    expect(api.patches).toHaveLength(2);
    expect(next.result.current.plan.rows[1]?.status).toBe("done");
    await act(() => next.result.current.apply());
    expect(api.patches.map((patch) => patch.path)).toEqual([
      "/api/v1/schedules/17",
      "/api/v1/notices/21",
      "/api/v1/supplies/31",
    ]);
    expect(next.result.current.complete).toBe(true);
  });
  it("preserves completed changes while rebasing a conflict and re-reviewing the remaining proposals", async () => {
    const api = setup(),
      plan = await fullPlan();
    api.control.conflictOnPatch = "/api/v1/notices/21";
    const { result } = renderHook(() => useChangeReview(plan));
    await act(() => result.current.review());
    await act(() => result.current.apply());
    expect(api.patches).toHaveLength(1);
    await act(() => result.current.review());
    expect(result.current.plan.rows[1]?.status).toBe("conflict");
    await act(() => result.current.refreshSources());
    expect(result.current.plan.started).toBe(false);
    expect(result.current.plan.rows[0]?.status).toBe("done");
    expect(result.current.plan.rows[1]?.source.body).toBe("다른 곳에서 수정한 내용");
    expect(result.current.plan.rows[1]?.draft.body).toBe("2026-09-21 월요일에 출발합니다.");
    expect(result.current.plan.rows[1]?.decision).toBeNull();
    act(() => {
      result.current.editRow("notice:21", { decision: "change" });
      result.current.editRow("supply:31", { decision: "change" });
      result.current.editRow("supply:32", { decision: "keep" });
    });
    await act(() => result.current.review());
    await act(() => result.current.apply());
    expect(result.current.complete).toBe(true);
    expect(api.patches.filter((patch) => patch.path.includes("schedules"))).toHaveLength(1);
    expect(api.patches.find((patch) => patch.path.includes("notices"))?.etag).toBe('"2"');
  });
  it("does not repeat a write while a double click is in flight", async () => {
    const api = setup(),
      plan = await fullPlan();
    api.control.holdPatch = "/api/v1/schedules/17";
    const { result } = renderHook(() => useChangeReview(plan));
    await act(() => result.current.review());
    let pending!: Promise<void>;
    act(() => {
      pending = result.current.apply();
    });
    await waitFor(() => expect(api.patches).toHaveLength(1));
    await act(() => result.current.apply());
    api.release();
    await act(() => pending);
    expect(api.patches).toHaveLength(3);
  });
  it("stops follow-up writes after unmount and never restores private storage after logout", async () => {
    const api = setup(),
      plan = await fullPlan();
    api.control.holdPatch = "/api/v1/schedules/17";
    const view = renderHook(() => useChangeReview(plan));
    await act(() => view.result.current.review());
    let pending!: Promise<void>;
    act(() => {
      pending = view.result.current.apply();
    });
    await waitFor(() => expect(api.patches).toHaveLength(1));
    view.unmount();
    clearAuthenticatedClientState();
    api.release();
    await pending;
    expect(api.patches).toHaveLength(1);
    expect(window.sessionStorage.getItem(reviewStorageKey("1", "17"))).toBeNull();
  });
  it("reads every page of students who will need to reconfirm and rejects a repeated cursor", async () => {
    const api = setup();
    api.control.paginated = true;
    const source = await getReviewSource("notice", "21");
    expect((await readReviewImpact(source))?.members.map((member) => member.id)).toEqual([
      "2",
      "3",
    ]);
    api.control.repeatedCursor = true;
    await expect(readReviewImpact(source)).rejects.toThrow(/끝까지 확인/u);
  });
});

describe("ScheduleChangeReviewPage", () => {
  it("lets the teacher select related notices, change the shared date, and keep a separate deadline", async () => {
    const api = setup();
    openPage();
    const root = await screen.findByRole("region", { name: "체험학습 변경 검토" });
    fireEvent.change(within(root).getByLabelText("새 일정 날짜"), {
      target: { value: "2026-09-21" },
    });
    fireEvent.change(within(root).getByLabelText("변경할 설명"), {
      target: { value: "월요일 체험학습" },
    });
    fireEvent.click(screen.getByRole("button", { name: "안내 찾기" }));
    for (const title of [fixtures.notice.title, fixtures.lunch.title, fixtures.consent.title]) {
      fireEvent.click(await screen.findByRole("button", { name: `${title} 검토에 추가` }));
      await screen.findByRole("region", { name: `${title} 변경 검토` });
    }
    const notice = screen.getByRole("region", { name: "체험학습 안내 변경 검토" }),
      lunch = screen.getByRole("region", { name: "체험학습 도시락 변경 검토" }),
      consent = screen.getByRole("region", { name: "체험학습 동의서 변경 검토" });
    fireEvent.click(within(notice).getByRole("radio", { name: "변경" }));
    fireEvent.change(within(notice).getByLabelText("변경할 공지 본문"), {
      target: { value: "2026-09-21 월요일에 출발합니다." },
    });
    fireEvent.click(within(lunch).getByRole("radio", { name: "변경" }));
    fireEvent.click(within(lunch).getByRole("button", { name: "일정 변경일로 맞추기" }));
    fireEvent.click(within(consent).getByRole("radio", { name: "유지" }));
    fireEvent.click(screen.getByRole("button", { name: "변경 영향 확인" }));
    expect(await screen.findByRole("button", { name: "검토한 3개 변경 적용" })).toBeVisible();
    expect(api.patches).toHaveLength(0);
    expect(within(notice).getByText(/다시 확인이 필요해질 학생 1명/u)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "검토한 3개 변경 적용" }));
    expect(await screen.findByText("검토한 변경을 모두 반영했어요")).toBeVisible();
    expect(api.patches).toHaveLength(3);
    expect(api.records.get("/api/v1/supplies/32")?.needed_on).toBe("2026-09-17");
  });
  it("restores a pending page with locked fields and explicit result checking", async () => {
    const api = setup(),
      plan = await fullPlan();
    plan.started = true;
    plan.rows[0]!.status = "unknown";
    storeReviewPlan(plan);
    openPage();
    const root = await screen.findByRole("region", { name: "체험학습 변경 검토" });
    expect(within(root).getByLabelText("새 일정 날짜")).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "적용 결과 다시 확인" }));
    expect(await screen.findByRole("button", { name: "검토한 3개 변경 적용" })).toBeVisible();
    expect(api.patches).toHaveLength(0);
  });
  it("never loads cached related content for another membership", async () => {
    const api = setup();
    storeReviewPlan(await fullPlan());
    api.control.membershipId = "9";
    api.fetchMock.mockClear();
    openPage();
    await screen.findByRole("region", { name: "체험학습 변경 검토" });
    expect(
      screen.queryByRole("region", { name: "체험학습 안내 변경 검토" }),
    ).not.toBeInTheDocument();
    expect(api.fetchMock.mock.calls.map(([input]) => urlOf(input))).not.toContain(
      "/api/v1/notices/21",
    );
  });
  it("denies a student URL before reading a schedule or saved draft", async () => {
    const api = setup();
    api.control.role = "student";
    openPage();
    // 막다른 오류 대신 공통 교사 전용 처리로 홈에 돌려보낸다(총검수 B2-05).
    expect(await screen.findByText("다른 화면")).toBeVisible();
    expect(api.fetchMock.mock.calls.map(([input]) => urlOf(input))).toEqual(["/api/v1/bootstrap"]);
  });
  it("blocks an inaccessible related source instead of showing a cached private draft", async () => {
    const api = setup();
    storeReviewPlan(await fullPlan());
    api.control.missing = "/api/v1/notices/21";
    openPage();
    expect(await screen.findByText("원본 접근 불가")).toBeVisible();
    expect(screen.queryByLabelText("새 일정 날짜")).not.toBeInTheDocument();
  });
  it("rejects malformed schedule ids without fetching", async () => {
    const api = setup();
    openPage("/schedules/not-an-id/change-review");
    expect(await screen.findByText("변경할 일정을 확인해 주세요.")).toBeVisible();
    expect(api.fetchMock).not.toHaveBeenCalled();
  });
  it("preserves existing normal and reuse drafts when editing a review", async () => {
    setup();
    window.sessionStorage.setItem("classhub:update-create:v1:1:notice", "normal draft");
    window.sessionStorage.setItem("classhub:content-reuse:v1:1:notice:21", "reuse draft");
    openPage();
    const date = await screen.findByLabelText("새 일정 날짜");
    fireEvent.change(date, { target: { value: "2026-09-21" } });
    expect(readReviewPlan("1", "17")?.rows[0]?.draft.date).toBe("2026-09-21");
    expect(window.sessionStorage.getItem("classhub:update-create:v1:1:notice")).toBe(
      "normal draft",
    );
    expect(window.sessionStorage.getItem("classhub:content-reuse:v1:1:notice:21")).toBe(
      "reuse draft",
    );
  });
});

describe("schedule link saving", () => {
  it("prefills saved links and saves the reviewed list only when asked", async () => {
    const api = setup();
    api.control.links = {
      notices: [{ id: "21", is_important: true, title: "체험학습 안내" }],
      supplies: [],
    };
    openPage();
    expect((await screen.findAllByText("체험학습 안내")).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: /저장된 연결과 같아요/u })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "안내 찾기" }));
    fireEvent.click(await screen.findByRole("button", { name: "체험학습 도시락 검토에 추가" }));
    const save = await screen.findByRole("button", { name: /연결 2개 저장/u });
    expect(api.linkWrites).toHaveLength(0);
    fireEvent.click(save);
    expect(await screen.findByText(/관련 안내 2개를 연결했어요/u)).toBeInTheDocument();
    expect(api.linkWrites).toEqual([{ notice_ids: ["21"], supply_ids: ["31"] }]);
    expect(api.patches).toHaveLength(0);
  });
  it("blocks saving when the saved links could not be read", async () => {
    const api = setup();
    api.control.missing = "/api/v1/schedules/17/links";
    openPage();
    expect(await screen.findByText(/저장된 연결을 불러오지 못해/u)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /연결 0개 저장|저장된 연결과 같아요/u }),
    ).toBeDisabled();
    expect(api.linkWrites).toHaveLength(0);
  });
});

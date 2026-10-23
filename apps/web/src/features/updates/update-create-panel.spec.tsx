import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { UpdateCreatePanel } from "./update-create-panel";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
    status,
  });
}

function requestUrl(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
}

function LocationPathProbe(): React.JSX.Element {
  const location = useLocation();
  return <output aria-label="현재 경로">{location.pathname}</output>;
}

function renderPanel(initialKind?: "notice" | "supply" | "homework"): void {
  render(
    <MemoryRouter initialEntries={["/updates"]}>
      <UpdateCreatePanel
        initialKind={initialKind}
        membershipId="membership-1"
        onClose={vi.fn()}
        selectedAudienceEnabled={false}
        serverToday="2026-07-29"
      />
      <LocationPathProbe />
    </MemoryRouter>,
  );
}

describe("UpdateCreatePanel", () => {
  afterEach(() => {
    // 먼저 내린다. 남아 있던 초안 저장 효과가 내리는 순간 돌면 지운 저장소에 앞 시험 제목을 다시 써
    // 다음 시험 단추 이름이 바뀌었다(10-21 부하 재현 — 자동 정리가 이 정리보다 늦게 돈다).
    cleanup();
    window.sessionStorage.clear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function ResponsivePanelHarness(): React.JSX.Element {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button onClick={() => setOpen(true)} type="button">
          작성 열기
        </button>
        {open ? (
          <UpdateCreatePanel
            membershipId="responsive-member"
            onClose={() => setOpen(false)}
            selectedAudienceEnabled={false}
            serverToday="2026-10-11"
          />
        ) : null}
      </>
    );
  }

  it("isolates the mobile composer, cycles focus, and returns focus after Escape", () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: false })),
    );
    const { container } = render(
      <MemoryRouter>
        <ResponsivePanelHarness />
      </MemoryRouter>,
    );
    const trigger = screen.getByRole("button", { name: "작성 열기" });
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "소식 쓰기" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAttribute("data-app-role", "teacher");
    expect(container).toHaveAttribute("inert");
    expect(container).toHaveAttribute("aria-hidden", "true");
    expect(container).not.toContainElement(dialog);
    const close = within(dialog).getByRole("button", { name: "소식 작성 닫기" });
    const submit = within(dialog).getByRole("button", { name: "제목을 적어 주세요" });
    close.focus();
    fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
    expect(submit).toHaveFocus();
    fireEvent.keyDown(submit, { key: "Tab" });
    expect(close).toHaveFocus();
    trigger.focus();
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "소식 쓰기" })).not.toBeInTheDocument();
    expect(container).not.toHaveAttribute("inert");
    expect(trigger).toHaveFocus();
  });

  it("keeps the desktop composer inline without background suppression or focus trapping", () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: true })),
    );
    const { container } = render(
      <MemoryRouter>
        <ResponsivePanelHarness />
      </MemoryRouter>,
    );
    const trigger = screen.getByRole("button", { name: "작성 열기" });
    fireEvent.click(trigger);
    const panel = document.getElementById("update-create-panel");
    expect(container).toContainElement(panel);
    expect(panel).not.toHaveAttribute("aria-modal");
    expect(panel).not.toHaveAttribute("role", "dialog");
    expect(container).not.toHaveAttribute("inert");
    trigger.focus();
    expect(trigger).toHaveFocus();
    fireEvent.keyDown(trigger, { key: "Escape" });
    expect(screen.getByRole("textbox", { name: "공지 제목" })).toBeVisible();
  });

  it.each([true, false])(
    "keeps an open review and its focus intact across the viewport breakpoint (desktop: %s)",
    async (initialDesktop) => {
      const listeners = new Set<() => void>();
      const media = {
        matches: initialDesktop,
        addEventListener: (_event: string, listener: () => void) => listeners.add(listener),
        removeEventListener: (_event: string, listener: () => void) => listeners.delete(listener),
      };
      vi.stubGlobal(
        "matchMedia",
        vi.fn(() => media),
      );
      renderPanel();
      fireEvent.change(screen.getByRole("textbox", { name: "공지 제목" }), {
        target: { value: "반응형 검토 제목" },
      });
      fireEvent.change(screen.getByRole("textbox", { name: "공지 내용" }), {
        target: { value: "반응형 검토 본문" },
      });
      fireEvent.click(screen.getByRole("button", { name: "올리기" }));
      const review = screen.getByRole("dialog", { name: "공지 게시 전 검토" });
      const cancel = within(review).getByRole("button", { name: "더 고치기" });
      expect(cancel).toHaveFocus();
      await act(async () => {
        media.matches = !initialDesktop;
        listeners.forEach((listener) => listener());
      });
      expect(screen.getByRole("dialog", { name: "공지 게시 전 검토" })).toBe(review);
      expect(cancel).toHaveFocus();
      expect(review).not.toHaveAttribute("inert");
      fireEvent.click(cancel);
      await waitFor(() => {
        const panel = document.getElementById("update-create-panel");
        if (initialDesktop) expect(panel).toHaveAttribute("aria-modal", "true");
        else expect(panel).not.toHaveAttribute("aria-modal");
      });
      expect(screen.getByRole("textbox", { name: "공지 제목" })).toHaveValue("반응형 검토 제목");
      expect(screen.getByRole("textbox", { name: "공지 내용" })).toHaveValue("반응형 검토 본문");
    },
  );

  it("creates a notice from the unified kind chooser with one guarded request", async () => {
    vi.spyOn(Document.prototype, "cookie", "get").mockReturnValue(
      "__Host-classhub_csrf=csrf-value",
    );
    const idempotencyKey = "11111111-1111-4111-8111-111111111111";
    vi.spyOn(crypto, "randomUUID").mockReturnValue(idempotencyKey);
    const submittedKeys: string[] = [];
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = requestUrl(input);
      if (url === "/api/v1/notices" && init?.method === "POST") {
        const key = new Headers(init.headers).get("Idempotency-Key");
        if (key === null) throw new Error("Idempotency-Key가 없습니다.");
        submittedKeys.push(key);
        return Promise.resolve(
          jsonResponse(
            {
              audience_mode: "all_snapshot",
              category: "general",
              content: "통합 작성 흐름을 확인합니다.",
              content_revision: "1",
              id: "notice-17",
              is_important: false,
              published_at: "2026-07-29T01:00:00.000Z",
              row_version: "1",
              title: "통합 작성 공지",
            },
            201,
          ),
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    renderPanel();

    expect(screen.queryByRole("list", { name: "소식 작성 단계" })).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "공지 제목" })).toHaveFocus();
    expect(screen.getByRole("button", { name: "제목을 적어 주세요" })).toBeVisible();
    expect(
      within(screen.getByRole("group", { name: "소식 종류" })).getAllByRole("button"),
    ).toHaveLength(4);
    expect(
      within(screen.getByRole("group", { name: "소식 종류" })).getByRole("button", {
        name: "공지",
      }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(
      within(screen.getByRole("group", { name: "소식 종류" })).getByRole("button", {
        name: "수행평가",
      }),
    ).toBeVisible();
    fireEvent.click(
      within(screen.getByRole("group", { name: "소식 종류" })).getByRole("button", {
        name: /공지/u,
      }),
    );
    fireEvent.change(screen.getByRole("textbox", { name: "공지 제목" }), {
      target: { value: "통합 작성 공지" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "공지 내용" }), {
      target: { value: "통합 작성 흐름을 확인합니다." },
    });
    expect(screen.getByRole("region", { name: "공지 작성 내용" })).toBeVisible();
    expect(screen.getByRole("region", { name: "게시 대상과 결과" })).toBeVisible();
    expect(screen.queryByRole("dialog", { name: "공지 게시 전 검토" })).not.toBeInTheDocument();
    expect(submittedKeys).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "올리기" }));
    const review = screen.getByRole("dialog", { name: "공지 게시 전 검토" });
    expect(within(review).getByRole("heading", { name: "통합 작성 공지" })).toBeVisible();
    expect(within(review).getByText(/올릴 때의 반 전체 학생/u)).toBeVisible();
    expect(submittedKeys).toHaveLength(0);
    fireEvent.click(within(review).getByRole("button", { name: "올리기" }));

    await waitFor(() => {
      expect(screen.getByLabelText("현재 경로")).toHaveTextContent("/notices/notice-17");
    });
    expect(submittedKeys).toEqual([idempotencyKey]);
    expect(window.sessionStorage.length).toBe(0);
    expect(
      fetchMock.mock.calls.filter(
        ([input, init]) => requestUrl(input) === "/api/v1/notices" && init?.method === "POST",
      ),
    ).toHaveLength(1);
  });

  it("switches notification kinds without losing either real-time draft", () => {
    renderPanel("notice");

    expect(
      screen.getByText("작성 내용은 이 탭에 실시간 저장돼요. 종류를 바꾸거나 취소해도 유지됩니다."),
    ).toBeVisible();
    const noticeContent = screen.getByRole("textbox", { name: "공지 내용" });
    expect(noticeContent).toHaveAttribute("placeholder", "학생들이 꼭 알아야할 내용을 적어주세요");
    expect(screen.queryByPlaceholderText(/차분하게/u)).not.toBeInTheDocument();

    fireEvent.change(screen.getByRole("textbox", { name: "공지 제목" }), {
      target: { value: "작성 중인 공지" },
    });
    fireEvent.change(noticeContent, {
      target: { value: "공지 초안 내용" },
    });

    fireEvent.click(
      within(screen.getByRole("group", { name: "소식 종류" })).getByRole("button", {
        name: "준비물",
      }),
    );
    fireEvent.change(screen.getByRole("textbox", { name: "준비물 제목" }), {
      target: { value: "작성 중인 준비물" },
    });
    fireEvent.change(screen.getByLabelText(/필요한 날짜/u, { selector: "input" }), {
      target: { value: "2026-07-31" },
    });

    fireEvent.click(
      within(screen.getByRole("group", { name: "소식 종류" })).getByRole("button", {
        name: "공지",
      }),
    );
    expect(screen.getByRole("textbox", { name: "공지 제목" })).toHaveValue("작성 중인 공지");
    expect(screen.getByRole("textbox", { name: "공지 내용" })).toHaveValue("공지 초안 내용");

    fireEvent.click(
      within(screen.getByRole("group", { name: "소식 종류" })).getByRole("button", {
        name: "준비물",
      }),
    );
    expect(screen.getByRole("textbox", { name: "준비물 제목" })).toHaveValue("작성 중인 준비물");
    expect(screen.getByLabelText(/필요한 날짜/u, { selector: "input" })).toHaveValue("2026-07-31");
  });

  it.each([
    ["supply", "준비물", "필요한 날짜"],
    ["homework", "숙제", "마감 날짜"],
  ] as const)(
    "rechecks an ambiguous %s result with the same idempotency key",
    async (kind, label, dateLabel) => {
      vi.spyOn(Document.prototype, "cookie", "get").mockReturnValue(
        "__Host-classhub_csrf=csrf-value",
      );
      const idempotencyKey = "22222222-2222-4222-8222-222222222222";
      vi.spyOn(crypto, "randomUUID").mockReturnValue(idempotencyKey);
      const submittedKeys: string[] = [];
      let createCalls = 0;
      vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
        const url = requestUrl(input);
        if (url === "/api/v1/supplies?scope=upcoming") {
          return Promise.resolve(
            jsonResponse({
              items: [],
              next_cursor: null,
              selected_audience_enabled: false,
              server_today: "2026-07-29",
            }),
          );
        }
        if (url === "/api/v1/supplies" && init?.method === "POST") {
          expect(JSON.parse(String(init.body)).category).toBe(
            kind === "homework" ? "homework" : "general",
          );
          createCalls += 1;
          const key = new Headers(init.headers).get("Idempotency-Key");
          if (key === null) throw new Error("Idempotency-Key가 없습니다.");
          submittedKeys.push(key);
          return Promise.resolve(
            createCalls === 1
              ? jsonResponse({ error: { code: "UPSTREAM_TIMEOUT", message: "시간 초과" } }, 503)
              : jsonResponse(
                  {
                    audience_mode: "all_snapshot",
                    check_state: "unchecked",
                    content_revision: "1",
                    description: null,
                    id: "supply-21",
                    needed_on: "2026-07-31",
                    row_version: "1",
                    title: "통합 작성 준비물",
                  },
                  201,
                ),
          );
        }
        throw new Error(`Unexpected URL: ${url}`);
      });

      renderPanel(kind);
      fireEvent.change(await screen.findByRole("textbox", { name: `${label} 제목` }), {
        target: { value: "통합 작성 준비물" },
      });
      fireEvent.change(screen.getByLabelText(new RegExp(dateLabel, "u"), { selector: "input" }), {
        target: { value: "2026-07-31" },
      });
      fireEvent.click(screen.getByRole("button", { name: "올리기" }));
      fireEvent.click(
        within(screen.getByRole("dialog", { name: label + " 게시 전 검토" })).getByRole("button", {
          name: "올리기",
        }),
      );

      expect(
        await screen.findByText(/준비물·숙제 등록 요청이 저장됐는지 확인하지 못했어요/u),
      ).toBeVisible();
      expect(screen.getByRole("textbox", { name: `${label} 제목` })).toBeDisabled();
      for (const button of within(screen.getByRole("group", { name: "소식 종류" })).getAllByRole(
        "button",
      ))
        expect(button).toBeDisabled();
      fireEvent.click(screen.getByRole("button", { name: "결과 다시 확인" }));

      await waitFor(() => {
        expect(screen.getByLabelText("현재 경로")).toHaveTextContent("/supplies/supply-21");
      });
      expect(submittedKeys).toEqual([idempotencyKey, idempotencyKey]);
      expect(window.sessionStorage.length).toBe(0);
    },
  );

  it("restores a legacy homework draft and preserves its content when changing the entry kind", () => {
    window.sessionStorage.setItem(
      "classhub:update-create:v1:membership-1:kind",
      JSON.stringify("supply"),
    );
    window.sessionStorage.setItem(
      "classhub:update-create:v1:membership-1:supply",
      JSON.stringify({
        audience: { mode: "all" },
        category: "homework",
        title: "기존 숙제 초안",
        description: "다음 시간에 확인해요",
        needed_on: "2026-07-31",
      }),
    );
    renderPanel();
    expect(
      within(screen.getByRole("group", { name: "소식 종류" })).getByRole("button", {
        name: "숙제",
      }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("textbox", { name: "숙제 제목" })).toHaveValue("기존 숙제 초안");
    expect(screen.getByLabelText(/마감 날짜/u, { selector: "input" })).toHaveValue("2026-07-31");
    fireEvent.click(
      within(screen.getByRole("group", { name: "소식 종류" })).getByRole("button", {
        name: "준비물",
      }),
    );
    expect(screen.getByRole("textbox", { name: "준비물 제목" })).toHaveValue("기존 숙제 초안");
    fireEvent.click(
      within(screen.getByRole("group", { name: "소식 종류" })).getByRole("button", {
        name: "공지",
      }),
    );
    fireEvent.click(
      within(screen.getByRole("group", { name: "소식 종류" })).getByRole("button", {
        name: "숙제",
      }),
    );
    expect(screen.getByRole("textbox", { name: "숙제 제목" })).toHaveValue("기존 숙제 초안");
    expect(screen.getByLabelText(/마감 날짜/u, { selector: "input" })).toHaveValue("2026-07-31");
  });
  it("keeps notice content required and returns from review without sending a request", () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    renderPanel("notice");
    fireEvent.change(screen.getByRole("textbox", { name: "공지 제목" }), {
      target: { value: "내용 확인" },
    });
    fireEvent.click(screen.getByRole("button", { name: "내용을 적어 주세요" }));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "공지 내용은 1자 이상 2,000자 이하로 입력해 주세요.",
    );
    expect(screen.getByRole("textbox", { name: "공지 내용" })).toHaveFocus();
    expect(screen.queryByRole("dialog", { name: "공지 게시 전 검토" })).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "공지 내용" }), {
      target: { value: "반드시 읽어 주세요." },
    });
    const publish = screen.getByRole("button", { name: "올리기" });
    fireEvent.click(publish);
    const review = screen.getByRole("dialog", { name: "공지 게시 전 검토" });
    fireEvent.click(within(review).getByRole("button", { name: "더 고치기" }));
    expect(screen.getByRole("textbox", { name: "공지 내용" })).toHaveValue("반드시 읽어 주세요.");
    expect(publish).toHaveFocus();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("selects performance notices without losing text or importance", () => {
    renderPanel("notice");
    fireEvent.change(screen.getByRole("textbox", { name: "공지 제목" }), {
      target: { value: "발표 평가 안내" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "공지 내용" }), {
      target: { value: "준비한 내용을 발표해요." },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: "중요 공지로 표시" }));
    fireEvent.click(
      within(screen.getByRole("group", { name: "소식 종류" })).getByRole("button", {
        name: "수행평가",
      }),
    );
    expect(
      within(screen.getByRole("group", { name: "소식 종류" })).getByRole("button", {
        name: "수행평가",
      }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("textbox", { name: "공지 제목" })).toHaveValue("발표 평가 안내");
    expect(screen.getByRole("checkbox", { name: "중요 공지로 표시" })).toBeChecked();
    expect(
      JSON.parse(
        window.sessionStorage.getItem("classhub:update-create:v1:membership-1:notice") ?? "{}",
      ),
    ).toMatchObject({
      category: "performance",
      is_important: true,
      content: "준비한 내용을 발표해요.",
    });
    fireEvent.click(screen.getByRole("button", { name: "올리기" }));
    expect(
      within(screen.getByRole("dialog", { name: "공지 게시 전 검토" })).getByText("수행평가 공지"),
    ).toBeVisible();
  });

  it("opens an existing past notice as a separate reuse draft", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = requestUrl(input);
      if (url === "/api/v1/notices?importance=all")
        return Promise.resolve(
          jsonResponse({
            items: [
              {
                id: "17",
                title: "지난 학급 안내",
                content: "지난 글 내용",
                category: "general",
                is_important: false,
                published_at: "2026-07-20T00:00:00.000Z",
                row_version: "1",
                content_revision: "1",
                audience_mode: "all_snapshot",
              },
            ],
            next_cursor: null,
            selected_audience_enabled: false,
            server_today: "2026-07-29",
          }),
        );
      throw new Error("Unexpected URL: " + url);
    });
    renderPanel("notice");
    fireEvent.change(screen.getByRole("textbox", { name: "공지 제목" }), {
      target: { value: "보관할 작성 중 초안" },
    });
    fireEvent.click(screen.getByRole("button", { name: "지난 글 불러오기" }));
    const picker = screen.getByRole("dialog", { name: "지난 글 불러오기" });
    expect(within(picker).getByRole("button", { name: "선택한 글 불러오기" })).toBeDisabled();
    fireEvent.click(await within(picker).findByRole("radio", { name: /지난 학급 안내/u }));
    fireEvent.click(within(picker).getByRole("button", { name: "선택한 글 불러오기" }));
    await waitFor(() =>
      expect(screen.getByLabelText("현재 경로")).toHaveTextContent("/updates/reuse/notice/17"),
    );
    expect(
      window.sessionStorage.getItem("classhub:update-create:v1:membership-1:notice"),
    ).toContain("보관할 작성 중 초안");
    expect(fetchMock.mock.calls.every(([, init]) => init?.method !== "POST")).toBe(true);
  });
});

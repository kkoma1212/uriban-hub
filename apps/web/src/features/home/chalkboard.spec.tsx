import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";

import type { HomeResponse } from "../../api/auth";
import { Chalkboard, neededOnLabel, studentChalkLines, teacherChalkLines } from "./chalkboard";

const notice = (id: string, values: Record<string, unknown>) => ({
  confirmation_state: "unread",
  content_revision: "1",
  id,
  is_important: false,
  published_at: "2026-09-27T00:00:00.000Z",
  title: `공지 ${id}`,
  ...values,
});
const supply = (id: string, neededOn: string, values: Record<string, unknown> = {}) => ({
  category: "homework",
  check_state: "unchecked",
  content_revision: "1",
  description: null,
  id,
  needed_on: neededOn,
  title: `숙제 ${id}`,
  ...values,
});
function home(notices: unknown[], supplies: unknown[]): HomeResponse {
  return {
    meal: { data: null, status: "empty" },
    notices: { data: notices, status: notices.length ? "ok" : "empty" },
    pending_member_count: null,
    reminders: { data: [], status: "empty" },
    schedules: { data: [], status: "empty" },
    server_today: "2026-09-28",
    supplies: { data: supplies, status: supplies.length ? "ok" : "empty" },
    teacher_followups: null,
  } as unknown as HomeResponse;
}

describe("studentChalkLines", () => {
  it("바뀐 공지 → 확인 안 한 중요 공지 → 안 챙긴 숙제(가까운 날부터) 순서로 세 줄까지", () => {
    const lines = studentChalkLines(
      home(
        [
          notice("plain", {}),
          notice("important", { is_important: true }),
          notice("changed", { confirmation_state: "modified_unconfirmed" }),
          notice("read-important", { confirmation_state: "confirmed", is_important: true }),
        ],
        [
          supply("later", "2026-10-05"),
          supply("soon", "2026-09-29"),
          supply("done", "2026-09-28", { check_state: "checked" }),
        ],
      ),
    );
    expect(lines.map((line) => [line.key, line.meta, line.changed === true])).toEqual([
      ["notice-changed", "바뀜", true],
      ["notice-important", "중요", false],
      ["supply-soon", "내일", false],
    ]);
    // 중요하지 않은 새 공지·이미 확인한 공지·챙긴 준비물은 칠판에 올리지 않는다.
    expect(
      lines.some((line) =>
        ["notice-plain", "notice-read-important", "supply-done"].includes(line.key),
      ),
    ).toBe(false);
  });

  it("불러오지 못한 묶음은 건너뛰고, 올릴 것이 없으면 빈 칠판이다", () => {
    const failed = {
      ...home([], [supply("s", "2026-09-30")]),
      notices: { data: [], error_code: "NOTICE_QUERY_FAILED", message: "x", status: "error" },
    } as unknown as HomeResponse;
    expect(studentChalkLines(failed).map((line) => line.key)).toEqual(["supply-s"]);
    expect(studentChalkLines(home([], []))).toEqual([]);
  });

  it("필요한 날을 오늘·내일·요일·D-day·지남으로 적는다", () => {
    expect(neededOnLabel("2026-09-28", "2026-09-28")).toBe("오늘");
    expect(neededOnLabel("2026-09-29", "2026-09-28")).toBe("내일");
    expect(neededOnLabel("2026-10-02", "2026-09-28")).toBe("금요일");
    expect(neededOnLabel("2026-10-10", "2026-09-28")).toBe("D-12");
    expect(neededOnLabel("2026-09-27", "2026-09-28")).toBe("지남");
  });
});

describe("Chalkboard", () => {
  it("바뀐 줄의 제목에만 형광펜을 표시하고, 줄마다 원래 글로 이어진다", () => {
    render(
      <MemoryRouter>
        <Chalkboard
          dateLabel="9월 28일 월요일"
          dateTime="2026-09-28"
          emptyText="비어 있어요"
          lines={[
            {
              changed: true,
              key: "a",
              meta: "바뀜",
              text: "체육대회 10월 8일로",
              to: "/notices/1",
            },
            { key: "b", meta: "내일", text: "과학 보고서", to: "/supplies/2" },
          ]}
        />
      </MemoryRouter>,
    );
    const board = screen.getByRole("region", { name: "우리반 칠판" });
    const links = within(board).getAllByRole("link");
    expect(links.map((link) => link.getAttribute("href"))).toEqual(["/notices/1", "/supplies/2"]);
    expect(links[0]).toHaveAttribute("data-chalk-changed", "true");
    expect(links[1]).not.toHaveAttribute("data-chalk-changed");
    expect(links[0]).toHaveAccessibleName(/체육대회 10월 8일로\s*바뀜/u);
    expect(links[1]).toHaveAccessibleName(/과학 보고서\s*내일/u);
    expect(links[0]?.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    expect(within(board).getByText("9월 28일 월요일")).toHaveAttribute("datetime", "2026-09-28");
  });

  it("줄이 없으면 빈 칠판 문구를 보여 준다", () => {
    render(
      <MemoryRouter>
        <Chalkboard
          dateLabel="d"
          dateTime="2026-09-28"
          emptyText="오늘은 새로 볼 안내가 없어요"
          lines={[]}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText("오늘은 새로 볼 안내가 없어요")).toBeVisible();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
});

describe("teacherChalkLines", () => {
  it("중요 공지(최근부터) → 오늘 이후 준비물(가까운 날부터) → 최근 공지, 확인 상태와 무관하게", () => {
    const lines = teacherChalkLines(
      home(
        [
          notice("old-important", {
            is_important: true,
            published_at: "2026-09-20T00:00:00.000Z",
            confirmation_state: "confirmed",
          }),
          notice("new-important", { is_important: true, published_at: "2026-09-27T00:00:00.000Z" }),
          notice("plain", { published_at: "2026-09-26T00:00:00.000Z" }),
        ],
        [supply("past", "2026-09-27"), supply("soon", "2026-09-29", { check_state: "checked" })],
      ),
    );
    expect(lines.map((line) => [line.key, line.meta])).toEqual([
      ["notice-new-important", "중요"],
      ["notice-old-important", "중요"],
      ["supply-soon", "내일"],
    ]);
  });
});

describe("빈 칠판 축소 조건", () => {
  it("성공한 빈 판만 모바일·태블릿 여백을 줄이고 PC·나무틀·분필은 유지한다", () => {
    render(
      <MemoryRouter>
        <Chalkboard
          compactEmpty
          dateLabel="오늘"
          dateTime="2026-10-13"
          emptyText="칠판에 올릴 중요한 안내는 없어요"
          lines={[]}
        />
      </MemoryRouter>,
    );
    const board = screen.getByRole("region", { name: "우리반 칠판" });
    expect(board.querySelector("[data-chalk-body]")).toHaveClass(
      "min-h-[4.75rem]",
      "sm:min-h-[5.5rem]",
      "xl:min-h-[9.25rem]",
    );
    expect(board).toHaveClass("bg-[var(--color-chalk-frame)]");
    expect(screen.getByText("칠판에 올릴 중요한 안내는 없어요").getAttribute("style")).toContain(
      "Gaegu",
    );
  });
  it.each(["안내", "생일"])(
    "%s 내용이 있으면 축소 요청 중에도 원래 높이와 내용을 보존한다",
    (kind) => {
      render(
        <MemoryRouter>
          <Chalkboard
            compactEmpty
            birthdays={kind === "생일" ? ["합성학생"] : []}
            dateLabel="오늘"
            dateTime="2026-10-13"
            emptyText="빈 칠판"
            lines={
              kind === "안내"
                ? [
                    {
                      key: "long",
                      text: "길어도 원문으로 이어지는 중요한 안내",
                      meta: "중요",
                      to: "/notices/long",
                    },
                  ]
                : []
            }
          />
        </MemoryRouter>,
      );
      const board = screen.getByRole("region", { name: "우리반 칠판" });
      expect(board.querySelector("[data-chalk-body]")).toHaveClass("min-h-[9.25rem]");
      expect(board.querySelector("[data-chalk-body]")).not.toHaveClass("min-h-[4.75rem]");
      if (kind === "안내")
        expect(within(board).getByRole("link")).toHaveAttribute("href", "/notices/long");
      else expect(within(board).getByText("오늘은 합성학생의 생일이에요")).toBeVisible();
    },
  );
});

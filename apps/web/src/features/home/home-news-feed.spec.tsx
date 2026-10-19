import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";

import type { HomeResponse } from "../../api/auth";
import { HomeNewsFeed, homeFeedItems } from "./home-news-feed";

function home(values: Record<string, unknown> = {}): HomeResponse {
  return {
    meal: { data: null, status: "empty" },
    notices: {
      data: [
        {
          confirmation_state: "confirmed",
          content_revision: "1",
          id: "old",
          is_important: false,
          published_at: "2026-09-20T00:00:00.000Z",
          title: "지난 공지",
        },
        // 오전 8시(KST)에 올린 공지 — UTC로는 전날 23시다.
        {
          confirmation_state: "modified_unconfirmed",
          content_revision: "2",
          id: "new",
          is_important: true,
          published_at: "2026-09-27T23:00:00.000Z",
          title: "체육대회 바뀜",
        },
      ],
      status: "ok",
    },
    pending_member_count: null,
    reminders: { data: [], status: "empty" },
    schedules: { data: [], status: "empty" },
    server_today: "2026-09-28",
    supplies: {
      data: [
        {
          category: "general",
          check_state: "checked",
          content_revision: "1",
          description: null,
          id: "paint",
          needed_on: "2026-10-02",
          title: "물감",
        },
        {
          category: "homework",
          check_state: "unchecked",
          content_revision: "1",
          description: null,
          id: "report",
          needed_on: "2026-09-29",
          title: "보고서",
        },
      ],
      status: "ok",
    },
    teacher_followups: null,
    ...values,
  } as unknown as HomeResponse;
}

describe("homeFeedItems", () => {
  it("compact visual titles retain the full accessible title and original destination", () => {
    const title = "긴 안내의 전체 제목을 확인해 주세요 ".repeat(12).trim();
    render(
      <MemoryRouter>
        <HomeNewsFeed
          role="student"
          home={home({
            notices: {
              status: "ok",
              data: [
                {
                  id: "long",
                  title,
                  is_important: true,
                  confirmation_state: "unread",
                  content_revision: "1",
                  published_at: "2026-09-28T00:00:00.000Z",
                },
              ],
            },
          })}
        />
      </MemoryRouter>,
    );
    const link = screen.getByRole("link", { name: new RegExp(title) });
    expect(link).toHaveAttribute("href", "/notices/long");
    expect(within(link).getByText(title)).toHaveTextContent(title);
  });
  it("공지는 최근부터, 준비물·숙제는 가까운 날부터 잇고, 공지 날짜는 한국 날짜다", () => {
    const items = homeFeedItems(home(), "student");
    expect(items.map((item) => [item.key, item.kind, item.changed, item.done])).toEqual([
      ["notice-new", "공지", true, false],
      ["notice-old", "공지", false, true],
      ["supply-report", "숙제", false, false],
      ["supply-paint", "준비물", false, true],
    ]);
    expect(items[0]?.meta).toBe("9월 28일 월요일");
    expect(items[2]?.meta).toContain("내일");
  });

  it("선생님은 확인 현황이 있는 글에만 인원 막대 숫자를 붙인다", () => {
    const items = homeFeedItems(
      home({
        teacher_followups: {
          data: [
            {
              content_revision: "2",
              counts: {
                confirmed: 12,
                excluded_member_count: 0,
                modified_unconfirmed: 2,
                unread: 10,
              },
              is_important: true,
              last_reminder_requested_at: null,
              published_at: "2026-09-27T23:00:00.000Z",
              resource_id: "new",
              title: "체육대회 바뀜",
            },
            {
              category: "homework",
              content_revision: "1",
              counts: {
                checked: 17,
                excluded_member_count: 0,
                modified_unconfirmed: 0,
                unchecked: 7,
              },
              last_reminder_requested_at: null,
              needed_on: "2026-09-29",
              resource_id: "report",
              title: "보고서",
            },
          ],
          status: "ok",
        },
      }),
      "teacher",
    );
    expect(Object.fromEntries(items.map((item) => [item.key, item.counts]))).toEqual({
      "notice-new": { done: 12, total: 24 },
      "notice-old": null,
      "supply-paint": null,
      "supply-report": { done: 17, total: 24 },
    });
    expect(items.every((item) => item.done === null)).toBe(true);
  });
});

describe("HomeNewsFeed", () => {
  it("학생 카드는 종류에 맞는 말로 상태를 알리고 글로 이어진다", () => {
    render(
      <MemoryRouter>
        <HomeNewsFeed home={home()} role="student" />
      </MemoryRouter>,
    );
    const feed = screen.getByRole("region", { name: "우리반 소식" });
    const card = (title: string) => within(feed).getByText(title).closest("a") as HTMLElement;
    expect(card("체육대회 바뀜")).toHaveAttribute("href", "/notices/new");
    expect(within(card("체육대회 바뀜")).getByText("바뀜")).toBeVisible();
    expect(within(card("체육대회 바뀜")).getByText("아직 확인 전")).toBeVisible();
    expect(within(card("보고서")).getByText("아직 안 했어요")).toBeVisible();
    expect(within(card("물감")).getByText("챙겼어요")).toBeVisible();
    expect(within(feed).getByRole("link", { name: "전체" })).toHaveAttribute("href", "/updates");
  });

  it("보여 줄 글이 없으면 흐름 자리에 '새 소식이 없어요'를 남긴다", () => {
    render(
      <MemoryRouter>
        <HomeNewsFeed
          home={home({
            notices: { data: [], status: "empty" },
            supplies: { data: [], status: "empty" },
          })}
          role="teacher"
        />
      </MemoryRouter>,
    );
    // 2026-09-27 A안: 홈의 중심 흐름이라 비어도 자리를 지키고, 전체 소식으로 가는 길을 남긴다.
    expect(screen.getByText("새 소식이 없어요.")).toBeVisible();
    expect(screen.getByRole("link", { name: "전체" })).toHaveAttribute("href", "/updates");
  });

  it("불러오지 못한 묶음이 있으면 '새 소식이 없어요'로 단정하지 않는다", () => {
    render(
      <MemoryRouter>
        <HomeNewsFeed
          home={home({
            notices: { data: [], message: "raw notice detail", status: "error" },
            supplies: { data: [], status: "empty" },
          })}
          role="student"
        />
      </MemoryRouter>,
    );
    // 서버 문구(raw)는 싣지 않고 정해진 이름만 알린다.
    expect(screen.getByRole("alert")).toHaveTextContent("공지 정보를 불러오지 못했어요.");
    expect(screen.queryByText(/raw/u)).not.toBeInTheDocument();
    expect(screen.queryByText("새 소식이 없어요.")).not.toBeInTheDocument();
  });
});

import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";

import type { HomeResponse } from "../../api/auth";
import { TeacherTaskStrip, TeacherTasksPanel } from "./teacher-task-strip";

function home(pending: number, members: number | null): HomeResponse {
  return {
    attendance: {
      data: { absent: 1, acknowledged: 0, early: 0, late: 1, pending, total: 2 },
      status: "ok",
    },
    pending_member_count: members,
  } as unknown as HomeResponse;
}

function renderStrip(value: HomeResponse, help: number) {
  return render(
    <MemoryRouter>
      <TeacherTaskStrip helpRequestCount={help} home={value} />
    </MemoryRouter>,
  );
}

describe("TeacherTaskStrip", () => {
  it("출결·도움·가입 중 처리할 것만 모아 합계와 함께 각 처리 화면으로 잇는다", () => {
    renderStrip(home(2, 1), 1);
    const strip = screen.getByRole("navigation", { name: "처리할 일" });
    expect(within(strip).getByText("4")).toBeVisible();
    expect(
      within(strip)
        .getAllByRole("link")
        .map((link) => [link.textContent, link.getAttribute("href")]),
    ).toEqual([
      ["출결 확인2건", "/attendance"],
      ["도움 요청1건", "/help-requests"],
      ["참여 요청1건", "/members/manage"],
      ["기간별 확인 현황", "/updates/followups"],
    ]);
  });

  it("0건인 항목은 빼고, 모두 0이어도 기간별 확인 현황 진입을 유지한다", () => {
    const { unmount } = renderStrip(home(0, 3), 0);
    expect(
      within(screen.getByRole("navigation", { name: "처리할 일" }))
        .getAllByRole("link")
        .map((link) => link.getAttribute("href")),
    ).toEqual(["/members/manage", "/updates/followups"]);
    unmount();
    renderStrip(home(0, null), 0);
    const entry = screen.getByRole("link", { name: "기간별 확인 현황" });
    expect(entry).toHaveAttribute("href", "/updates/followups");
    expect(entry).toHaveClass("min-h-11");
    expect(entry).toHaveAttribute("title", "학생별 미해결 모아보기");
    entry.focus();
    expect(entry).toHaveFocus();
    expect(screen.queryByText("0")).not.toBeInTheDocument();
  });
});

it("출결과 가입 수가 확인되지 않으면 PC에서 처리할 일이 없다고 단정하지 않는다", () => {
  const value = {
    ...home(0, null),
    attendance: {
      status: "error",
      data: null,
      error_code: "ATTENDANCE_QUERY_FAILED",
      message: "synthetic",
    },
  } as HomeResponse;
  render(
    <MemoryRouter>
      <TeacherTasksPanel home={value} helpRequestCount={0} />
    </MemoryRouter>,
  );
  expect(screen.queryByText("처리할 일이 없어요.")).not.toBeInTheDocument();
  expect(screen.getByRole("link", { name: "출결 수 확인 불가 · 목록 보기" })).toHaveAttribute(
    "href",
    "/attendance",
  );
  expect(screen.getByRole("link", { name: "참여 요청 수 확인 불가 · 목록 보기" })).toHaveAttribute(
    "href",
    "/members/manage",
  );
});

describe.each([TeacherTaskStrip, TeacherTasksPanel])(
  "교사 처리할 일의 반응형 확인 상태",
  (Component) => {
    it("실패 출결의 과거 양수는 표시하지 않고 확인된 가입 숫자만 유지한다", () => {
      const value = {
        ...home(99, 3),
        attendance: {
          ...home(99, 3).attendance,
          status: "error",
          error_code: "ATTENDANCE_QUERY_FAILED",
          message: "synthetic",
        },
      } as HomeResponse;
      render(
        <MemoryRouter>
          <Component home={value} helpRequestCount={0} />
        </MemoryRouter>,
      );
      expect(screen.getByRole("link", { name: "출결 수 확인 불가 · 목록 보기" })).toHaveAttribute(
        "href",
        "/attendance",
      );
      expect(screen.getByRole("link", { name: /참여 요청\s*3건/ })).toHaveAttribute(
        "href",
        "/members/manage",
      );
      expect(screen.queryByText("99건")).not.toBeInTheDocument();
      expect(screen.queryByText("처리할 일이 없어요.")).not.toBeInTheDocument();
    });
    it("가입 null은 미확인 링크이며 0건으로 바꾸거나 정상 출결 링크를 중복하지 않는다", () => {
      render(
        <MemoryRouter>
          <Component home={home(2, null)} helpRequestCount={0} />
        </MemoryRouter>,
      );
      expect(screen.getByRole("link", { name: "참여 요청 수 확인 불가 · 목록 보기" })).toHaveClass(
        "min-h-11",
      );
      expect(screen.getByRole("link", { name: /출결 확인\s*2건/ })).toHaveAttribute(
        "href",
        "/attendance",
      );
      expect(screen.queryByText("0건")).not.toBeInTheDocument();
      expect(
        screen.queryByRole("link", { name: "출결 수 확인 불가 · 목록 보기" }),
      ).not.toBeInTheDocument();
    });
    it("오류에서 정상 0건으로 갱신되면 확인불가 안내를 제거한다", () => {
      const failed = {
        ...home(0, null),
        attendance: {
          status: "error",
          data: null,
          error_code: "ATTENDANCE_QUERY_FAILED",
          message: "synthetic",
        },
      } as HomeResponse;
      const view = render(
        <MemoryRouter>
          <Component home={failed} helpRequestCount={0} />
        </MemoryRouter>,
      );
      expect(
        screen.getByRole("link", { name: "출결 수 확인 불가 · 목록 보기" }),
      ).toBeInTheDocument();
      view.rerender(
        <MemoryRouter>
          <Component home={home(0, 0)} helpRequestCount={0} />
        </MemoryRouter>,
      );
      expect(screen.queryByText(/확인 불가 · 목록 보기/)).not.toBeInTheDocument();
      expect(screen.getByRole("link", { name: "기간별 확인 현황" })).toHaveAttribute(
        "href",
        "/updates/followups",
      );
      if (Component === TeacherTasksPanel)
        expect(screen.getByText("처리할 일이 없어요.")).toBeInTheDocument();
    });
    it("꺼진 출결 기능은 미확인으로 오인하거나 목록 링크를 노출하지 않는다", () => {
      const disabledHome = home(0, 0);
      delete disabledHome.attendance;
      render(
        <MemoryRouter>
          <Component home={disabledHome} helpRequestCount={0} />
        </MemoryRouter>,
      );
      expect(document.querySelector('a[href="/attendance"]')).not.toBeInTheDocument();
    });
  },
);
it("모바일의 일부 확인 숫자를 전체 합계로 표시하지 않는다", () => {
  renderStrip(home(2, null), 1);
  expect(screen.getByLabelText("전체 건수 확인 불가")).toHaveTextContent("…");
  expect(screen.queryByText("3")).not.toBeInTheDocument();
});

describe("모바일 처리할 일 성공0건 안내", () => {
  it("모든 조회가 성공한0건은 같은 제목줄에서 명시적으로 알린다", () => {
    renderStrip(home(0, 0), 0);
    const strip = screen.getByRole("navigation", { name: "처리할 일" });
    expect(within(strip).getByText("처리할 일이 없어요.")).toBeVisible();
    expect(within(strip).queryByText("처리할 일")).not.toBeInTheDocument();
    expect(within(strip).getAllByRole("link")).toHaveLength(1);
    expect(within(strip).getByRole("link", { name: "기간별 확인 현황" })).toHaveAttribute(
      "href",
      "/updates/followups",
    );
  });
  it.each(["loading", "error"] as const)("도움 조회%s는 정상0건으로 안내하지 않는다", (status) => {
    render(
      <MemoryRouter>
        <TeacherTaskStrip home={home(0, 0)} helpRequestCount={0} helpRequestState={{ status }} />
      </MemoryRouter>,
    );
    expect(screen.queryByText("처리할 일이 없어요.")).not.toBeInTheDocument();
    expect(screen.getByLabelText("전체 건수 확인 불가")).toHaveTextContent("…");
    expect(
      screen.getByRole("link", {
        name: status === "loading" ? "도움 요청 확인 중…" : "도움 요청 수 확인 불가 · 목록 보기",
      }),
    ).toHaveAttribute("href", "/help-requests");
  });
});

// 2026-10-21 첫 사용 점검: 빈 반 교사 홈은 칠판 쓰기만 권해서 첫 학생을 부르는 길이 보이지 않았다.
describe.each([TeacherTaskStrip, TeacherTasksPanel])("빈 반의 학생 초대 안내", (Component) => {
  const withStudents = (active: number | undefined, pending: number | null) =>
    ({ ...home(0, pending), active_student_count: active }) as HomeResponse;
  const inviteLink = () =>
    screen.queryByRole("link", { name: "아직 학생이 없어요 · 학생 초대하기" });

  it("승인 학생도 참여 요청도 없으면 초대 코드가 있는 반 관리로 잇는다", () => {
    render(
      <MemoryRouter>
        <Component home={withStudents(0, 0)} helpRequestCount={0} />
      </MemoryRouter>,
    );
    expect(inviteLink()).toHaveAttribute("href", "/class/manage");
    expect(inviteLink()).toHaveClass("min-h-11");
  });

  it.each([
    ["승인 학생이 있으면", 3, 0],
    ["참여 요청이 기다리면", 0, 1],
    ["학생 수를 모르면", undefined, 0],
    ["요청 수를 모르면", 0, null],
  ] as const)("%s 보이지 않는다", (_case, active, pending) => {
    render(
      <MemoryRouter>
        <Component home={withStudents(active, pending)} helpRequestCount={0} />
      </MemoryRouter>,
    );
    expect(inviteLink()).not.toBeInTheDocument();
  });
});

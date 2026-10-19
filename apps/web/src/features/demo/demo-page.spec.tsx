import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DemoPage } from "./demo-page";

function showDemo() {
  return render(
    <MemoryRouter initialEntries={["/demo"]}>
      <DemoPage />
    </MemoryRouter>,
  );
}

function checkCounts(confirmed: number, reconfirm: number, unread: number) {
  const region = screen.getByRole("region", { name: "가상 학급의 공지와 확인 현황" });
  expect(region.querySelector('[data-demo-count="confirmed"]')).toHaveTextContent(`${confirmed}명`);
  expect(region.querySelector('[data-demo-count="reconfirm"]')).toHaveTextContent(`${reconfirm}명`);
  expect(region.querySelector('[data-demo-count="unread"]')).toHaveTextContent(`${unread}명`);
}

function revise() {
  fireEvent.click(screen.getByRole("button", { name: "장소 변경해 보기" }));
}
function remind() {
  fireEvent.click(screen.getByRole("button", { name: "앱 내 재알림 예시 등록" }));
}
function confirm() {
  fireEvent.click(screen.getByRole("button", { name: "최신 내용 다시 확인" }));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("public example experience", () => {
  it("starts with four fictional students and never asks for personal data", () => {
    showDemo();
    checkCounts(3, 0, 1);
    expect(
      within(screen.getByRole("list", { name: "가상 학생별 확인 상태" })).getAllByRole("listitem"),
    ).toHaveLength(4);
    expect(screen.getByText(/모든 이름과 숫자는 가상 예시/)).toBeVisible();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "처음부터 체험" })).toBeDisabled();
  });

  it("moves only previous confirmations to reconfirmation after editing", () => {
    showDemo();
    revise();
    checkCounts(0, 3, 1);
    expect(screen.getByRole("heading", { name: "다시 확인할 학생을 한눈에" })).toHaveFocus();
    expect(screen.getByText("강당", { selector: "mark" })).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent("최신 내용 확인은 0명");
  });

  it("registering the example reminder does not confirm the notice for any student", () => {
    showDemo();
    revise();
    remind();
    checkCounts(0, 3, 1);
    expect(screen.getByRole("status")).toHaveTextContent("학생들의 확인 상태는 그대로");
    expect(screen.getByText("예시 학생 1의 화면")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "앱 내 재알림 예시 등록" }),
    ).not.toBeInTheDocument();
  });

  it("does not let a repeated teacher reminder click impersonate the student's action", () => {
    showDemo();
    revise();
    const reminder = screen.getByRole("button", { name: "앱 내 재알림 예시 등록" });
    fireEvent.click(reminder);
    fireEvent.click(reminder, { detail: 2 });
    checkCounts(0, 3, 1);
    expect(screen.getByRole("button", { name: "최신 내용 다시 확인" })).toBeVisible();
    expect(reminder).not.toBeInTheDocument();
  });

  it("updates exactly one student only after their explicit confirmation", () => {
    showDemo();
    revise();
    remind();
    confirm();
    checkCounts(1, 2, 1);
    const students = within(screen.getByRole("list", { name: "가상 학생별 확인 상태" }));
    expect(students.getAllByText("최신 내용 확인")).toHaveLength(1);
    expect(students.getAllByText("재확인 필요")).toHaveLength(2);
    expect(screen.getByRole("link", { name: "가입 화면으로 이동" })).toHaveAttribute(
      "href",
      "/sign-up",
    );
    expect(screen.queryByRole("button", { name: "최신 내용 다시 확인" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "로그인" })).toHaveAttribute("href", "/login");
  });

  it("resets the full experience and starts fresh after remounting", () => {
    const view = showDemo();
    revise();
    remind();
    confirm();
    fireEvent.click(screen.getByRole("button", { name: "처음부터 체험" }));
    checkCounts(3, 0, 1);
    expect(screen.getByRole("heading", { name: "안내가 바뀌면, 확인도 새롭게" })).toHaveFocus();
    revise();
    view.unmount();
    showDemo();
    checkCounts(3, 0, 1);
  });

  it("finishes and resets without API requests or writing browser storage", () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    const store = vi.spyOn(Storage.prototype, "setItem");
    showDemo();
    revise();
    remind();
    confirm();
    fireEvent.click(screen.getByRole("button", { name: "처음부터 체험" }));
    expect(fetch).not.toHaveBeenCalled();
    expect(store).not.toHaveBeenCalled();
  });
});

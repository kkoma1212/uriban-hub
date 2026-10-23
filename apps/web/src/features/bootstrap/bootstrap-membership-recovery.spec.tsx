import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BootstrapPage } from "./bootstrap-page";

const initial = {
  account: {
    display_name: "검수 학생",
    email_verified: true,
    is_active: true,
    signup_role: "student",
  },
  allowed_actions: ["REQUEST_MEMBERSHIP", "LOGOUT", "DELETE_ACCOUNT", "CHANGE_PASSWORD"],
  current_class: null,
  current_membership: null,
  destination: "ENTER_INVITE_CODE",
  last_membership_status: null,
  last_status_reason: null,
  server_today: "2026-09-10",
  teacher_profile: null,
};
const pending = {
  ...initial,
  allowed_actions: ["CANCEL_MEMBERSHIP_REQUEST", "LOGOUT", "DELETE_ACCOUNT", "CHANGE_PASSWORD"],
  current_class: { id: "8", name: "검수반", status: "active" },
  current_membership: {
    id: "42",
    class_id: "8",
    role: "student",
    status: "pending",
    student_number: null,
    display_name_in_class: null,
  },
  destination: "MEMBERSHIP_PENDING",
};
const response = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });

describe("membership response recovery", () => {
  afterEach(() => vi.restoreAllMocks());
  it("checks approval on demand and enters home only after the server approves membership", async () => {
    let approved = false;
    const request = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (input === "/api/v1/public/system-state")
        return response({ maintenance: false, announcement: null });
      expect(input).toBe("/api/v1/bootstrap");
      expect(init?.method ?? "GET").toBe("GET");
      return response(
        approved
          ? {
              ...pending,
              destination: "HOME",
              allowed_actions: ["VIEW_CLASS", "LOGOUT"],
              current_membership: { ...pending.current_membership, status: "approved" },
            }
          : pending,
      );
    });
    render(
      <MemoryRouter initialEntries={["/bootstrap"]}>
        <Routes>
          <Route path="/bootstrap" element={<BootstrapPage />} />
          <Route path="/home" element={<h1>승인 후 오늘 화면</h1>} />
        </Routes>
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "승인 상태 확인" }));
    await waitFor(() =>
      expect(request.mock.calls.filter(([input]) => input === "/api/v1/bootstrap")).toHaveLength(2),
    );
    expect(
      await screen.findByRole("heading", { name: "반 참여 승인을 기다리고 있어요" }),
    ).toBeVisible();
    expect(screen.queryByText("승인 후 오늘 화면")).not.toBeInTheDocument();
    approved = true;
    fireEvent.click(screen.getByRole("button", { name: "승인 상태 확인" }));
    expect(await screen.findByRole("heading", { name: "승인 후 오늘 화면" })).toBeVisible();
    expect(request.mock.calls.filter(([input]) => input === "/api/v1/bootstrap")).toHaveLength(3);
  });
  async function submit() {
    render(
      <MemoryRouter initialEntries={["/bootstrap"]}>
        <BootstrapPage />
      </MemoryRouter>,
    );
    fireEvent.change(await screen.findByLabelText("반 초대 코드"), {
      target: { value: "ABCDEFGH" },
    });
    fireEvent.click(screen.getByRole("button", { name: "반 참여 요청 보내기" }));
  }
  function mockRequest(nextState: typeof initial | typeof pending, status = 502) {
    vi.spyOn(Document.prototype, "cookie", "get").mockReturnValue(
      "__Host-classhub_csrf=fixture-csrf",
    );
    let requested = false;
    return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (input === "/api/v1/public/system-state")
        return response({ maintenance: false, announcement: null });
      if (input === "/api/v1/bootstrap") return response(requested ? nextState : initial);
      if (input === "/api/v1/membership-requests") {
        requested = true;
        return response(
          {
            error: {
              code: status === 502 ? "UNEXPECTED_RESPONSE" : "INVITE_CODE_INVALID_OR_EXPIRED",
              message: "요청 결과를 확인하지 못했어요.",
            },
          },
          status,
        );
      }
      throw new Error("Unexpected fixture endpoint");
    });
  }
  it("recovers the committed membership after a lost response without posting it again", async () => {
    const request = mockRequest(pending);
    await submit();
    expect(await screen.findByRole("button", { name: "반 참여 요청 취소" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "반 참여 요청 보내기" })).not.toBeInTheDocument();
    expect(screen.getByText("반 참여 상태를 다시 확인했어요.")).toBeInTheDocument();
    expect(
      request.mock.calls.filter(([input]) => input === "/api/v1/membership-requests"),
    ).toHaveLength(1);
  });
  it("does not announce success when the authoritative state has no membership", async () => {
    const request = mockRequest(initial);
    await submit();
    expect(await screen.findByRole("alert")).toHaveTextContent("요청 결과를 확인하지 못했어요.");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "반 참여 요청 보내기" })).toBeEnabled(),
    );
    expect(screen.queryByRole("button", { name: "반 참여 요청 취소" })).not.toBeInTheDocument();
    expect(
      request.mock.calls.filter(([input]) => input === "/api/v1/membership-requests"),
    ).toHaveLength(1);
  });
  it("keeps definite invite-code validation errors without a recovery lookup", async () => {
    const request = mockRequest(initial, 400);
    await submit();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "반 초대 코드가 올바르지 않거나 만료됐어요. 선생님에게 새 코드를 확인해 주세요.",
    );
    expect(request.mock.calls.filter(([input]) => input === "/api/v1/bootstrap")).toHaveLength(1);
  });
});

describe("초대 코드 오류의 입력칸 가까운 피드백", () => {
  afterEach(() => vi.restoreAllMocks());
  const show = () =>
    render(
      <MemoryRouter initialEntries={["/bootstrap"]}>
        <BootstrapPage />
      </MemoryRouter>,
    );
  function mockMemberRequest(status = 400) {
    vi.spyOn(Document.prototype, "cookie", "get").mockReturnValue(
      "__Host-classhub_csrf=fixture-csrf",
    );
    return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (input === "/api/v1/public/system-state")
        return response({ maintenance: false, announcement: null });
      if (input === "/api/v1/bootstrap") return response(initial);
      if (input === "/api/v1/membership-requests")
        return response(
          {
            error: {
              code: status === 400 ? "INVITE_CODE_INVALID_OR_EXPIRED" : "UNEXPECTED_RESPONSE",
              message: status === 400 ? "invalid invite" : "요청 결과를 확인하지 못했어요.",
            },
          },
          status,
        );
      if (String(input).includes("/past-classes")) return response({ items: [] });
      throw Error("unexpected synthetic endpoint");
    });
  }
  it("형식 오류는 입력 바로 아래 한 번만 표시하고 초점을 입력칸으로 돌린다", async () => {
    const request = mockMemberRequest();
    show();
    const input = await screen.findByLabelText("반 초대 코드");
    fireEvent.change(input, { target: { value: "ABC" } });
    const button = screen.getByRole("button", { name: "반 참여 요청 보내기" });
    button.focus();
    fireEvent.click(button);
    const error = await screen.findByText(
      "반 초대 코드는 혼동 문자를 제외한 영문 대문자와 숫자 8자리입니다.",
    );
    expect(input.nextElementSibling).toBe(error);
    expect(error).toHaveAttribute("id", "invite-code-error");
    expect(error.closest("form")).toBe(input.closest("form"));
    expect(input).toHaveAttribute("aria-describedby", "invite-code-next-step invite-code-error");
    expect(input).toHaveFocus();
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(document.getElementById("bootstrap-error")).toBeNull();
    expect(
      request.mock.calls.filter(([path]) => path === "/api/v1/membership-requests"),
    ).toHaveLength(0);
    fireEvent.change(input, { target: { value: "ABCDEFGH" } });
    expect(screen.queryByText(/혼동 문자를 제외한 영문/)).not.toBeInTheDocument();
    expect(input).not.toHaveAttribute("aria-invalid", "true");
  });
  it("만료 오류도 입력 바로 아래에 표시하며 명시적 재시도와 입력값을 유지한다", async () => {
    const request = mockMemberRequest();
    show();
    const input = await screen.findByLabelText("반 초대 코드");
    fireEvent.change(input, { target: { value: "ABCDEFGH" } });
    const button = screen.getByRole("button", { name: "반 참여 요청 보내기" });
    button.focus();
    fireEvent.click(button);
    const error = await screen.findByText(
      "반 초대 코드가 올바르지 않거나 만료됐어요. 선생님에게 새 코드를 확인해 주세요.",
    );
    expect(input.nextElementSibling).toBe(error);
    expect(input).toHaveValue("ABCDEFGH");
    expect(input).toHaveFocus();
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    await waitFor(() => expect(button).toBeEnabled());
    expect(
      request.mock.calls.filter(([path]) => path === "/api/v1/membership-requests"),
    ).toHaveLength(1);
  });
  it("전송 결과 불명확은 코드 오류로 바꾸지 않고 기존 상태 재조회와 안내를 유지한다", async () => {
    const request = mockMemberRequest(502);
    show();
    const input = await screen.findByLabelText("반 초대 코드");
    fireEvent.change(input, { target: { value: "ABCDEFGH" } });
    const button = screen.getByRole("button", { name: "반 참여 요청 보내기" });
    button.focus();
    fireEvent.click(button);
    const error = await screen.findByText("요청 결과를 확인하지 못했어요.");
    expect(error).toHaveAttribute("id", "bootstrap-error");
    expect(error.closest("form")).toBeNull();
    expect(input).not.toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveValue("ABCDEFGH");
    expect(button).toHaveFocus();
    expect(request.mock.calls.filter(([path]) => path === "/api/v1/bootstrap")).toHaveLength(2);
    expect(
      request.mock.calls.filter(([path]) => path === "/api/v1/membership-requests"),
    ).toHaveLength(1);
  });
});

// 2026-10-21 첫 사용 점검: 승인 대기 교사 화면에 진한 주 단추가 둘이었고, 승인번호를 어떻게 받는지 안내가 없었다.
describe("teacher waiting for administrator approval", () => {
  afterEach(() => vi.restoreAllMocks());
  it("says the code arrives by email and keeps the code confirmation as the only primary action", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (input === "/api/v1/public/system-state")
        return response({ maintenance: false, announcement: null });
      return response({
        ...initial,
        account: { ...initial.account, display_name: "검수 교사", signup_role: "teacher" },
        allowed_actions: ["CONFIRM_SIGNUP_APPROVAL", "LOGOUT", "DELETE_ACCOUNT"],
        destination: "SIGNUP_APPROVAL_REQUIRED",
      });
    });
    render(
      <MemoryRouter initialEntries={["/bootstrap"]}>
        <BootstrapPage />
      </MemoryRouter>,
    );
    const statusCheck = await screen.findByRole("button", { name: "승인 상태 확인" });
    expect(statusCheck).toHaveClass("ui-button-secondary");
    expect(statusCheck).not.toHaveClass("ui-button-primary");
    expect(screen.getByRole("button", { name: "교사 승인 확인" })).toHaveClass("ui-button-primary");
    expect(screen.getByText(/가입한 이메일로 승인번호를 보내요/u)).toBeVisible();
    expect(screen.getByLabelText("교사 승인번호")).toHaveAttribute("placeholder", "6자리 승인번호");
  });
});

import { fireEvent, render as testingRender, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { confirmSignupApproval, confirmSignupRole, resendSignupApproval } from "../../api/auth";
import {
  clearRequestCooldown,
  currentRequestCooldown,
  rememberRequestCooldown,
} from "../../lib/request-cooldown";
import { RequestCooldownNotice } from "../auth/request-cooldown";
import { SignupApprovalForm } from "./signup-approval-form";

vi.mock("../../api/auth", () => ({
  confirmSignupApproval: vi.fn(),
  confirmSignupRole: vi.fn(),
  resendSignupApproval: vi.fn(),
}));
beforeEach(() => {
  vi.clearAllMocks();
  clearRequestCooldown("/bootstrap");
  clearRequestCooldown("/sign-up");
});
function render(element: React.ReactNode) {
  return testingRender(<MemoryRouter initialEntries={["/bootstrap"]}>{element}</MemoryRouter>);
}

describe("post-registration approval", () => {
  it("keeps verified teachers waiting for an administrator code without another email resend", async () => {
    const onApproved = vi.fn().mockResolvedValue(undefined);
    vi.mocked(confirmSignupApproval).mockResolvedValue({
      signup_approved: true,
      next_action: "BOOTSTRAP",
    });
    render(<SignupApprovalForm onApproved={onApproved} signupRole="teacher" emailVerified />);
    expect(screen.getByText(/관리자가 선생님임을 확인/)).toBeVisible();
    expect(screen.getByText(/48시간 동안 유효/)).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "인증번호 메일 다시 보내기" }),
    ).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("교사 승인번호"), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "교사 승인 확인" }));
    await waitFor(() => expect(onApproved).toHaveBeenCalledOnce());
    expect(resendSignupApproval).not.toHaveBeenCalled();
  });
  it("asks only legacy accounts to record a missing type and refreshes before approval", async () => {
    const onApproved = vi.fn().mockResolvedValue(undefined);
    vi.mocked(confirmSignupRole).mockResolvedValue({ signup_role: "student" });
    render(<SignupApprovalForm onApproved={onApproved} signupRole={null} />);
    expect(screen.queryByLabelText("가입 인증번호")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "학생" }));
    fireEvent.click(screen.getByRole("button", { name: "가입 유형 확정" }));
    await waitFor(() => expect(onApproved).toHaveBeenCalledOnce());
    expect(confirmSignupRole).toHaveBeenCalledWith("student");
    expect(confirmSignupApproval).not.toHaveBeenCalled();
  });
  it("asks for the emailed code after signup and rejects an incomplete code locally", async () => {
    render(<SignupApprovalForm onApproved={vi.fn()} signupRole="student" />);
    expect(screen.getByText(/가입한 이메일로 보낸 6자리 인증번호/)).toBeVisible();
    expect(screen.getByText(/10분 동안 유효/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "가입 인증 완료" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("6자리");
    expect(confirmSignupApproval).not.toHaveBeenCalled();
  });

  it("refreshes account permissions only after approval succeeds, clearing the code", async () => {
    const onApproved = vi.fn().mockResolvedValue(undefined);
    vi.mocked(confirmSignupApproval).mockResolvedValue({
      signup_approved: true,
      next_action: "BOOTSTRAP",
    });
    render(<SignupApprovalForm onApproved={onApproved} signupRole="student" />);
    fireEvent.change(screen.getByLabelText("가입 인증번호"), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "가입 인증 완료" }));
    await waitFor(() => expect(onApproved).toHaveBeenCalledOnce());
    expect(confirmSignupApproval).toHaveBeenCalledWith("123456");
    expect(screen.getByLabelText("가입 인증번호")).toHaveValue("");
  });

  it("keeps the pending screen and permits retry when the server rejects a code", async () => {
    const onApproved = vi.fn();
    vi.mocked(confirmSignupApproval).mockRejectedValue(
      new Error("가입 승인번호를 확인할 수 없습니다."),
    );
    render(<SignupApprovalForm onApproved={onApproved} signupRole="student" />);
    fireEvent.change(screen.getByLabelText("가입 인증번호"), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "가입 인증 완료" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "가입 승인번호를 확인할 수 없습니다.",
    );
    expect(onApproved).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "가입 인증 완료" })).toBeEnabled();
  });
  it("resends the signup code and reports its delivery outcome", async () => {
    vi.mocked(resendSignupApproval).mockResolvedValue({
      email_delivery_status: "sent",
      expires_at: "2026-09-09T00:10:00Z",
    });
    render(<SignupApprovalForm onApproved={vi.fn()} signupRole="student" />);
    fireEvent.click(screen.getByRole("button", { name: "인증번호 메일 다시 보내기" }));
    expect(await screen.findByRole("status")).toHaveTextContent("유효한 번호는 그대로 유지돼요.");
    expect(resendSignupApproval).toHaveBeenCalledOnce();
  });

  it("removes only the completed verification notice before entering the next bootstrap step", async () => {
    const limit = {
      retry_after_seconds: 60,
      max_attempts: 3,
      remaining_attempts: 2,
      cooldown_seconds: 60,
    };
    rememberRequestCooldown(limit, "/bootstrap");
    rememberRequestCooldown(limit, "/sign-up");
    const otherScope = currentRequestCooldown("/sign-up");
    const onApproved = vi.fn().mockImplementation(async () => {
      expect(currentRequestCooldown("/bootstrap")).toBeUndefined();
    });
    vi.mocked(confirmSignupApproval).mockResolvedValue({
      signup_approved: true,
      next_action: "BOOTSTRAP",
    });
    render(
      <>
        <RequestCooldownNotice />
        <SignupApprovalForm onApproved={onApproved} signupRole="student" />
      </>,
    );
    expect(screen.getByRole("status")).toHaveTextContent("총 3회 중 2회");
    fireEvent.change(screen.getByLabelText("가입 인증번호"), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "가입 인증 완료" }));
    await waitFor(() => expect(onApproved).toHaveBeenCalledOnce());
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(currentRequestCooldown("/sign-up")).toEqual(otherScope);
    const persisted = JSON.parse(sessionStorage.getItem("classhub-request-cooldowns-v1") ?? "[]");
    expect(persisted.some(([scope]: [string]) => scope === "/bootstrap")).toBe(false);
    expect(persisted.some(([scope]: [string]) => scope === "/sign-up")).toBe(true);
  });

  it("preserves the verification limit when a submitted code is rejected", async () => {
    rememberRequestCooldown(
      { retry_after_seconds: 60, max_attempts: 3, remaining_attempts: 1 },
      "/bootstrap",
    );
    const before = currentRequestCooldown("/bootstrap");
    vi.mocked(confirmSignupApproval).mockRejectedValue(new Error("인증번호를 확인해 주세요."));
    const onApproved = vi.fn();
    render(
      <>
        <RequestCooldownNotice />
        <SignupApprovalForm onApproved={onApproved} signupRole="student" />
      </>,
    );
    fireEvent.change(screen.getByLabelText("가입 인증번호"), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "가입 인증 완료" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("인증번호를 확인해 주세요.");
    expect(screen.getByRole("status")).toHaveTextContent("총 3회 중 1회");
    expect(currentRequestCooldown("/bootstrap")).toEqual(before);
    expect(onApproved).not.toHaveBeenCalled();
  });
});

describe("signup code paste (B3-09)", () => {
  it("keeps only digits so a code pasted as '123 456' or '123-456' still fits", () => {
    render(<SignupApprovalForm onApproved={vi.fn()} signupRole="student" />);
    const input = screen.getByLabelText("가입 인증번호");
    fireEvent.change(input, { target: { value: "123 456" } });
    expect(input).toHaveValue("123456");
    fireEvent.change(input, { target: { value: "98-76-54-32" } });
    expect(input).toHaveValue("987654");
  });
});

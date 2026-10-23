import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BootstrapPage } from "./bootstrap-page";

const limiter = vi.hoisted(() => ({ seconds: 0 }));
vi.mock("../auth/request-cooldown", () => ({
  useRequestCooldown: () => limiter.seconds,
  RequestCooldownNotice: () => <p role="status">총 3회 중 2회 시도가 남았어요.</p>,
}));
const initial = {
  account: {
    display_name: "시험 학생",
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
  server_today: "2026-10-11",
  teacher_profile: null,
};
const pending = {
  ...initial,
  allowed_actions: ["CANCEL_MEMBERSHIP_REQUEST", "LOGOUT", "DELETE_ACCOUNT", "CHANGE_PASSWORD"],
  current_class: { id: "10", name: "시험 반", school_name: "시험 중학교", status: "active" },
  current_membership: {
    id: "30",
    class_id: "10",
    role: "student",
    status: "pending",
    student_number: null,
    display_name_in_class: null,
  },
  destination: "MEMBERSHIP_PENDING",
};
const response = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
const show = () =>
  render(
    <MemoryRouter initialEntries={["/bootstrap"]}>
      <BootstrapPage />
    </MemoryRouter>,
  );
describe("pending membership quota visibility", () => {
  beforeEach(() => {
    limiter.seconds = 0;
  });
  afterEach(() => vi.restoreAllMocks());
  it("hides the completed invite quota while keeping approval and cancellation controls", async () => {
    limiter.seconds = 60;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) =>
      response(
        input === "/api/v1/public/system-state"
          ? { maintenance: false, announcement: null }
          : pending,
      ),
    );
    show();
    expect(
      await screen.findByRole("heading", { name: "반 참여 승인을 기다리고 있어요" }),
    ).toBeVisible();
    expect(screen.queryByText(/총 3회/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "승인 상태 확인" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "반 참여 요청 취소" })).toBeEnabled();
    // 요청한 반은 학교와 함께 한 번만 보이고, 다른 반이면 취소하라고 알린다. 뜻 모를 '기준일'은 없다
    // (첫 사용 점검 11·18).
    expect(screen.getByText("다른 반이면 아래 ‘반 참여 요청 취소’를 눌러 주세요.")).toBeVisible();
    expect(screen.getByText("시험 중학교 · 시험 반")).toBeVisible();
    expect(screen.getAllByText(/시험 반/u)).toHaveLength(1);
    expect(screen.queryByText(/기준일/u)).not.toBeInTheDocument();
  });
  it("keeps invite retry information and enforcement before successful membership", async () => {
    limiter.seconds = 60;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) =>
      response(
        input === "/api/v1/public/system-state"
          ? { maintenance: false, announcement: null }
          : initial,
      ),
    );
    show();
    expect(await screen.findByLabelText("반 초대 코드")).toBeVisible();
    expect(screen.getByText(/총 3회/)).toBeVisible();
    expect(screen.getByRole("button", { name: "반 참여 요청 보내기" })).toBeDisabled();
  });
  it("hides quota after successful join but retains delivery failure notice", async () => {
    vi.spyOn(Document.prototype, "cookie", "get").mockReturnValue(
      "__Host-classhub_csrf=fixture-csrf",
    );
    let joined = false;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      if (input === "/api/v1/public/system-state")
        return response({ maintenance: false, announcement: null });
      if (input === "/api/v1/bootstrap") return response(joined ? pending : initial);
      if (input === "/api/v1/membership-requests") {
        joined = true;
        return response({ email_delivery_status: "failed" });
      }
      throw Error("unexpected fixture endpoint");
    });
    show();
    fireEvent.change(await screen.findByLabelText("반 초대 코드"), {
      target: { value: "ABCDEFGH" },
    });
    expect(screen.getByText(/총 3회/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "반 참여 요청 보내기" }));
    expect(
      await screen.findByRole("heading", { name: "반 참여 승인을 기다리고 있어요" }),
    ).toBeVisible();
    expect(screen.queryByText(/총 3회/)).not.toBeInTheDocument();
    expect(screen.getByText(/참여 요청은 접수됐지만 일부 안내 메일/)).toBeVisible();
  });
  it("keeps definite invite errors visible with the quota and permits a retry", async () => {
    vi.spyOn(Document.prototype, "cookie", "get").mockReturnValue(
      "__Host-classhub_csrf=fixture-csrf",
    );
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) =>
      input === "/api/v1/public/system-state"
        ? response({ maintenance: false, announcement: null })
        : input === "/api/v1/bootstrap"
          ? response(initial)
          : response(
              { error: { code: "INVITE_CODE_INVALID_OR_EXPIRED", message: "invalid invite" } },
              400,
            ),
    );
    show();
    fireEvent.change(await screen.findByLabelText("반 초대 코드"), {
      target: { value: "ABCDEFGH" },
    });
    fireEvent.click(screen.getByRole("button", { name: "반 참여 요청 보내기" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "반 초대 코드가 올바르지 않거나 만료됐어요.",
    );
    expect(screen.getByText(/총 3회/)).toBeVisible();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "반 참여 요청 보내기" })).toBeEnabled(),
    );
  });
});

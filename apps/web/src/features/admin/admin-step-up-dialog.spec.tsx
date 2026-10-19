import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stepUpAdmin } from "../../api/admin-auth";
import { adminFetch } from "../../api/admin-request";
import { ApiRequestError } from "../../api/auth";
import { AdminStepUpDialog } from "./admin-step-up-dialog";

vi.mock("../../api/admin-auth", () => ({ stepUpAdmin: vi.fn() }));
vi.mock("../../api/admin-passkeys", () => ({
  getAdminFactors: vi.fn(async () => ({ enabled: false })),
}));
const denied = () =>
  new Response(JSON.stringify({ error: { code: "ADMIN_STEP_UP_REQUIRED", message: "verify" } }), {
    status: 401,
  });
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

async function request() {
  let result!: Promise<Response>;
  act(() => {
    result = adminFetch("/api/v1/admin/accounts", {
      method: "POST",
      body: '{"display_name":"작성 중"}',
    });
  });
  // Attach the rejection observer before a user can cancel/unmount the dialog.
  const settled = result.then(
    (response) => response,
    (error: unknown) => error,
  );
  await screen.findByRole("dialog", { name: "중요 작업 보안 확인" });
  return { settled };
}
function fill() {
  fireEvent.change(screen.getByLabelText("현재 관리자 비밀번호"), {
    target: { value: "Synthetic-current-7" },
  });
  fireEvent.change(screen.getByLabelText("새 6자리 인증번호"), { target: { value: "654321" } });
}

describe("administrator step-up dialog", () => {
  it("focuses password input and resumes only after successful authentication", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(denied())
      .mockResolvedValueOnce(new Response("{}"));
    vi.mocked(stepUpAdmin).mockResolvedValue({
      reauthenticated_at: "2026-09-14T00:00:00Z",
      valid_until: "2026-09-14T00:05:00Z",
    });
    render(<AdminStepUpDialog />);
    const { settled } = await request();
    expect(screen.getByLabelText("현재 관리자 비밀번호")).toHaveFocus();
    fill();
    fireEvent.click(screen.getByRole("button", { name: "확인 후 계속" }));
    expect(await settled).toBeInstanceOf(Response);
    expect(stepUpAdmin).toHaveBeenCalledWith(
      "Synthetic-current-7",
      "654321",
      expect.any(AbortSignal),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1]?.[1]?.body).toBe('{"display_name":"작성 중"}');
  });
  it("keeps failed MFA inside the dialog and clears the used code", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => denied());
    vi.mocked(stepUpAdmin).mockRejectedValue(
      new ApiRequestError("ADMIN_MFA_INVALID", "invalid", 401),
    );
    render(<AdminStepUpDialog />);
    const { settled } = await request();
    fill();
    fireEvent.click(screen.getByRole("button", { name: "확인 후 계속" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "이미 쓴 번호는 다시 사용할 수 없습니다",
    );
    expect(screen.getByLabelText("새 6자리 인증번호")).toHaveValue("");
    expect(fetch).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "취소" }));
    expect(await settled).toMatchObject({ code: "REQUEST_ABORTED" });
  });
  it("cancels on Escape, clears credentials and cancels requests on unmount", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => denied());
    const view = render(<AdminStepUpDialog />);
    const first = await request();
    fill();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(await first.settled).toMatchObject({ code: "REQUEST_ABORTED" });
    const second = await request();
    expect(screen.getByLabelText("현재 관리자 비밀번호")).toHaveValue("");
    expect(screen.getByLabelText("새 6자리 인증번호")).toHaveValue("");
    view.unmount();
    expect(await second.settled).toMatchObject({ code: "REQUEST_ABORTED" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import { StrictMode } from "react";
import * as auth from "../../api/auth";
import { clearAuthenticatedClientState } from "../../lib/authenticated-client-state";
import {
  idempotentCreateStorageKey,
  persistIdempotentCreateAttempt,
} from "../../lib/idempotent-create";
import { TeacherClassManagementPage } from "./teacher-class-management-page";

vi.mock("../../api/auth", async (original) => ({
  ...(await original<object>()),
  getBootstrap: vi.fn(),
  getCurrentClass: vi.fn(),
  getCurrentInviteCode: vi.fn(),
  rotateCurrentInviteCode: vi.fn(),
  updateCurrentClass: vi.fn(),
}));
vi.mock("../layout/app-shell", () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
const bootstrap = {
  account: { display_name: "합성 교사", email_verified: true, is_active: true },
  allowed_actions: ["MANAGE_CLASS"],
  current_membership: { id: "51", class_id: "1", role: "teacher", status: "approved" },
  destination: "HOME",
  server_today: "2026-07-21",
};
const currentClass = {
  id: "1",
  name: "합성 반",
  row_version: "1",
  academic_year: 2026,
  grade: 1,
  active_student_count: 1,
  expected_student_count: 30,
  school_name: "합성 학교",
};
const invite = {
  class_id: "1",
  invite_code: { code: "ABCDEFGH", status: "active", expires_at: "2026-08-04T00:00:00.000Z" },
};
function Exit() {
  const navigate = useNavigate();
  return <button onClick={() => navigate("/other")}>다른 화면</button>;
}
function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/class/manage"]}>
      <Exit />
      <Routes>
        <Route path="/class/manage" element={<TeacherClassManagementPage />} />
        <Route path="/other" element={<p>현재 다른 화면</p>} />
        <Route path="/bootstrap" element={<p>계정 재확인</p>} />
        <Route path="/login" element={<p>로그인 이동</p>} />
      </Routes>
    </MemoryRouter>,
  );
}
function defaults() {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw Error("actual network disabled");
    }),
  );
  vi.mocked(auth.getBootstrap).mockResolvedValue(bootstrap as never);
  vi.mocked(auth.getCurrentClass).mockResolvedValue(currentClass as never);
  vi.mocked(auth.getCurrentInviteCode).mockResolvedValue(invite as never);
}
afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllGlobals();
  sessionStorage.clear();
});
it.each([401, 403])("ignores late bootstrap denial %s after unmount", async (status) => {
  defaults();
  let reject!: (error: unknown) => void;
  vi.mocked(auth.getBootstrap).mockReturnValue(
    new Promise((_, fail) => {
      reject = fail;
    }),
  );
  renderPage();
  fireEvent.click(screen.getByText("다른 화면"));
  await act(async () => reject(new auth.ApiRequestError("AUTH_FAILED", "synthetic", status)));
  expect(screen.getByText("현재 다른 화면")).toBeInTheDocument();
  expect(auth.getCurrentClass).not.toHaveBeenCalled();
});
it("does not begin class reads from an abandoned bootstrap success", async () => {
  defaults();
  let finish!: (value: never) => void;
  vi.mocked(auth.getBootstrap).mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  renderPage();
  fireEvent.click(screen.getByText("다른 화면"));
  await act(async () => finish(bootstrap as never));
  expect(auth.getCurrentClass).not.toHaveBeenCalled();
});
it.each(["unmount", "auth-clear"])(
  "does not restore a rotation request or touch a new record after %s",
  async (boundary) => {
    defaults();
    let reject!: (error: unknown) => void;
    vi.mocked(auth.rotateCurrentInviteCode).mockReturnValue(
      new Promise((_, fail) => {
        reject = fail;
      }),
    );
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "새 코드 (반 초대 코드 재발급)" }));
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "반 초대 코드 재발급" }),
    );
    await waitFor(() => expect(auth.rotateCurrentInviteCode).toHaveBeenCalledTimes(1));
    if (boundary === "unmount") fireEvent.click(screen.getByText("다른 화면"));
    act(() => clearAuthenticatedClientState());
    const key = idempotentCreateStorageKey("invite-code-rotations", "51");
    sessionStorage.setItem(key, "new-account-marker");
    await act(async () => reject(new auth.ApiRequestError("NETWORK_ERROR", "synthetic", 0)));
    expect(sessionStorage.getItem(key)).toBe("new-account-marker");
  },
);
it.each(["unmount", "auth-clear"])(
  "does not read the new account to recover an old save after %s",
  async (boundary) => {
    defaults();
    let reject!: (error: unknown) => void;
    vi.mocked(auth.updateCurrentClass).mockReturnValue(
      new Promise((_, fail) => {
        reject = fail;
      }),
    );
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: "반 이름 · 예상 학생 수 수정" }));
    fireEvent.click(screen.getByRole("button", { name: "저장" }));
    await waitFor(() => expect(auth.updateCurrentClass).toHaveBeenCalledTimes(1));
    if (boundary === "unmount") fireEvent.click(screen.getByText("다른 화면"));
    else act(() => clearAuthenticatedClientState());
    await act(async () =>
      reject(new auth.ApiRequestError("RESOURCE_VERSION_CHANGED", "synthetic", 409)),
    );
    expect(auth.getCurrentClass).toHaveBeenCalledTimes(1);
  },
);
it("keeps the fresh StrictMode load and isolates its abandoned bootstrap denial", async () => {
  defaults();
  let reject!: (error: unknown) => void;
  vi.mocked(auth.getBootstrap)
    .mockReturnValueOnce(
      new Promise((_, fail) => {
        reject = fail;
      }),
    )
    .mockResolvedValue(bootstrap as never);
  render(
    <StrictMode>
      <MemoryRouter initialEntries={["/class/manage"]}>
        <Routes>
          <Route path="/class/manage" element={<TeacherClassManagementPage />} />
          <Route path="/login" element={<p>wrong login</p>} />
        </Routes>
      </MemoryRouter>
    </StrictMode>,
  );
  await screen.findByRole("button", { name: "새 코드 (반 초대 코드 재발급)" });
  await act(async () => reject(new auth.ApiRequestError("AUTH_FAILED", "synthetic", 401)));
  expect(screen.getByRole("img", { name: "반 참여 QR 코드" })).toBeInTheDocument();
  expect(auth.getCurrentClass).toHaveBeenCalledTimes(1);
});
it("does not send a replay mutation after leaving its pending authority check", async () => {
  defaults();
  const key = idempotentCreateStorageKey("invite-code-rotations", "51");
  persistIdempotentCreateAttempt(key, {
    idempotencyKey: "00000000-0000-4000-8000-000000000001",
    request: { previous_code: "ABCDEFGH" },
    serverDate: "2026-07-21",
    startedAt: Date.now(),
  });
  renderPage();
  fireEvent.click(await screen.findByRole("button", { name: "결과 다시 확인" }));
  let finish!: (value: never) => void;
  vi.mocked(auth.getBootstrap).mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  fireEvent.click(
    within(screen.getByRole("dialog")).getByRole("button", { name: "결과 다시 확인" }),
  );
  await waitFor(() => expect(auth.getBootstrap).toHaveBeenCalledTimes(2));
  fireEvent.click(screen.getByText("다른 화면"));
  await act(async () => finish(bootstrap as never));
  expect(auth.rotateCurrentInviteCode).not.toHaveBeenCalled();
  expect(sessionStorage.getItem(key)).not.toBeNull();
  expect(screen.getByText("현재 다른 화면")).toBeInTheDocument();
});
it("isolates a late save recovery read after authentication is cleared", async () => {
  defaults();
  vi.mocked(auth.updateCurrentClass).mockRejectedValue(
    new auth.ApiRequestError("RESOURCE_VERSION_CHANGED", "synthetic", 409),
  );
  let finish!: (value: never) => void;
  vi.mocked(auth.getCurrentClass)
    .mockResolvedValueOnce(currentClass as never)
    .mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
  renderPage();
  fireEvent.click(await screen.findByRole("button", { name: "반 이름 · 예상 학생 수 수정" }));
  fireEvent.click(screen.getByRole("button", { name: "저장" }));
  await waitFor(() => expect(auth.getCurrentClass).toHaveBeenCalledTimes(2));
  act(() => clearAuthenticatedClientState());
  await act(async () => finish({ ...currentClass, name: "abandoned private name" } as never));
  expect(screen.getByText("계정 재확인")).toBeInTheDocument();
  expect(screen.queryByText("abandoned private name")).not.toBeInTheDocument();
});

it("submits the editor form and blocks a repeated submit while saving", async () => {
  defaults();
  let finish!: (value: never) => void;
  vi.mocked(auth.updateCurrentClass).mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  renderPage();
  fireEvent.click(await screen.findByRole("button", { name: "반 이름 · 예상 학생 수 수정" }));
  const input = screen.getByRole("textbox", { name: "반 이름" }) as HTMLInputElement;
  expect(input.form).not.toBeNull();
  expect(screen.getByRole("button", { name: "저장" })).toHaveAttribute("type", "submit");
  fireEvent.change(input, { target: { value: "수정한 반" } });
  // 브라우저 Enter의 기본 동작이 발생시키는 form submit 이벤트를 검증한다.
  fireEvent.submit(input.form!);
  fireEvent.submit(input.form!);
  expect(auth.updateCurrentClass).toHaveBeenCalledTimes(1);
  expect(auth.updateCurrentClass).toHaveBeenCalledWith(
    { name: "수정한 반", expected_student_count: 30 },
    "1",
  );
  await act(async () => finish({ ...currentClass, name: "수정한 반", row_version: "2" } as never));
  expect(await screen.findByText("반 정보를 저장했습니다.")).toBeVisible();
});
it("links field errors and focuses the first invalid input without requesting a save", async () => {
  defaults();
  renderPage();
  fireEvent.click(await screen.findByRole("button", { name: "반 이름 · 예상 학생 수 수정" }));
  const name = screen.getByRole("textbox", { name: "반 이름" }) as HTMLInputElement;
  const count = screen.getByRole("spinbutton", { name: "예상 학생 수" });
  fireEvent.change(name, { target: { value: " " } });
  fireEvent.change(count, { target: { value: "0" } });
  fireEvent.submit(name.form!);
  expect(name).toHaveFocus();
  expect(name).toHaveAttribute("aria-invalid", "true");
  expect(name).toHaveAccessibleDescription("반 이름은 1자 이상 40자 이하로 입력해 주세요.");
  expect(count).toHaveAccessibleDescription("예상 학생 수는 1명 이상 60명 이하로 입력해 주세요.");
  expect(auth.updateCurrentClass).not.toHaveBeenCalled();
  fireEvent.change(name, { target: { value: "수정한 반" } });
  expect(name).not.toHaveAttribute("aria-invalid");
  fireEvent.submit(name.form!);
  expect(count).toHaveFocus();
  expect(auth.updateCurrentClass).not.toHaveBeenCalled();
});

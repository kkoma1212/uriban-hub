import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import { ApiRequestError, getBootstrap, getHome, logout } from "../../api/auth";
import { HomePage } from "./home-page";

vi.mock("../../api/auth", async (original) => ({
  ...(await original<object>()),
  getBootstrap: vi.fn(),
  getHome: vi.fn(),
  logout: vi.fn(),
}));
vi.mock("./student-home-dashboard", () => ({
  StudentHomeDashboard: ({ onLogout }: { onLogout: () => void }) => (
    <button onClick={onLogout}>홈 로그아웃</button>
  ),
}));
vi.mock("../layout/prefetch-tab-pages", () => ({ prefetchTabPages: () => () => {} }));
const bootstrap = {
  account: { display_name: "합성 학생", email_verified: true, is_active: true },
  allowed_actions: ["LOGOUT"],
  current_class: { id: "1", name: "합성 반", status: "active" },
  current_membership: { id: "1", class_id: "1", role: "student", status: "approved" },
  destination: "HOME",
  server_today: "2026-10-11",
  teacher_profile: null,
};
function Exit() {
  const navigate = useNavigate();
  return <button onClick={() => navigate("/other")}>다른 화면</button>;
}
function routes() {
  return (
    <MemoryRouter initialEntries={["/home"]}>
      <Exit />
      <Routes>
        <Route path="/home" element={<HomePage />} />
        <Route path="/other" element={<p>현재 다른 화면</p>} />
        <Route path="/bootstrap" element={<p>시작 안내로 이동됨</p>} />
        <Route path="/login" element={<p>로그인으로 이동됨</p>} />
      </Routes>
    </MemoryRouter>
  );
}
afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});
it.each([401, 403])("ignores a late home %s after leaving home", async (status) => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw Error("actual network disabled");
    }),
  );
  vi.mocked(getBootstrap).mockResolvedValue(bootstrap as never);
  let reject!: (error: unknown) => void;
  vi.mocked(getHome).mockReturnValue(
    new Promise((_, fail) => {
      reject = fail;
    }),
  );
  render(routes());
  await waitFor(() => expect(getHome).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByText("다른 화면"));
  await screen.findByText("현재 다른 화면");
  await act(async () => reject(new ApiRequestError("AUTH_FAILED", "합성 응답", status)));
  expect(screen.getByText("현재 다른 화면")).toBeInTheDocument();
});
it("does not act on a late bootstrap destination after leaving home", async () => {
  let finish!: (value: never) => void;
  vi.mocked(getBootstrap).mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  render(routes());
  fireEvent.click(screen.getByText("다른 화면"));
  await act(async () => finish({ ...bootstrap, destination: "CREATE_CLASS" } as never));
  expect(screen.getByText("현재 다른 화면")).toBeInTheDocument();
  expect(getHome).not.toHaveBeenCalled();
});
it("starts a fresh load after StrictMode cleanup rather than reusing its abandoned request", async () => {
  let rejectFirst!: (error: unknown) => void;
  vi.mocked(getBootstrap)
    .mockReturnValueOnce(
      new Promise((_, fail) => {
        rejectFirst = fail;
      }),
    )
    .mockResolvedValue(bootstrap as never);
  vi.mocked(getHome).mockResolvedValue({ server_today: "2026-10-11" } as never);
  render(<StrictMode>{routes()}</StrictMode>);
  await screen.findByText("홈 로그아웃");
  await act(async () => rejectFirst(new ApiRequestError("FORBIDDEN", "합성 응답", 403)));
  expect(screen.getByText("홈 로그아웃")).toBeInTheDocument();
  expect(getHome).toHaveBeenCalledTimes(1);
});
it.each(["success", "failure"])("ignores late logout %s after leaving home", async (outcome) => {
  vi.mocked(getBootstrap).mockResolvedValue(bootstrap as never);
  vi.mocked(getHome).mockResolvedValue({ server_today: "2026-10-11" } as never);
  let finish!: () => void;
  let reject!: (error: unknown) => void;
  vi.mocked(logout).mockReturnValue(
    new Promise((resolve, fail) => {
      finish = resolve;
      reject = fail;
    }),
  );
  render(routes());
  fireEvent.click(await screen.findByText("홈 로그아웃"));
  fireEvent.click(screen.getByText("다른 화면"));
  await act(async () => (outcome === "success" ? finish() : reject(Error("합성 실패"))));
  expect(screen.getByText("현재 다른 화면")).toBeInTheDocument();
});

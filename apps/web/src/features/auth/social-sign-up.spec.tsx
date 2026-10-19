import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SignUpPage } from "./sign-up-page";
import { SocialLoginButtons } from "./social-login-buttons";

vi.mock("../legal/use-consent-documents", () => ({
  useConsentDocuments: () => ({
    ready: true,
    documents: undefined,
    error: undefined,
    reload: vi.fn(),
  }),
}));
// 가입 설정(생년월일을 받는지)은 따로 흉내 낸다 — 아래 fetch 호출 검사에 섞이지 않게.
vi.mock("../../api/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/auth")>()),
  getSignUpOptions: () => Promise.resolve({ birth_date_required: false }),
}));
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
function signupPage() {
  render(
    <MemoryRouter initialEntries={["/sign-up?social=1"]}>
      <Routes>
        <Route path="/sign-up" element={<SignUpPage />} />
        <Route path="/bootstrap" element={<p>가입 다음 단계</p>} />
        <Route path="/login" element={<p>로그인 화면</p>} />
      </Routes>
    </MemoryRouter>,
  );
}
afterEach(() => vi.restoreAllMocks());
describe("gated social signup", () => {
  it("shows no login controls when every provider is disabled", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ providers: [] }));
    render(
      <MemoryRouter>
        <SocialLoginButtons />
      </MemoryRouter>,
    );
    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    expect(screen.queryByRole("region", { name: "빠른 로그인" })).not.toBeInTheDocument();
  });
  it("shows all three enabled providers and recovers from a start failure", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) =>
      String(input).endsWith("providers")
        ? json({ providers: ["google", "naver", "kakao"] })
        : json({ code: "RATE_LIMITED", message: "잠시 후 다시 시도해 주세요." }, 429),
    );
    render(
      <MemoryRouter>
        <SocialLoginButtons />
      </MemoryRouter>,
    );
    expect(await screen.findByRole("button", { name: "Google 계정으로 로그인" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "네이버 로그인" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "카카오 로그인" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Google 계정으로 로그인" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("빠른 로그인을 시작하지 못했어요");
    expect(screen.getByRole("button", { name: "Google 계정으로 로그인" })).toBeEnabled();
  });
  it("keeps age and consent choices while omitting the password from a successful signup", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (_input, init) =>
        init?.method === "POST"
          ? json({ next_action: "BOOTSTRAP" }, 201)
          : json({ provider: "google", email: "social@example.test", email_verified: true }),
      );
    signupPage();
    await screen.findByText(/구글 계정을 확인했어요/u);
    expect(screen.queryByLabelText("이메일")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "학생" }));
    fireEvent.click(screen.getByRole("button", { name: "다음" }));
    fireEvent.click(await screen.findByRole("radio", { name: "만 14세 이상입니다" }));
    fireEvent.click(screen.getByRole("button", { name: "다음" }));
    expect(await screen.findByLabelText("이메일")).toHaveValue("social@example.test");
    expect(screen.queryByLabelText("비밀번호")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("기본 이름"), { target: { value: "소셜 학생" } });
    fireEvent.click(screen.getByRole("button", { name: "다음" }));
    await screen.findByLabelText("필수 항목 모두 동의");
    fireEvent.click(screen.getByRole("button", { name: /가입하기/u }));
    await screen.findByText("이용약관 동의가 필요해요.");
    expect(fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
    fireEvent.click(screen.getByLabelText("필수 항목 모두 동의"));
    fireEvent.click(screen.getByRole("button", { name: /가입하기/u }));
    await screen.findByText("가입 다음 단계");
    const sent = fetch.mock.calls.find(([, init]) => init?.method === "POST")!;
    expect(sent[0]).toBe("/api/v1/auth/social/signup");
    const body = JSON.parse(String(sent[1]?.body));
    expect(body).toMatchObject({
      age_route: "over_14",
      role: "student",
      email: "social@example.test",
      consents: { terms: true, privacy: true },
    });
    expect(body).not.toHaveProperty("password");
  });
  it("pre-fills the provider nickname and sends the photo choice only when ticked", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) =>
      init?.method === "POST"
        ? json({ next_action: "BOOTSTRAP" }, 201)
        : json({
            provider: "kakao",
            email: null,
            email_verified: false,
            display_name: "꼬마선생",
            has_picture: true,
          }),
    );
    signupPage();
    await screen.findByText(/카카오 계정을 확인했어요/u);
    fireEvent.click(screen.getByRole("radio", { name: "학생" }));
    fireEvent.click(screen.getByRole("button", { name: "다음" }));
    fireEvent.click(await screen.findByRole("radio", { name: "만 14세 이상입니다" }));
    fireEvent.click(screen.getByRole("button", { name: "다음" }));
    expect(await screen.findByLabelText("기본 이름")).toHaveValue("꼬마선생");
    const photo = screen.getByRole("checkbox", {
      name: /카카오 프로필 사진을 우리반 허브 사진으로 쓰기/u,
    });
    expect(photo).not.toBeChecked();
    fireEvent.click(photo);
    fireEvent.change(screen.getByLabelText("이메일"), { target: { value: "kid@example.test" } });
    fireEvent.click(screen.getByRole("button", { name: "다음" }));
    fireEvent.click(await screen.findByLabelText("필수 항목 모두 동의"));
    fireEvent.click(screen.getByRole("button", { name: /가입하기/u }));
    await screen.findByText("가입 다음 단계");
    const body = JSON.parse(
      String(fetch.mock.calls.find(([, init]) => init?.method === "POST")![1]?.body),
    );
    expect(body).toMatchObject({ display_name: "꼬마선생", use_provider_picture: true });
  });
  it("goes to the login notice when the server answers neutrally (total audit I1-05)", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) =>
      init?.method === "POST"
        ? json({ next_action: "LOGIN", request_accepted: true }, 201)
        : json({ provider: "kakao", email: null, email_verified: false, display_name: "꼬마" }),
    );
    signupPage();
    await screen.findByText(/카카오 계정을 확인했어요/u);
    fireEvent.click(screen.getByRole("radio", { name: "학생" }));
    fireEvent.click(screen.getByRole("button", { name: "다음" }));
    fireEvent.click(await screen.findByRole("radio", { name: "만 14세 이상입니다" }));
    fireEvent.click(screen.getByRole("button", { name: "다음" }));
    fireEvent.change(await screen.findByLabelText("이메일"), {
      target: { value: "taken@example.test" },
    });
    fireEvent.click(screen.getByRole("button", { name: "다음" }));
    fireEvent.click(await screen.findByLabelText("필수 항목 모두 동의"));
    fireEvent.click(screen.getByRole("button", { name: /가입하기/u }));
    expect(await screen.findByText("로그인 화면")).toBeVisible();
    expect(screen.queryByText("가입 다음 단계")).not.toBeInTheDocument();
  });
  it("does not expose student inputs before guardian approval", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      json({ provider: "naver", email: "child@example.test", email_verified: false }),
    );
    signupPage();
    await screen.findByText(/네이버 계정을 확인했어요/u);
    fireEvent.click(screen.getByRole("radio", { name: "학생" }));
    fireEvent.click(screen.getByRole("button", { name: "다음" }));
    fireEvent.click(
      await screen.findByRole("radio", { name: "만 14세 미만이며 보호자 동의로 가입합니다" }),
    );
    expect(screen.getByLabelText("보호자 이메일")).toBeInTheDocument();
    expect(screen.queryByLabelText("이메일")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("기본 이름")).not.toBeInTheDocument();
  });
  it("prevents a manually forged or expired social query from enabling signup", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      json({ code: "SOCIAL_AUTH_INVALID", message: "만료" }, 401),
    );
    signupPage();
    await screen.findByText(/빠른 로그인 확인이 만료됐어요/u);
    fireEvent.click(screen.getByRole("radio", { name: "학생" }));
    fireEvent.click(screen.getByRole("button", { name: "다음" }));
    fireEvent.click(await screen.findByRole("radio", { name: "만 14세 이상입니다" }));
    fireEvent.click(screen.getByRole("button", { name: "다음" }));
    await screen.findByLabelText("이메일");
    expect(screen.getByRole("button", { name: "다음" })).toBeDisabled();
  });
});

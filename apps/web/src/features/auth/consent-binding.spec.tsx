import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SignUpPage } from "./sign-up-page";
import { GuardianConsentPage } from "./guardian-consent-page";
import type { LegalConsentSnapshot } from "../legal/legal-api";

const snapshot = Object.fromEntries(
  ["terms", "privacy_consent", "privacy_policy", "guardian_consent"].map((type, index) => [
    type,
    {
      id: `00000000-0000-4000-8000-00000000000${index}`,
      policy_version: type + "-1",
      content_sha256: String(index).repeat(64),
    },
  ]),
) as LegalConsentSnapshot;
// 가입 설정(생년월일을 받는지)은 따로 흉내 낸다 — 아래 fetch 호출 검사에 섞이지 않게.
vi.mock("../../api/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/auth")>()),
  getSignUpOptions: () => Promise.resolve({ birth_date_required: false }),
}));
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const bundlePath = "/api/v1/legal/documents/consent-bundle";
function renderSignup() {
  render(
    <MemoryRouter>
      <SignUpPage />
    </MemoryRouter>,
  );
}
const next = () => fireEvent.click(screen.getByRole("button", { name: "다음" }));
/** 1단계 학생 → 2단계 만 14세 이상 → 3단계 계정 정보 → 4단계 동의 화면까지. */
async function selectRoute() {
  fireEvent.click(screen.getByRole("radio", { name: "학생" }));
  next();
  fireEvent.click(await screen.findByRole("radio", { name: "만 14세 이상입니다" }));
  next();
  fireEvent.change(await screen.findByLabelText("이메일"), {
    target: { value: "consent@example.invalid" },
  });
  fireEvent.change(screen.getByLabelText("기본 이름"), { target: { value: "동의 학생" } });
  fireEvent.change(screen.getByLabelText("비밀번호"), { target: { value: "Safe1!x8" } });
  fireEvent.change(screen.getByLabelText("비밀번호 확인"), { target: { value: "Safe1!x8" } });
  next();
  await screen.findByLabelText(/^\(필수\) 이용약관 동의/u);
}
function termsLink() {
  return within(screen.getByRole("button", { name: /가입하기/u }).closest("form")!).getByRole(
    "link",
    { name: /이용약관 전문 보기/u },
  );
}
function fillSignup() {
  fireEvent.click(screen.getByLabelText(/^\(필수\) 이용약관 동의/u));
  fireEvent.click(screen.getByLabelText(/^\(필수\) 개인정보 수집·이용 동의/u));
}
afterEach(() => {
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
});
describe("the displayed consent version is the submitted version", () => {
  it("blocks consent while loading and preserves the four published references at signup", async () => {
    let complete!: (response: Response) => void;
    let submitted: Record<string, unknown> | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      if (url === bundlePath)
        return new Promise<Response>((resolve) => {
          complete = resolve;
        });
      submitted = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return json({ next_action: "LOGIN" }, 201);
    });
    renderSignup();
    await selectRoute();
    expect(screen.getByLabelText(/^\(필수\) 이용약관 동의/u)).toBeDisabled();
    expect(screen.getByRole("button", { name: /가입하기/u })).toBeDisabled();
    complete(json({ binding_required: true, documents: snapshot }));
    await waitFor(() => expect(screen.getByRole("button", { name: /가입하기/u })).toBeEnabled());
    expect(termsLink()).toHaveAttribute("href", "/legal/terms?policy_version=terms-1");
    fillSignup();
    fireEvent.click(screen.getByRole("button", { name: /가입하기/u }));
    await waitFor(() => expect(submitted?.legal_documents).toEqual(snapshot));
    expect(submitted?.consents).toEqual({ terms: true, privacy: true });
  });
  it("clears checks and refreshes references after a changed-document rejection", async () => {
    let reads = 0;
    const newer = { ...snapshot, terms: { ...snapshot.terms, policy_version: "terms-2" } };
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) =>
      url === bundlePath
        ? json({ binding_required: true, documents: ++reads === 1 ? snapshot : newer })
        : json(
            { error: { code: "LEGAL_DOCUMENTS_CHANGED", message: "문서를 다시 확인해 주세요." } },
            409,
          ),
    );
    renderSignup();
    await selectRoute();
    await waitFor(() => expect(screen.getByRole("button", { name: /가입하기/u })).toBeEnabled());
    fillSignup();
    fireEvent.click(screen.getByRole("button", { name: /가입하기/u }));
    await waitFor(() =>
      expect(termsLink()).toHaveAttribute("href", "/legal/terms?policy_version=terms-2"),
    );
    expect(screen.getByLabelText(/^\(필수\) 이용약관 동의/u)).not.toBeChecked();
    expect(screen.getByLabelText(/^\(필수\) 개인정보 수집·이용 동의/u)).not.toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: /이전/u }));
    expect(await screen.findByLabelText("기본 이름")).toHaveValue("동의 학생");
  });
  it("does not submit when publication is incomplete, and allows an explicit retry", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json({ error: { code: "LEGAL_DOCUMENTS_UNAVAILABLE" } }, 503))
      .mockResolvedValue(json({ binding_required: true, documents: snapshot }));
    renderSignup();
    await selectRoute();
    await screen.findByRole("button", { name: "다시 불러오기" });
    expect(screen.getByRole("button", { name: /가입하기/u })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "다시 불러오기" }));
    await waitFor(() => expect(screen.getByRole("button", { name: /가입하기/u })).toBeEnabled());
    expect(fetchMock.mock.calls.every((call) => call[0] === bundlePath)).toBe(true);
  });
  it("loads the guardian's pinned document links but confirms only after a button click", async () => {
    const token = "a".repeat(43);
    window.history.replaceState(null, "", "/guardian-consent#token=" + token);
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (url) =>
        url === bundlePath
          ? json({ binding_required: true, documents: snapshot })
          : json({ guardian_consent: true }),
      );
    render(
      <MemoryRouter>
        <GuardianConsentPage />
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "동의합니다" })).toBeEnabled());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(window.location.hash).toBe("");
    expect(
      within(screen.getByRole("region", { name: "보호자 동의 대상 문서" })).getByRole("link", {
        name: /보호자 고지·동의서 전문 보기/u,
      }),
    ).toHaveAttribute("href", "/legal/guardian-consent?policy_version=guardian_consent-1");
    fireEvent.click(screen.getByRole("button", { name: "동의합니다" }));
    await screen.findByText("보호자 동의가 완료됐어요");
    expect(JSON.parse(String(fetchMock.mock.calls[1]![1]?.body))).toEqual({
      token,
      legal_documents: snapshot,
    });
  });
  it("allows a guardian-request retry before the account form is available", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json({ error: { code: "LEGAL_DOCUMENTS_UNAVAILABLE" } }, 503))
      .mockResolvedValue(json({ binding_required: true, documents: snapshot }));
    renderSignup();
    fireEvent.click(screen.getByRole("radio", { name: "학생" }));
    next();
    fireEvent.click(
      await screen.findByRole("radio", { name: "만 14세 미만이며 보호자 동의로 가입합니다" }),
    );
    await screen.findByRole("button", { name: "다시 불러오기" });
    expect(screen.queryByLabelText("기본 이름")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "보호자 동의 요청하기" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "다시 불러오기" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "보호자 동의 요청하기" })).toBeEnabled(),
    );
  });
});

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { clearPendingInviteCode, storePendingInviteCode } from "../../lib/invite-link";
import { SignUpPage } from "./sign-up-page";
vi.mock("../legal/use-consent-documents", () => ({
  useConsentDocuments: () => ({
    ready: true,
    documents: undefined,
    error: undefined,
    reload: vi.fn(),
  }),
}));

// 가입 설정(생년월일을 받는지)은 따로 흉내 낸다 — 아래 fetch 호출 수 검사에 섞이지 않게.
const signUpOptions = vi.hoisted(() => ({
  birthDateCollected: false,
  birthDateRequired: false,
  under14Open: true,
}));
vi.mock("../../api/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api/auth")>()),
  getSignUpOptions: () =>
    Promise.resolve({
      birth_date_collected: signUpOptions.birthDateCollected,
      birth_date_required: signUpOptions.birthDateRequired,
      under_14_signup: signUpOptions.under14Open,
    }),
}));

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function renderSignUpPage(): void {
  render(
    <MemoryRouter initialEntries={["/sign-up"]}>
      <Routes>
        <Route element={<SignUpPage />} path="/sign-up" />
        <Route element={<p>가입 요청 후 로그인</p>} path="/login" />
      </Routes>
    </MemoryRouter>,
  );
}

function clickNext(): void {
  fireEvent.click(screen.getByRole("button", { name: "다음" }));
}

/** 1단계 학생 → 2단계 만 14세 이상 → 3단계 계정 정보 화면까지. */
async function selectOver14(): Promise<void> {
  fireEvent.click(screen.getByRole("radio", { name: "학생" }));
  clickNext();
  fireEvent.click(await screen.findByRole("radio", { name: "만 14세 이상입니다" }));
  clickNext();
  await screen.findByLabelText("이메일");
}

function fillAccountFields(displayName: string, email: string): HTMLInputElement {
  fireEvent.change(screen.getByLabelText("이메일"), { target: { value: email } });
  const displayNameInput = screen.getByLabelText("기본 이름") as HTMLInputElement;
  fireEvent.change(displayNameInput, { target: { value: displayName } });
  fireEvent.change(screen.getByLabelText("비밀번호"), {
    target: { value: "Safe1!x8" },
  });
  fireEvent.change(screen.getByLabelText("비밀번호 확인"), {
    target: { value: "Safe1!x8" },
  });
  return displayNameInput;
}

/** 3단계 칸을 채우고 4단계 동의까지 체크한다. */
async function fillAccount(displayName: string, email = "unicode-student@example.com") {
  fillAccountFields(displayName, email);
  clickNext();
  fireEvent.click(await screen.findByLabelText(/^\(필수\) 이용약관 동의/u));
  fireEvent.click(screen.getByLabelText(/^\(필수\) 개인정보 수집·이용 동의/u));
}

async function fillValidOver14Form(displayName: string): Promise<void> {
  await selectOver14();
  await fillAccount(displayName);
}

function submitForm(): void {
  fireEvent.click(screen.getByRole("button", { name: /가입하기/u }));
}

async function approveGuardianRequest(options?: {
  deliveryStatus?: "failed" | "sent";
  guardianEmail?: string;
}) {
  const guardianEmail = options?.guardianEmail ?? "guardian@example.com";
  const deliveryStatus = options?.deliveryStatus ?? "sent";
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url === "/api/v1/auth/guardian-consent-requests") {
      return Promise.resolve(
        jsonResponse(
          {
            completion_token: "completion-token",
            consent_delivery_status: deliveryStatus,
            expires_at: "2026-08-29T10:00:00.000Z",
            request_id: "request-1",
          },
          201,
        ),
      );
    }
    if (url === "/api/v1/auth/guardian-consent-requests/status") {
      return Promise.resolve(jsonResponse({ status: "approved" }));
    }
    if (url === "/api/v1/auth/sign-up") {
      return Promise.resolve(jsonResponse({ next_action: "LOGIN", request_accepted: true }, 202));
    }
    throw new Error(`Unexpected URL: ${url}`);
  });

  fireEvent.click(screen.getByRole("radio", { name: "학생" }));
  clickNext();
  fireEvent.click(
    await screen.findByRole("radio", { name: "만 14세 미만이며 보호자 동의로 가입합니다" }),
  );
  fireEvent.change(screen.getByLabelText("보호자 이메일"), {
    target: { value: guardianEmail },
  });
  fireEvent.click(screen.getByRole("button", { name: "보호자 동의 요청하기" }));

  if (deliveryStatus === "sent") {
    expect(await screen.findByText("보호자 동의를 기다리고 있어요.")).toBeInTheDocument();
    // 새로고침하면 처음부터 다시 해야 한다는 안내(총검수 B3-01).
    expect(screen.getByText(/닫거나 새로고침하면 처음부터 다시/u)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "동의 상태 확인" }));
    expect(await screen.findByText(/보호자 동의가 확인됐어요/u)).toBeInTheDocument();
  }
  return fetchMock;
}

describe("SignUpPage", () => {
  beforeEach(() => {
    signUpOptions.birthDateRequired = false;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(["2@naver.com", "1@gmail.com"])(
    "accepts a signup request without revealing account or delivery status for %s",
    async (email) => {
      const fetchMock = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(jsonResponse({ next_action: "LOGIN", request_accepted: true }, 202));
      renderSignUpPage();
      await selectOver14();
      await fillAccount("같은 이름", email);
      submitForm();
      expect(await screen.findByText("가입 요청 후 로그인")).toBeInTheDocument();
      expect(screen.queryByText("이미 가입된 이메일입니다.")).not.toBeInTheDocument();
      expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
        email,
        display_name: "같은 이름",
      });
    },
  );

  it("pre-selects student for a class QR invite and still lets a teacher change it", () => {
    storePendingInviteCode("ABCDEFGH");
    try {
      renderSignUpPage();
      expect(screen.getByRole("radio", { name: /학생/ })).toBeChecked();
      expect(
        screen.getByText("반 초대로 들어와 학생을 미리 골랐어요. 선생님이면 바꿔 주세요."),
      ).toBeVisible();
      fireEvent.click(screen.getByRole("radio", { name: /선생님/ }));
      expect(screen.getByRole("radio", { name: /선생님/ })).toBeChecked();
    } finally {
      clearPendingInviteCode();
    }
  });

  it("leaves the account type unselected without a class invite", () => {
    clearPendingInviteCode();
    renderSignUpPage();
    expect(screen.getByRole("radio", { name: /학생/ })).not.toBeChecked();
    expect(screen.queryByText(/반 초대로 들어와/)).not.toBeInTheDocument();
  });

  it("shows a closed notice instead of guardian consent while under-14 signup is closed (P-025)", async () => {
    signUpOptions.under14Open = false;
    try {
      const fetchMock = vi.spyOn(globalThis, "fetch");
      renderSignUpPage();
      fireEvent.click(screen.getByRole("radio", { name: "학생" }));
      clickNext();
      fireEvent.click(
        await screen.findByRole("radio", { name: "만 14세 미만이며 보호자 동의로 가입합니다" }),
      );
      expect(
        await screen.findByText(/지금은 만 14세 이상 학생과 선생님만 가입할 수 있어요/u),
      ).toBeVisible();
      expect(screen.queryByLabelText("보호자 이메일")).not.toBeInTheDocument();
      expect(
        fetchMock.mock.calls.some(([input]) => String(input).includes("guardian-consent")),
      ).toBe(false);
    } finally {
      signUpOptions.under14Open = true;
    }
  });

  it("submits only once when two submit events arrive before validation finishes", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ next_action: "LOGIN", request_accepted: true }, 202));
    renderSignUpPage();
    await fillValidOver14Form("중복 클릭");
    const form = screen.getByRole("button", { name: /가입하기/u }).closest("form")!;
    fireEvent.submit(form);
    fireEvent.submit(form);
    await screen.findByText("가입 요청 후 로그인");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each([202, 503])(
    "keeps submitted values stable until a delayed %s response",
    async (status) => {
      let complete!: (response: Response) => void;
      const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
        () =>
          new Promise<Response>((resolve) => {
            complete = resolve;
          }),
      );
      renderSignUpPage();
      await fillValidOver14Form("대기 중 가입");
      const form = screen.getByRole("button", { name: /가입하기/u }).closest("form")!;
      fireEvent.submit(form);
      const pending = await screen.findByRole("button", { name: "가입하고 있어요" });
      expect(pending).toBeDisabled();
      const back = screen.getByRole("button", { name: "이전" });
      expect(back).toBeDisabled();
      fireEvent.click(back);
      expect(screen.queryByLabelText("이메일")).not.toBeInTheDocument();
      for (const consent of screen.getAllByRole("checkbox")) expect(consent).toBeDisabled();
      fireEvent.submit(form);
      expect(fetchMock).toHaveBeenCalledOnce();

      await act(async () => {
        complete(
          jsonResponse(
            status === 202
              ? { next_action: "LOGIN", request_accepted: true }
              : { error: { code: "SERVICE_UNAVAILABLE", message: "잠시 후 다시 시도해 주세요." } },
            status,
          ),
        );
      });
      if (status === 202) {
        expect(await screen.findByText("가입 요청 후 로그인")).toBeInTheDocument();
      } else {
        expect(await screen.findByText("잠시 후 다시 시도해 주세요.")).toBeVisible();
        expect(back).toBeEnabled();
        for (const consent of screen.getAllByRole("checkbox")) {
          expect(consent).toBeEnabled();
          expect(consent).toBeChecked();
        }
        fireEvent.click(back);
        expect(await screen.findByLabelText("이메일")).toHaveValue("unicode-student@example.com");
      }
    },
  );

  it("shows one step at a time: role first, then two unselected native age radios", async () => {
    renderSignUpPage();

    expect(screen.getByRole("radio", { name: "학생" })).not.toBeChecked();
    expect(screen.getByRole("radio", { name: "선생님" })).not.toBeChecked();
    expect(screen.queryByRole("group", { name: "나이를 골라 주세요" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("이메일")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("필수 항목 모두 동의")).not.toBeInTheDocument();
    const steps = screen.getByRole("list", { name: "가입 단계" });
    expect(within(steps).getAllByRole("listitem")).toHaveLength(4);
    expect(within(steps).getByText("1. 누구로").closest("li")).toHaveAttribute(
      "aria-current",
      "step",
    );

    fireEvent.click(screen.getByRole("radio", { name: "학생" }));
    clickNext();
    const group = await screen.findByRole("group", { name: "나이를 골라 주세요" });
    const over14 = screen.getByRole("radio", { name: "만 14세 이상입니다" });
    const guardian = screen.getByRole("radio", {
      name: "만 14세 미만이며 보호자 동의로 가입합니다",
    });
    expect(group).toContainElement(over14);
    expect(group).toContainElement(guardian);
    expect(over14).not.toBeChecked();
    expect(guardian).not.toBeChecked();
    // 2026-09-27 확정 시안: 나이는 두 칸 큰 버튼(56px, 44px 이상 유지).
    expect(over14.closest("label")).toHaveClass("min-h-14");
    expect(guardian.closest("label")).toHaveClass("min-h-14");
    expect(screen.queryByRole("radio", { name: "학생" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "다음" })).toBeDisabled();

    fireEvent.click(over14);
    expect(over14).toBeChecked();
    expect(screen.getByRole("button", { name: "다음" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: /이전/u }));
    expect(screen.getByRole("radio", { name: "학생" })).toBeChecked();
  });

  it("keeps the existing progress and stable consent wrapping groups", async () => {
    renderSignUpPage();
    await selectOver14();
    fillAccountFields("학생", "student@example.com");
    clickNext();
    await screen.findByLabelText("필수 항목 모두 동의");

    // '1 / 2' 배지는 4단계 진행 표시와 맞지 않아 없앴다(총검수 B3-04).
    expect(screen.queryByText("1 / 2")).not.toBeInTheDocument();
    expect(screen.getByRole("list", { name: "가입 단계" })).toBeInTheDocument();
    expect(screen.getByText("(필수) 개인정보 수집·이용 동의")).toHaveClass("auth-consent-copy");
    const requiredConsents = screen.getByRole("group", { name: "필수 동의" });
    expect(screen.queryByText("원문 연결 전")).not.toBeInTheDocument();
    for (const title of ["이용약관", "개인정보 수집·이용 동의서"]) {
      const link = within(requiredConsents).getByRole("link", {
        name: `${title} 전문 보기 (새 탭)`,
      });
      expect(link).toHaveClass("auth-consent-meta");
      expect(link).toHaveAttribute("target", "_blank");
      expect(link.closest("label")).toBeNull();
    }
    fireEvent.click(screen.getByLabelText("필수 항목 모두 동의"));
    expect(screen.getByLabelText(/^\(필수\) 이용약관 동의/u)).toBeChecked();
    expect(screen.getByLabelText(/^\(필수\) 개인정보 수집·이용 동의/u)).toBeChecked();
  });

  it("focuses the first invalid account input when the next button is used", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    renderSignUpPage();
    await selectOver14();
    clickNext();
    await waitFor(() => expect(screen.getByLabelText("이메일")).toHaveFocus());
    expect(screen.getByLabelText("이메일")).toHaveAttribute("aria-invalid", "true");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("skips a valid email and focuses the invalid name without leaving the account step", async () => {
    renderSignUpPage();
    await selectOver14();
    fireEvent.change(screen.getByLabelText("이메일"), { target: { value: "teacher@example.com" } });
    clickNext();
    await waitFor(() => expect(screen.getByLabelText("기본 이름")).toHaveFocus());
    expect(screen.getByLabelText("기본 이름")).toHaveAttribute("aria-invalid", "true");
    expect(screen.queryByRole("group", { name: "필수 동의" })).not.toBeInTheDocument();
  });

  it("rejects one astral display-name code point before leaving the account step", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ next_action: "LOGIN", request_accepted: true }, 202));
    renderSignUpPage();
    await selectOver14();
    fillAccountFields("😀", "unicode-student@example.com");
    clickNext();

    const error = await screen.findByText("기본 이름은 2자 이상 입력해 주세요.");
    const displayName = screen.getByLabelText("기본 이름");
    expect(error).toHaveAttribute("id", "sign-up-display-name-error");
    expect(error).toHaveAttribute("role", "alert");
    expect(displayName).toHaveAttribute("aria-invalid", "true");
    expect(displayName).toHaveAttribute("aria-describedby", "sign-up-display-name-error");
    expect(screen.getByRole("button", { name: "비밀번호 보기" })).toHaveClass("ui-icon-button");
    expect(screen.queryByLabelText("필수 항목 모두 동의")).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["two code points", "😀😀"],
    ["twenty astral code points", "😀".repeat(20)],
  ])("submits %s through the over-14 route", async (_name, displayName) => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ next_action: "LOGIN", request_accepted: true }, 202));
    renderSignUpPage();
    await selectOver14();
    const displayNameInput = fillAccountFields(displayName, "unicode-student@example.com");
    expect(displayNameInput).not.toHaveAttribute("maxlength");
    clickNext();
    fireEvent.click(await screen.findByLabelText("필수 항목 모두 동의"));
    submitForm();

    expect(await screen.findByText("가입 요청 후 로그인")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      age_route: "over_14",
      consents: { privacy: true, terms: true },
      display_name: displayName,
      email: "unicode-student@example.com",
      password: "Safe1!x8",
      role: "student",
    });
  });

  it("rejects twenty-one code points without sending a request", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ next_action: "LOGIN", request_accepted: true }, 202));
    renderSignUpPage();
    await selectOver14();
    fillAccountFields("😀".repeat(21), "unicode-student@example.com");
    clickNext();

    expect(await screen.findByText("기본 이름은 20자 이하로 입력해 주세요.")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requests guardian consent without exposing student account fields, then signs up with proof", async () => {
    renderSignUpPage();
    const fetchMock = await approveGuardianRequest();

    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/v1/auth/guardian-consent-requests");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      guardian_email: "guardian@example.com",
    });
    expect(String(fetchMock.mock.calls[0]?.[1]?.body)).not.toContain("display_name");
    expect(String(fetchMock.mock.calls[0]?.[1]?.body)).not.toContain("password");

    clickNext();
    await screen.findByLabelText("이메일");
    await fillAccount("학생", "student@example.com");
    submitForm();

    expect(await screen.findByText("가입 요청 후 로그인")).toBeInTheDocument();
    const signupCall = fetchMock.mock.calls.find(([input]) => input === "/api/v1/auth/sign-up");
    expect(JSON.parse(String(signupCall?.[1]?.body))).toEqual({
      age_route: "guardian_consent",
      consents: { privacy: true, terms: true },
      display_name: "학생",
      email: "student@example.com",
      guardian_consent: {
        completion_token: "completion-token",
        request_id: "request-1",
      },
      password: "Safe1!x8",
      role: "student",
    });
  });

  it("returns to the guardian step when the legal documents changed at the last step (B3-05)", async () => {
    renderSignUpPage();
    const fetchMock = await approveGuardianRequest();
    clickNext();
    await screen.findByLabelText("이메일");
    await fillAccount("학생", "student@example.com");
    const previous = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "/api/v1/auth/sign-up")
        return Promise.resolve(
          jsonResponse(
            { error: { code: "LEGAL_DOCUMENTS_CHANGED", message: "문서를 다시 확인해 주세요." } },
            409,
          ),
        );
      return previous(input, init);
    });
    submitForm();
    expect(
      await screen.findByText(/동의 문서가 바뀌어 보호자 동의를 다시 받아야 해요/u),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("보호자 이메일")).toBeInTheDocument();
  });

  it("requires an account role but collects the approval number only after signup", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ next_action: "LOGIN", request_accepted: true }, 202));
    renderSignUpPage();

    expect(screen.queryByLabelText("가입 승인번호")).not.toBeInTheDocument();
    expect(
      screen.getByText("가입한 이메일로 받은 6자리 인증번호로 가입을 완료해요."),
    ).toBeInTheDocument();

    clickNext();

    expect(await screen.findByText("가입할 계정 유형을 선택해 주세요.")).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "나이를 골라 주세요" })).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows local advisory colors below the first password and hides the grade when empty", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const storageMock = vi.spyOn(Storage.prototype, "setItem");
    renderSignUpPage();
    await selectOver14();
    const password = screen.getByLabelText("비밀번호");
    expect(screen.queryByRole("status", { name: /비밀번호 안전 등급/u })).not.toBeInTheDocument();

    for (const [value, label, color] of [
      ["short", "위험", "text-danger-text"],
      ["Cloud1", "보통", "text-warning-text"],
      ["Cedar#72", "안전", "text-success-text"],
      ["Password1234!", "위험", "text-danger-text"],
    ] as const) {
      fireEvent.change(password, { target: { value } });
      const grade = screen.getByRole("status", { name: `비밀번호 안전 등급: ${label}` });
      expect(grade).toHaveClass("text-xs", color);
      expect(grade).toHaveAttribute("title", expect.stringContaining("문자와 숫자"));
      expect(grade).toBeInTheDocument();
      expect(password).toHaveAttribute(
        "aria-describedby",
        "sign-up-password-rules sign-up-password-strength",
      );
      expect(screen.getByLabelText("비밀번호 확인")).not.toHaveAttribute("aria-describedby");
    }

    fireEvent.change(password, { target: { value: "" } });
    expect(screen.queryByRole("status", { name: /비밀번호 안전 등급/u })).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(storageMock).not.toHaveBeenCalled();
  });

  it("rejects five characters but accepts six mixed characters regardless of advisory grade", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ next_action: "LOGIN", request_accepted: true }, 202));
    renderSignUpPage();
    await selectOver14();
    fillAccountFields("학생", "unicode-student@example.com");
    for (const label of ["비밀번호", "비밀번호 확인"])
      fireEvent.change(screen.getByLabelText(label), { target: { value: "Sky12" } });
    clickNext();
    expect(await screen.findByText("비밀번호는 6자 이상이어야 해요.")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();

    for (const label of ["비밀번호", "비밀번호 확인"])
      fireEvent.change(screen.getByLabelText(label), { target: { value: "Cloud1" } });
    expect(screen.getByRole("status", { name: "비밀번호 안전 등급: 보통" })).toBeInTheDocument();
    clickNext();
    fireEvent.click(await screen.findByLabelText("필수 항목 모두 동의"));
    submitForm();
    expect(await screen.findByText("가입 요청 후 로그인")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledOnce();
    const payload = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(payload.password).toBe("Cloud1");
    expect(payload).not.toHaveProperty("approval_code");
  });

  it("blocks a student email equal to the guardian email on the client", async () => {
    renderSignUpPage();
    const fetchMock = await approveGuardianRequest();

    clickNext();
    await screen.findByLabelText("이메일");
    fillAccountFields("학생", "guardian@example.com");
    clickNext();

    expect(
      await screen.findByText("학생 이메일과 보호자 이메일은 서로 달라야 해요."),
    ).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.some(([input]) => input === "/api/v1/auth/sign-up")).toBe(false);
  });

  it("retains a failed delivery request and offers an explicit retry", async () => {
    renderSignUpPage();
    const fetchMock = await approveGuardianRequest({ deliveryStatus: "failed" });

    expect(
      await screen.findByText("메일 발송에 실패했습니다. 다시 요청해 주세요."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "다시 요청하기" })).toHaveClass("min-h-11");
    expect(screen.queryByLabelText("이메일")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "다음" })).toBeDisabled();
    expect(fetchMock).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("button", { name: "다시 요청하기" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  describe("where the server collects birth dates", () => {
    beforeEach(() => {
      signUpOptions.birthDateRequired = true;
    });

    it("derives the age route from the birth date and sends both", async () => {
      const fetchMock = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(jsonResponse({ next_action: "LOGIN", request_accepted: true }, 202));
      renderSignUpPage();
      fireEvent.click(screen.getByRole("radio", { name: "학생" }));
      clickNext();
      const birthDate = await screen.findByLabelText("생년월일을 입력해 주세요");
      expect(screen.queryByRole("group", { name: "나이를 골라 주세요" })).not.toBeInTheDocument();
      expect(birthDate).toHaveAttribute("type", "date");
      expect(screen.getByRole("button", { name: "다음" })).toBeDisabled();

      fireEvent.change(birthDate, { target: { value: "2000-01-02" } });
      expect(screen.getByText(/^만 \d+세예요\.$/u)).toBeInTheDocument();
      expect(screen.queryByLabelText("보호자 이메일")).not.toBeInTheDocument();
      clickNext();
      await screen.findByLabelText("이메일");
      await fillAccount("생일 학생", "birth@example.com");
      expect(screen.getByText(/선택 항목: 생년월일/u)).toBeInTheDocument();
      submitForm();

      expect(await screen.findByText("가입 요청 후 로그인")).toBeInTheDocument();
      expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
        age_route: "over_14",
        birth_date: "2000-01-02",
        role: "student",
      });
    });

    it("sends an under-14 birth date to the guardian consent step first", async () => {
      const fetchMock = vi.spyOn(globalThis, "fetch");
      renderSignUpPage();
      fireEvent.click(screen.getByRole("radio", { name: "학생" }));
      clickNext();
      const year = new Date().getFullYear() - 10;
      fireEvent.change(await screen.findByLabelText("생년월일을 입력해 주세요"), {
        target: { value: `${year}-01-01` },
      });

      expect(screen.getByText(/보호자 동의 후 가입할 수 있어요/u)).toBeInTheDocument();
      expect(screen.getByLabelText("보호자 이메일")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "다음" })).toBeDisabled();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("keeps an impossible or future date on the age step", async () => {
      renderSignUpPage();
      fireEvent.click(screen.getByRole("radio", { name: "학생" }));
      clickNext();
      const birthDate = await screen.findByLabelText("생년월일을 입력해 주세요");
      fireEvent.change(birthDate, { target: { value: `${new Date().getFullYear() + 1}-01-01` } });
      expect(screen.queryByText(/^만 \d+세예요/u)).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "다음" })).toBeDisabled();
    });
  });

  // 2026-10-02 사용자 결정(P-025③): 받을 수 있는 환경에서도 생년월일은 선택 입력이다.
  describe("where the server collects optional birth dates", () => {
    beforeEach(() => {
      signUpOptions.birthDateCollected = true;
      signUpOptions.birthDateRequired = false;
    });
    afterEach(() => {
      signUpOptions.birthDateCollected = false;
    });

    it("signs up without a birth date using the chosen age route", async () => {
      const fetchMock = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(jsonResponse({ next_action: "LOGIN", request_accepted: true }, 202));
      renderSignUpPage();
      fireEvent.click(screen.getByRole("radio", { name: "학생" }));
      clickNext();
      expect(await screen.findByLabelText("생년월일 (선택)")).not.toHaveAttribute("aria-required");
      expect(screen.queryByText(/생년월일은 수집하지 않아요/u)).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole("radio", { name: "만 14세 이상입니다" }));
      clickNext();
      await screen.findByLabelText("이메일");
      await fillAccount("선택 학생", "optional@example.com");
      expect(screen.queryByText(/선택 항목: 생년월일/u)).not.toBeInTheDocument();
      submitForm();
      expect(await screen.findByText("가입 요청 후 로그인")).toBeInTheDocument();
      const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
      expect(body).toMatchObject({ age_route: "over_14", role: "student" });
      expect(body).not.toHaveProperty("birth_date");
    });

    it("sends an entered birth date and lists it as an optional item", async () => {
      const fetchMock = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(jsonResponse({ next_action: "LOGIN", request_accepted: true }, 202));
      renderSignUpPage();
      fireEvent.click(screen.getByRole("radio", { name: "학생" }));
      clickNext();
      fireEvent.change(await screen.findByLabelText("생년월일 (선택)"), {
        target: { value: "2000-01-02" },
      });
      expect(screen.getByRole("radio", { name: "만 14세 이상입니다" })).toBeChecked();
      clickNext();
      await screen.findByLabelText("이메일");
      await fillAccount("생일 학생", "birth-optional@example.com");
      expect(screen.getByText(/선택 항목: 생년월일/u)).toBeInTheDocument();
      submitForm();
      expect(await screen.findByText("가입 요청 후 로그인")).toBeInTheDocument();
      expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
        age_route: "over_14",
        birth_date: "2000-01-02",
      });
    });
  });
});

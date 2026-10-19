import { fireEvent, render, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GuardianConsentPage } from "./guardian-consent-page";
vi.mock("../legal/use-consent-documents", () => ({
  useConsentDocuments: () => ({
    ready: true,
    documents: undefined,
    error: undefined,
    reload: vi.fn(),
  }),
}));

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function renderPage(): void {
  render(
    <StrictMode>
      <MemoryRouter>
        <GuardianConsentPage />
      </MemoryRouter>
    </StrictMode>,
  );
}

describe("GuardianConsentPage", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    window.history.replaceState(null, "", "/");
  });

  it.each([
    ["a missing fragment", "/guardian-consent", 0, "/guardian-consent"],
    [
      "an empty token fragment",
      "/guardian-consent?source=mail#token=",
      1,
      "/guardian-consent?source=mail",
    ],
  ] as const)("treats %s as missing without confirming", (_, url, clears, expectedLocation) => {
    const preservedState = { idx: 9, key: "guardian", usr: null };
    window.history.replaceState(preservedState, "", url);
    const replaceStateMock = vi.spyOn(window.history, "replaceState");
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ guardian_consent: true }));

    renderPage();

    expect(screen.getByRole("heading", { name: "동의 정보가 없어요" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "가입 화면으로" })).toHaveAttribute("href", "/sign-up");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(`${window.location.pathname}${window.location.search}`).toBe(expectedLocation);
    expect(window.location.hash).toBe("");
    expect(window.history.state).toEqual(preservedState);
    expect(replaceStateMock).toHaveBeenCalledTimes(clears);
  });

  it("clears a token immediately but waits for the explicit consent click", async () => {
    const token = "G".repeat(43);
    const preservedState = { idx: 4, key: "guardian-mail", usr: { source: "mail" } };
    window.history.replaceState(preservedState, "", `/guardian-consent?source=mail#token=${token}`);
    const replaceStateMock = vi.spyOn(window.history, "replaceState");
    let hashAtRequest: string | undefined;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      hashAtRequest = window.location.hash;
      return Promise.resolve(jsonResponse({ guardian_consent: true }));
    });

    renderPage();

    expect(screen.getByRole("heading", { level: 1, name: "보호자 동의" })).toBeInTheDocument();
    expect(screen.getByText(/보호자 이메일·동의 상태·시점만 기록/u)).toBeInTheDocument();
    expect(screen.getByText(/이름·전화번호·생년월일·증빙서류는 받지/u)).toBeInTheDocument();
    const consentButton = screen.getByRole("button", { name: "동의합니다" });
    expect(consentButton).toHaveClass("min-h-12");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(window.location.hash).toBe("");
    expect(window.location.pathname).toBe("/guardian-consent");
    expect(window.location.search).toBe("?source=mail");
    expect(window.history.state).toEqual(preservedState);
    expect(replaceStateMock).toHaveBeenCalledOnce();

    fireEvent.click(consentButton);

    expect(
      await screen.findByRole("heading", { name: "보호자 동의가 완료됐어요" }),
    ).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/auth/guardian-consents/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
      signal: expect.any(AbortSignal),
    });
    expect(hashAtRequest).toBe("");
  });

  it("keeps confirmation explicit after an API failure and allows a retry", async () => {
    window.history.replaceState(null, "", "/guardian-consent#token=retry-token");
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        jsonResponse(
          {
            error: {
              code: "TOKEN_INVALID_OR_EXPIRED",
              message: "expired",
            },
          },
          400,
        ),
      )
      .mockResolvedValueOnce(jsonResponse({ guardian_consent: true }));
    renderPage();

    fireEvent.click(screen.getByRole("button", { name: "동의합니다" }));

    expect(
      await screen.findByText(
        "동의 링크가 만료됐거나 이미 사용됐어요. 학생에게 새 요청을 부탁해 주세요.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "동의합니다" })).toBeEnabled();
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

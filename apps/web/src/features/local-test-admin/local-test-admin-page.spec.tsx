import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { LocalTestAccount } from "../../api/local-test-admin";
import { LocalTestAdminPage } from "./local-test-admin-page";

const ACCOUNTS_URL = "/api/v1/local-test-admin/accounts";

const deletableAccountFixture: LocalTestAccount = {
  created_at: "2026-07-13T00:00:00.000Z",
  display_name: "삭제 테스트 학생",
  email: "delete-me@example.com",
  email_verified: true,
  id: "7",
  membership_count: 0,
  session_count: 2,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function requestUrl(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
}

function renderAuthenticatedAdmin(initialAccounts: LocalTestAccount[] = []) {
  let accounts = [...initialAccounts];
  vi.spyOn(Document.prototype, "cookie", "get").mockReturnValue(
    "__Host-classhub_local_admin_csrf=local-csrf-token",
  );
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const method = init?.method ?? "GET";
    const url = requestUrl(input);

    if (url === ACCOUNTS_URL && method === "GET") {
      return Promise.resolve(jsonResponse({ accounts }));
    }
    if (url === ACCOUNTS_URL && method === "POST") {
      return Promise.resolve(
        jsonResponse(
          {
            created_at: "2026-07-13T00:00:00.000Z",
            display_name: "생성된 학생",
            email: "twenty@example.com",
            email_verified: true,
            id: "local-account-1",
            membership_count: 0,
            session_count: 0,
          },
          201,
        ),
      );
    }
    if (url === `${ACCOUNTS_URL}/${deletableAccountFixture.id}` && method === "DELETE") {
      accounts = accounts.filter((account) => account.id !== deletableAccountFixture.id);
      return Promise.resolve(
        jsonResponse({
          deleted: true,
          deleted_counts: {
            consents: 3,
            email_tokens: 1,
            idempotency_keys: 0,
            password_reset_tokens: 0,
            sessions: 2,
            users: 1,
          },
        }),
      );
    }
    throw new Error(`Unexpected request: ${method} ${url}`);
  });

  render(<LocalTestAdminPage />);
  return fetchMock;
}

function createCalls(fetchMock: ReturnType<typeof renderAuthenticatedAdmin>) {
  return fetchMock.mock.calls.filter(
    ([input, init]) => requestUrl(input) === ACCOUNTS_URL && init?.method === "POST",
  );
}

function deleteCalls(fetchMock: ReturnType<typeof renderAuthenticatedAdmin>) {
  return fetchMock.mock.calls.filter(
    ([input, init]) =>
      requestUrl(input) === `${ACCOUNTS_URL}/${deletableAccountFixture.id}` &&
      init?.method === "DELETE",
  );
}

async function fillCreateForm(displayName: string, email: string): Promise<HTMLInputElement> {
  const displayNameInput = (await screen.findByLabelText("표시명")) as HTMLInputElement;
  fireEvent.change(displayNameInput, { target: { value: displayName } });
  fireEvent.change(screen.getByLabelText("이메일"), { target: { value: email } });
  return displayNameInput;
}

function submitCreateForm(): void {
  fireEvent.click(screen.getByRole("button", { name: "계정 생성" }));
}

describe("LocalTestAdminPage display-name code-point validation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not impose a UTF-16 maxlength on the display-name input", async () => {
    renderAuthenticatedAdmin();

    const displayNameInput = await screen.findByLabelText("표시명");

    expect(displayNameInput).not.toHaveAttribute("maxlength");
  });

  it("announces only the account list refresh as busy", async () => {
    let requestCount = 0;
    let resolveRefresh: ((response: Response) => void) | undefined;
    const pendingRefresh = new Promise<Response>((resolve) => {
      resolveRefresh = resolve;
    });
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      if (requestUrl(input) !== ACCOUNTS_URL || (init?.method ?? "GET") !== "GET") {
        throw new Error("Unexpected request");
      }
      requestCount += 1;
      return requestCount === 1 ? Promise.resolve(jsonResponse({ accounts: [] })) : pendingRefresh;
    });

    render(<LocalTestAdminPage />);
    const refreshButton = await screen.findByRole("button", { name: "목록 새로고침" });
    const createButton = screen.getByRole("button", { name: "계정 생성" });
    fireEvent.click(refreshButton);

    await waitFor(() => {
      expect(refreshButton).toBeDisabled();
      expect(refreshButton).toHaveAttribute("aria-busy", "true");
    });
    expect(createButton).toBeDisabled();
    expect(createButton).toHaveAttribute("aria-busy", "false");

    await act(async () => {
      resolveRefresh?.(jsonResponse({ accounts: [] }));
    });
    await waitFor(() => {
      expect(refreshButton).not.toBeDisabled();
      expect(refreshButton).toHaveAttribute("aria-busy", "false");
    });
  });

  it.each([
    ["one astral code point", "😀"],
    ["twenty-one astral code points", "😀".repeat(21)],
  ])("rejects %s without calling the create API", async (_name, displayName) => {
    const fetchMock = renderAuthenticatedAdmin();
    const displayNameInput = await fillCreateForm(displayName, "invalid-length@example.com");

    expect(displayNameInput).toHaveValue(displayName);
    submitCreateForm();

    expect(
      await screen.findByText("표시명은 2자 이상 20자 이하로 입력해 주세요."),
    ).toBeInTheDocument();
    expect(createCalls(fetchMock)).toHaveLength(0);
  });

  it("sends all twenty astral code points exactly once with the complete request", async () => {
    const fetchMock = renderAuthenticatedAdmin();
    const displayName = "😀".repeat(20);
    const displayNameInput = await fillCreateForm(displayName, "twenty@example.com");

    expect(displayNameInput).not.toHaveAttribute("maxlength");
    expect(displayNameInput).toHaveValue(displayName);
    submitCreateForm();

    await waitFor(() => expect(createCalls(fetchMock)).toHaveLength(1));
    const [, request] = createCalls(fetchMock)[0] ?? [];
    expect(request).toMatchObject({
      credentials: "include",
      method: "POST",
    });
    expect(new Headers(request?.headers).get("Content-Type")).toBe("application/json");
    expect(new Headers(request?.headers).get("X-Local-Admin-CSRF")).toBe("local-csrf-token");
    expect(JSON.parse(String(request?.body))).toEqual({
      display_name: displayName,
      email: "twenty@example.com",
      email_verified: true,
      password: "classhub123",
    });
    expect(createCalls(fetchMock)).toHaveLength(1);
  });

  it("opens the dark deletion dialog and cancels without a request before restoring focus", async () => {
    const fetchMock = renderAuthenticatedAdmin([deletableAccountFixture]);
    const deleteButton = await screen.findByRole("button", { name: "삭제" });
    deleteButton.focus();

    fireEvent.click(deleteButton);

    const dialog = screen.getByRole("dialog", { name: "테스트 계정을 삭제할까요?" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveClass("bg-slate-900");
    expect(within(dialog).getByText(deletableAccountFixture.email)).toBeInTheDocument();
    const cancelButton = within(dialog).getByRole("button", { name: "취소" });
    expect(cancelButton).toHaveFocus();

    fireEvent.click(cancelButton);

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(deleteButton).toHaveFocus();
    });
    expect(deleteCalls(fetchMock)).toHaveLength(0);
  });

  it("sends the exact local-admin DELETE request only after the danger confirmation", async () => {
    const fetchMock = renderAuthenticatedAdmin([deletableAccountFixture]);
    fireEvent.click(await screen.findByRole("button", { name: "삭제" }));

    const dialog = screen.getByRole("dialog", { name: "테스트 계정을 삭제할까요?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "테스트 계정 삭제" }));

    await waitFor(() => expect(deleteCalls(fetchMock)).toHaveLength(1));
    const [url, request] = deleteCalls(fetchMock)[0] ?? [];
    expect(url).toBe(`${ACCOUNTS_URL}/${deletableAccountFixture.id}`);
    expect(request).toEqual({
      body: JSON.stringify({ email: deletableAccountFixture.email }),
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        "X-Local-Admin-CSRF": "local-csrf-token",
      },
      method: "DELETE",
      signal: expect.any(AbortSignal),
    });
    expect(deleteCalls(fetchMock)).toHaveLength(1);
  });
});

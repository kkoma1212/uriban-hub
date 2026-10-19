import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BootstrapPage } from "../features/bootstrap/bootstrap-page";
import { LoginPage } from "../features/auth/login-page";
vi.mock("../features/auth/social-login-buttons", () => ({ SocialLoginButtons: () => null }));

import { JoinInvitePage } from "../features/bootstrap/join-invite-page";
import { InviteQrCode } from "../features/classes/invite-qr-code";
import {
  clearPendingInviteCode,
  inviteJoinUrl,
  normalizeInviteCode,
  readPendingInviteCode,
  storePendingInviteCode,
} from "./invite-link";

afterEach(() => {
  vi.restoreAllMocks();
  clearPendingInviteCode();
  window.sessionStorage.clear();
});

describe("invite link", () => {
  it("혼동 문자를 뺀 8자리 코드만 받아 대문자로 맞춘다", () => {
    expect(normalizeInviteCode(" abcd2345 ")).toBe("ABCD2345");
    for (const invalid of ["ABCD234", "ABCD23456", "ABCDI234", "ABCDO234", "ABCD1234", null]) {
      expect(normalizeInviteCode(invalid)).toBeNull();
    }
  });

  it("참여 주소에 코드를 담는다", () => {
    expect(inviteJoinUrl("ABCD2345", "https://class.example")).toBe(
      "https://class.example/join?code=ABCD2345",
    );
  });

  it("저장한 코드를 읽고 지운다", () => {
    storePendingInviteCode("ABCD2345");
    expect(readPendingInviteCode()).toBe("ABCD2345");
    clearPendingInviteCode();
    expect(readPendingInviteCode()).toBeNull();
  });

  it("세션 저장소에 형식이 틀린 값이 있으면 무시한다", () => {
    window.sessionStorage.setItem("classhub:pending-invite-code", "<script>");
    expect(readPendingInviteCode()).toBeNull();
  });
});

function renderJoin(path: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route element={<JoinInvitePage />} path="/join" />
        <Route element={<p>참여 화면</p>} path="/bootstrap" />
      </Routes>
    </MemoryRouter>,
  );
}

describe("JoinInvitePage", () => {
  it("QR 주소로 들어오면 코드를 담아 두고 참여 화면으로 보낸다", async () => {
    renderJoin("/join?code=abcd2345");
    expect(await screen.findByText("참여 화면")).toBeInTheDocument();
    expect(readPendingInviteCode()).toBe("ABCD2345");
  });

  it.each(["/join", "/join?code=not-valid", "/join?code=ABCDI234"])(
    "잘못된 QR %s는 이전 코드를 지우고 직접 입력 안내를 제공한다",
    async (path) => {
      storePendingInviteCode("ABCD2345");
      const fetch = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(
          async () => new Response(JSON.stringify({ maintenance: false, announcement: null })),
        );
      renderJoin(path);
      expect(
        await screen.findByRole("heading", { name: "반 초대 링크를 확인해 주세요" }),
      ).toBeVisible();
      expect(screen.getByRole("link", { name: "초대 코드 직접 입력" })).toHaveAttribute(
        "href",
        "/bootstrap",
      );
      expect(screen.queryByText("참여 화면")).not.toBeInTheDocument();
      expect(readPendingInviteCode()).toBeNull();
      expect(window.sessionStorage.getItem("classhub:pending-invite-code")).toBeNull();
      expect(
        fetch.mock.calls.every(([input]) => String(input).includes("/public/system-state")),
      ).toBe(true);
    },
  );
});

describe("InviteQrCode", () => {
  it("현재 주소 기준 참여 링크를 QR로 그린다", async () => {
    render(<InviteQrCode code="ABCD2345" />);
    const qr = screen.getByRole("img", { name: "반 참여 QR 코드" });
    await waitFor(() => expect(qr.querySelector("path")).not.toBeNull());
    expect(screen.getByText(/초대 코드가 채워진 참여 화면이 열립니다/u)).toBeInTheDocument();
  });
});

describe("초대 코드 저장소 실패와 로그인 연결", () => {
  it("삭제가 거부돼도 현재 앱에서는 이전 반 코드를 다시 읽지 않는다", () => {
    storePendingInviteCode("ABCD2345");
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw Error("synthetic blocked removal");
    });
    clearPendingInviteCode();
    expect(readPendingInviteCode()).toBeNull();
    expect(window.sessionStorage.getItem("classhub:pending-invite-code")).toBe("ABCD2345");
  });
  it("새 코드 저장이 거부되면 이전 코드 대신 직접 입력으로 돌아간다", () => {
    storePendingInviteCode("ABCD2345");
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw Error("synthetic blocked write");
    });
    storePendingInviteCode("EFGH6789");
    expect(readPendingInviteCode()).toBeNull();
  });
  it("잘못된 QR 뒤 새 유효 QR는 미리채우기를 다시 사용할 수 있다", async () => {
    storePendingInviteCode("ABCD2345");
    clearPendingInviteCode();
    renderJoin("/join?code=efgh6789");
    expect(await screen.findByText("참여 화면")).toBeInTheDocument();
    expect(readPendingInviteCode()).toBe("EFGH6789");
  });
  it.each([
    { label: "유효 초대", path: "/join?code=abcd2345", code: "ABCD2345", manual: false },
    { label: "잘못된 초대", path: "/join?code=not-valid", code: "", manual: true },
  ])(
    "$label의 로그인 뒤 입력값을 보존하고 참여 요청은 자동으로 보내지 않는다",
    async ({ path, code, manual }) => {
      storePendingInviteCode("EFGH6789");
      let loggedIn = false;
      vi.spyOn(Document.prototype, "cookie", "get").mockReturnValue(
        "__Host-classhub_csrf=fixture-csrf",
      );
      const initial = {
        account: {
          display_name: "검수 학생",
          email_verified: true,
          is_active: true,
          signup_role: "student",
        },
        allowed_actions: ["REQUEST_MEMBERSHIP", "LOGOUT"],
        current_class: null,
        current_membership: null,
        destination: "ENTER_INVITE_CODE",
        last_membership_status: null,
        last_status_reason: null,
        server_today: "2026-10-13",
        teacher_profile: null,
      };
      const response = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "Content-Type": "application/json" },
        });
      const request = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
        const path = String(input);
        if (path === "/api/v1/bootstrap")
          return loggedIn
            ? response(initial)
            : response({ error: { code: "UNAUTHENTICATED", message: "로그인 필요" } }, 401);
        if (path === "/api/v1/auth/login") {
          loggedIn = true;
          return response({ next_action: "BOOTSTRAP" });
        }
        if (path.includes("/public/system-state"))
          return response({ maintenance: false, announcement: null });
        if (path.includes("/past-classes")) return response({ items: [] });
        throw Error("unexpected synthetic endpoint");
      });
      render(
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/join" element={<JoinInvitePage />} />
            <Route path="/bootstrap" element={<BootstrapPage />} />
            <Route path="/login" element={<LoginPage />} />
          </Routes>
        </MemoryRouter>,
      );
      if (manual) {
        expect(
          await screen.findByRole("heading", { name: "반 초대 링크를 확인해 주세요" }),
        ).toBeVisible();
        fireEvent.click(screen.getByRole("link", { name: "초대 코드 직접 입력" }));
      }
      fireEvent.change(await screen.findByLabelText("이메일"), {
        target: { value: "student@example.invalid" },
      });
      fireEvent.change(screen.getByLabelText("비밀번호"), {
        target: { value: "Synthetic-Password-Only" },
      });
      fireEvent.click(screen.getByRole("button", { name: "로그인" }));
      expect(await screen.findByLabelText("반 초대 코드")).toHaveValue(code);
      expect(readPendingInviteCode()).toBe(code || null);
      expect(
        request.mock.calls.filter(([input]) => String(input) === "/api/v1/membership-requests"),
      ).toHaveLength(0);
    },
  );
});

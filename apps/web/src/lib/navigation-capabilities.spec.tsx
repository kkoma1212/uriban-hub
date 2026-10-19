import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { getBootstrap, type BootstrapResponse } from "../api/auth";
import { clearAuthenticatedClientState } from "./authenticated-client-state";
import {
  beginNavigationCapabilitiesRequest,
  clearNavigationCapabilities,
  rememberNavigationCapabilities,
  useNavigationCapabilities,
} from "./navigation-capabilities";

function bootstrapFixture(
  role: "student" | "teacher",
  assessmentsEnabled: boolean,
): Pick<BootstrapResponse, "allowed_actions" | "current_membership"> {
  return {
    allowed_actions: assessmentsEnabled ? ["MANAGE_OWN_ASSESSMENTS"] : ["VIEW_CLASS"],
    current_membership: {
      class_id: "class-1",
      display_name_in_class: null,
      id: "member-1",
      role,
      status: "approved",
      student_number: role === "student" ? 1 : null,
    },
  };
}

function fullBootstrapFixture(
  role: "student" | "teacher",
  assessmentsEnabled: boolean,
): BootstrapResponse {
  return {
    account: { display_name: "평가 탭 검수", email_verified: true, is_active: true },
    ...bootstrapFixture(role, assessmentsEnabled),
    current_class: { id: "class-1", name: "1반", status: "active" },
    destination: "HOME",
    last_membership_status: null,
    last_status_reason: null,
    server_today: "2026-08-02",
    teacher_profile: null,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function deferredResponse(): {
  promise: Promise<Response>;
  reject: (reason: unknown) => void;
  resolve: (response: Response) => void;
} {
  let reject!: (reason: unknown) => void;
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((resolvePromise, rejectPromise) => {
    reject = rejectPromise;
    resolve = resolvePromise;
  });
  return { promise, reject, resolve };
}

function rememberFixture(
  bootstrap: Pick<BootstrapResponse, "allowed_actions" | "current_membership">,
): void {
  rememberNavigationCapabilities(beginNavigationCapabilitiesRequest(), bootstrap);
}

function CapabilityProbe(): React.JSX.Element {
  const capabilities = useNavigationCapabilities();
  return <output>{capabilities.studentAssessmentsEnabled ? "평가 사용" : "평가 숨김"}</output>;
}

describe("navigation capabilities", () => {
  afterEach(() => {
    clearNavigationCapabilities();
    window.localStorage.clear();
    vi.restoreAllMocks();
  });

  it("shares the student assessment capability across the current app session", () => {
    render(<CapabilityProbe />);
    expect(screen.getByText("평가 숨김")).toBeInTheDocument();

    act(() => rememberFixture(bootstrapFixture("student", true)));
    expect(screen.getByText("평가 사용")).toBeInTheDocument();

    act(() => rememberFixture(bootstrapFixture("student", false)));
    expect(screen.getByText("평가 숨김")).toBeInTheDocument();
  });

  it("turns profile photos on with USE_PROFILE_PHOTOS and exposes the class only then", () => {
    function PhotoProbe(): React.JSX.Element {
      const { profilePhotosEnabled, profilePhotoClassId } = useNavigationCapabilities();
      return (
        <output>{`${profilePhotosEnabled ? "사진" : "글자"}:${profilePhotoClassId ?? "-"}`}</output>
      );
    }
    render(<PhotoProbe />);
    expect(screen.getByText("글자:-")).toBeInTheDocument();
    const base = bootstrapFixture("student", false);
    act(() =>
      rememberFixture({
        ...base,
        allowed_actions: [...base.allowed_actions, "USE_PROFILE_PHOTOS"],
      }),
    );
    expect(screen.getByText("사진:class-1")).toBeInTheDocument();
    act(() => rememberFixture(base));
    expect(screen.getByText("글자:-")).toBeInTheDocument();
    act(() =>
      rememberFixture({
        ...base,
        allowed_actions: [...base.allowed_actions, "USE_PROFILE_PHOTOS"],
      }),
    );
    act(() => clearAuthenticatedClientState());
    expect(screen.getByText("글자:-")).toBeInTheDocument();
  });

  it("shows the class chat menu only while the server grants USE_CLASS_CHAT", () => {
    function ChatProbe(): React.JSX.Element {
      return (
        <output>{useNavigationCapabilities().classChatEnabled ? "대화 보임" : "대화 숨김"}</output>
      );
    }
    render(<ChatProbe />);
    expect(screen.getByText("대화 숨김")).toBeInTheDocument();
    const base = bootstrapFixture("teacher", false);
    act(() =>
      rememberFixture({ ...base, allowed_actions: [...base.allowed_actions, "USE_CLASS_CHAT"] }),
    );
    expect(screen.getByText("대화 보임")).toBeInTheDocument();
    act(() => rememberFixture(base));
    expect(screen.getByText("대화 숨김")).toBeInTheDocument();
  });

  it("never enables the student assessment tab for a teacher capability response", () => {
    render(<CapabilityProbe />);

    act(() => rememberFixture(bootstrapFixture("teacher", true)));
    expect(screen.getByText("평가 숨김")).toBeInTheDocument();
  });

  it("clears the capability with the rest of the authenticated client session", () => {
    render(<CapabilityProbe />);
    act(() => rememberFixture(bootstrapFixture("student", true)));
    expect(screen.getByText("평가 사용")).toBeInTheDocument();

    act(() => clearAuthenticatedClientState());
    expect(screen.getByText("평가 숨김")).toBeInTheDocument();
  });

  it("updates from bootstrap and fails closed when bootstrap cannot be trusted", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(fullBootstrapFixture("student", true)))
      .mockResolvedValueOnce(
        jsonResponse({ error: { code: "UNAUTHENTICATED", message: "로그인이 필요합니다." } }, 401),
      )
      .mockRejectedValueOnce(new TypeError("network unavailable"));
    render(<CapabilityProbe />);

    await act(async () => {
      await getBootstrap();
    });
    expect(screen.getByText("평가 사용")).toBeInTheDocument();

    await act(async () => {
      await expect(getBootstrap()).rejects.toMatchObject({ status: 401 });
    });
    expect(screen.getByText("평가 숨김")).toBeInTheDocument();
    act(() => rememberFixture(bootstrapFixture("student", true)));
    await act(async () => {
      // apiFetch normalizes the browser TypeError into the Korean network error.
      await expect(getBootstrap()).rejects.toMatchObject({
        code: "NETWORK_ERROR",
        message: "서버에 연결하지 못했습니다. 네트워크 상태를 확인한 뒤 다시 시도해 주세요.",
      });
    });
    expect(screen.getByText("평가 숨김")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("ignores an older bootstrap success that arrives after the latest success", async () => {
    const first = deferredResponse();
    const second = deferredResponse();
    vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    render(<CapabilityProbe />);

    const firstRequest = getBootstrap();
    const secondRequest = getBootstrap();
    await act(async () => {
      second.resolve(jsonResponse(fullBootstrapFixture("student", true)));
      await secondRequest;
    });
    expect(screen.getByText("평가 사용")).toBeInTheDocument();

    await act(async () => {
      first.resolve(jsonResponse(fullBootstrapFixture("teacher", false)));
      await firstRequest;
    });
    expect(screen.getByText("평가 사용")).toBeInTheDocument();
  });

  it("ignores an older bootstrap failure that arrives after the latest success", async () => {
    const first = deferredResponse();
    const second = deferredResponse();
    vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    render(<CapabilityProbe />);

    const firstRequest = getBootstrap();
    const secondRequest = getBootstrap();
    await act(async () => {
      second.resolve(jsonResponse(fullBootstrapFixture("student", true)));
      await secondRequest;
    });

    await act(async () => {
      first.reject(new TypeError("older request failed"));
      await expect(firstRequest).rejects.toMatchObject({ code: "NETWORK_ERROR" });
    });
    expect(screen.getByText("평가 사용")).toBeInTheDocument();
  });

  it("does not restore capabilities when an in-flight success arrives after an external clear", async () => {
    const response = deferredResponse();
    vi.spyOn(globalThis, "fetch").mockImplementationOnce(() => response.promise);
    render(<CapabilityProbe />);

    const request = getBootstrap();
    act(() => clearAuthenticatedClientState());
    await act(async () => {
      response.resolve(jsonResponse(fullBootstrapFixture("student", true)));
      await request;
    });

    expect(screen.getByText("평가 숨김")).toBeInTheDocument();
  });
});

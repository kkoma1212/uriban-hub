import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { NoticesPage } from "../notices/notices-page";
import { SuppliesPage } from "../supplies/supplies-page";

const teacherBootstrap = {
  account: { email_verified: true, is_active: true },
  allowed_actions: ["CHANGE_PASSWORD", "LOGOUT", "VIEW_CLASS", "MANAGE_CLASS"],
  current_class: { id: "1", name: "테스트 1반", status: "active" },
  current_membership: {
    class_id: "1",
    id: "1",
    role: "teacher",
    status: "approved",
  },
  destination: "HOME",
  last_membership_status: null,
  last_status_reason: null,
  server_today: "2026-07-14",
  teacher_profile: { status: "active", temporary_password_must_change: false },
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
    status: 200,
  });
}

function requestUrl(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
}

function LocationSearchProbe(): React.JSX.Element {
  const location = useLocation();
  return <output aria-label="현재 검색 조건">{location.search}</output>;
}

describe("teacher Home quick-create entries", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("opens the notice form from ?new=1 and consumes the one-time intent", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = requestUrl(input);
      if (url === "/api/v1/bootstrap") return Promise.resolve(jsonResponse(teacherBootstrap));
      if (url === "/api/v1/notices?importance=all") {
        return Promise.resolve(
          jsonResponse({ items: [], next_cursor: null, server_today: "2026-07-14" }),
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    render(
      <MemoryRouter initialEntries={["/notices?new=1"]}>
        <NoticesPage />
        <LocationSearchProbe />
      </MemoryRouter>,
    );

    expect(await screen.findByRole("textbox", { name: "공지 제목" })).toBeVisible();
    await waitFor(() => {
      expect(screen.getByRole("status", { name: "현재 검색 조건" })).toHaveTextContent("");
    });
  });

  it("opens the supply form while preserving its existing list scope", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = requestUrl(input);
      if (url === "/api/v1/bootstrap") return Promise.resolve(jsonResponse(teacherBootstrap));
      if (url === "/api/v1/supplies?scope=past") {
        return Promise.resolve(
          jsonResponse({ items: [], next_cursor: null, server_today: "2026-07-14" }),
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    render(
      <MemoryRouter initialEntries={["/supplies?scope=past&new=1"]}>
        <SuppliesPage />
        <LocationSearchProbe />
      </MemoryRouter>,
    );

    expect(await screen.findByRole("textbox", { name: "준비물 제목" })).toBeVisible();
    await waitFor(() => {
      expect(screen.getByRole("status", { name: "현재 검색 조건" })).toHaveTextContent(
        "?scope=past",
      );
    });
  });
});

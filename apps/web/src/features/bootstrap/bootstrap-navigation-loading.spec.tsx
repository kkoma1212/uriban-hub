import { act, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BootstrapPage } from "./bootstrap-page";

const home = {
  account: { display_name: "시험 선생님", email_verified: true, is_active: true },
  allowed_actions: ["VIEW_CLASS", "LOGOUT"],
  current_class: { id: "1", name: "시험 반", status: "active" },
  current_membership: {
    id: "1",
    class_id: "1",
    role: "teacher",
    status: "approved",
    student_number: null,
    display_name_in_class: null,
  },
  destination: "HOME",
  last_membership_status: null,
  last_status_reason: null,
  server_today: "2026-10-11",
  teacher_profile: { status: "active", temporary_password_must_change: false },
};

describe("bootstrap navigation loading", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    { destination: "/home", status: 200, body: home },
    {
      destination: "/login",
      status: 401,
      body: { error: { code: "UNAUTHORIZED", message: "로그인이 필요해요." } },
    },
  ])(
    "keeps loading while $destination waits for its route",
    async ({ destination, status, body }) => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify(body), {
          status,
          headers: { "Content-Type": "application/json" },
        }),
      );
      let finishNavigation!: () => void;
      const destinationReady = new Promise<void>((resolve) => {
        finishNavigation = resolve;
      });
      const router = createMemoryRouter(
        [
          { path: "/bootstrap", element: <BootstrapPage /> },
          { path: destination, loader: () => destinationReady, element: <p>이동 완료</p> },
        ],
        { initialEntries: ["/bootstrap"] },
      );
      render(<RouterProvider router={router} />);

      await waitFor(() => expect(router.state.navigation.location?.pathname).toBe(destination));
      await act(async () => {
        await Promise.resolve();
      });
      expect(screen.getByRole("status")).toHaveTextContent("계정 상태를 확인하고 있어요.");
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(screen.queryByText("계정 상태를 확인하지 못했어요.")).not.toBeInTheDocument();

      await act(async () => {
        finishNavigation();
      });
      expect(await screen.findByText("이동 완료")).toBeVisible();
      router.dispose();
    },
  );
});

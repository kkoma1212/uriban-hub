import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ContentAudienceRequest } from "../../api/content-audiences";
import { ContentAudienceSelector } from "./content-audience-selector";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
    status: 200,
  });
}

describe("ContentAudienceSelector", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("stays all-student and does not read members while the feature is disabled", () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    render(
      <ContentAudienceSelector
        busy={false}
        enabled={false}
        onChange={() => undefined}
        value={{ mode: "all" }}
      />,
    );

    expect(screen.getByRole("radio", { name: /올릴 때의 반 전체 학생/u })).toBeChecked();
    expect(screen.getByRole("radio", { name: /학생 직접 선택/u })).toBeDisabled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows only active approved members and emits selected member ids", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({
        members: [
          {
            account_state: "active",
            display_name: "학생 가",
            display_name_in_class: null,
            id: "10",
            requested_at: null,
            row_version: "1",
            status: "approved",
            status_changed_at: "2026-07-26T00:00:00.000Z",
            student_number: 2,
          },
          {
            account_state: "inactive",
            display_name: "비활성 학생",
            display_name_in_class: null,
            id: "11",
            requested_at: null,
            row_version: "1",
            status: "approved",
            status_changed_at: "2026-07-26T00:00:00.000Z",
            student_number: 3,
          },
          {
            account_state: "active",
            display_name: "학생 나",
            display_name_in_class: "나학생",
            id: "12",
            requested_at: null,
            row_version: "1",
            status: "approved",
            status_changed_at: "2026-07-26T00:00:00.000Z",
            student_number: 1,
          },
        ],
      }),
    );
    let value: ContentAudienceRequest = { mode: "all" };
    const { rerender } = render(
      <ContentAudienceSelector
        busy={false}
        enabled
        onChange={(next) => {
          value = next;
        }}
        value={value}
      />,
    );

    await waitFor(() =>
      expect(globalThis.fetch).toHaveBeenCalledWith("/api/v1/members?status=approved", {
        credentials: "include",
        signal: expect.any(AbortSignal),
      }),
    );
    fireEvent.click(screen.getByRole("radio", { name: /학생 직접 선택/u }));
    rerender(
      <ContentAudienceSelector
        busy={false}
        enabled
        onChange={(next) => {
          value = next;
        }}
        value={value}
      />,
    );

    expect(await screen.findByRole("checkbox", { name: /나학생/u })).toBeVisible();
    expect(screen.getByRole("checkbox", { name: /학생 가/u })).toBeVisible();
    expect(screen.queryByRole("checkbox", { name: /비활성 학생/u })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("checkbox", { name: /나학생/u }));
    expect(value).toEqual({ member_ids: ["12"], mode: "selected" });
  });
});

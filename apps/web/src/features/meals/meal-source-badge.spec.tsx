import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { MealSourceBadge } from "./meal-source-badge";

describe("MealSourceBadge", () => {
  it("shows a date-only NEIS provenance label in detailed mode", () => {
    render(
      <MealSourceBadge
        detailed
        meal={{
          source: "neis",
          source_loaded_on: "2026-07-29",
          source_updated_at: "2026-07-29T10:00:00.000Z",
        }}
      />,
    );

    const badge = screen.getByText("교육청(나이스) 정보").closest("[data-meal-source]");
    expect(badge).toHaveAttribute("data-meal-source", "neis");
    expect(badge).toHaveClass("border-success-border", "bg-success-surface");
    expect(screen.getByText(/7월 29일 수요일 기준/u)).toHaveAttribute("datetime", "2026-07-29");
    expect(badge).not.toHaveTextContent("10:00");
  });

  it("keeps compact NEIS and detailed seed labels distinct", () => {
    const { rerender } = render(
      <MealSourceBadge
        meal={{
          source: "neis",
          source_loaded_on: "2026-07-29",
          source_updated_at: "2026-07-29T10:00:00.000Z",
        }}
      />,
    );
    expect(screen.getByText("교육청(나이스) 정보").closest("[data-meal-source]")).toHaveTextContent(
      "교육청(나이스) 정보",
    );
    expect(screen.queryByText(/기준/u)).not.toBeInTheDocument();

    rerender(
      <MealSourceBadge
        detailed
        meal={{
          source: "seed",
          source_loaded_on: null,
          source_updated_at: "2026-07-29T10:00:00.000Z",
        }}
      />,
    );
    expect(screen.getByText("학교 연동 정보 없음").closest("[data-meal-source]")).toHaveAttribute(
      "data-meal-source",
      "seed",
    );
    expect(screen.getByText("직접 등록")).toBeVisible();
  });
});

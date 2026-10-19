import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SchoolDetailsPanel } from "./school-details-panel";

describe("SchoolDetailsPanel", () => {
  it("shows official school details with safe mobile and homepage links", () => {
    render(
      <SchoolDetailsPanel
        school={{
          school_address: "경기도 안양시 동안구 부림로 71 (평촌동,동안고등학교)",
          school_homepage_url: "https://dongan-h.goeay.kr/",
          school_name: "동안고등학교",
          school_phone_number: "031-387-6105",
        }}
      />,
    );

    expect(screen.getByText(/교육청\(나이스\) 정보/u)).toBeVisible();
    expect(screen.getByText(/경기도 안양시 동안구 부림로 71/u)).toBeVisible();
    expect(screen.getByRole("link", { name: /전화 앱 열기/u })).toHaveAttribute(
      "href",
      "tel:0313876105",
    );
    expect(screen.getByRole("link", { name: "학교 홈페이지 열기" })).toHaveAttribute(
      "href",
      "https://dongan-h.goeay.kr/",
    );
    expect(screen.getByRole("link", { name: "학교 홈페이지 열기" })).toHaveAttribute(
      "rel",
      "noreferrer",
    );
  });

  it("does not invent links for missing details", () => {
    render(
      <SchoolDetailsPanel
        school={{
          school_address: null,
          school_homepage_url: null,
          school_name: "정보 대기 학교",
          school_phone_number: null,
        }}
      />,
    );

    expect(screen.getAllByText("제공된 정보가 없어요.")).toHaveLength(3);
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
});

import { render, screen } from "@testing-library/react";

import { PageHeader } from "./page-header";

describe("PageHeader", () => {
  it("renders the compact PoC heading hierarchy and optional actions", () => {
    const { container } = render(
      <PageHeader
        actions={<button type="button">새로 만들기</button>}
        description="현재 상태를 한눈에 확인해요."
        eyebrow="우리 반"
        title="활동"
      />,
    );

    expect(screen.getByRole("heading", { level: 1, name: "활동" })).toHaveClass("app-page-title");
    expect(screen.getByRole("button", { name: "새로 만들기" })).toBeInTheDocument();
    expect(container.querySelector("[data-page-header='compact']")).toBeInTheDocument();
  });
});

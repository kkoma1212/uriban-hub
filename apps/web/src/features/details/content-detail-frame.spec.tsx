import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import {
  ContentDetailFrame,
  DetailActionBar,
  DetailHeading,
  StudentDetailActions,
} from "./content-detail-frame";

vi.mock("../help-requests/student-help-request", () => ({
  StudentHelpRequest: ({ target }: { target: { id: string } }) => <p>기존 질문 기능 {target.id}</p>,
}));

describe("ContentDetailFrame embedding", () => {
  it("keeps a selected detail inside its list without another shell, h1 or fixed action bar", () => {
    const close = vi.fn();
    render(
      <MemoryRouter>
        <ContentDetailFrame
          embedded
          backTo="/notices"
          backLabel="소식"
          onBack={close}
          aside={
            <DetailActionBar>
              <button type="button">기존 행동</button>
            </DetailActionBar>
          }
        >
          <DetailHeading title="선택한 글" kind="공지" />
        </ContentDetailFrame>
      </MemoryRouter>,
    );
    expect(screen.getByRole("heading", { level: 2, name: "선택한 글" })).toBeVisible();
    expect(screen.queryByRole("heading", { level: 1 })).not.toBeInTheDocument();
    expect(screen.queryByRole("main")).not.toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "주요 메뉴" })).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "기존 행동" }).closest(".content-action-bar"),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "닫기" }));
    expect(close).toHaveBeenCalledOnce();
  });

  it("opens the existing question flow without invoking the separate confirmation action", () => {
    const confirm = vi.fn();
    render(
      <MemoryRouter>
        <StudentDetailActions target={{ id: "17", kind: "notice" }} hint="읽고 확인해 주세요">
          <button onClick={confirm} type="button">
            확인했어요
          </button>
        </StudentDetailActions>
      </MemoryRouter>,
    );
    expect(screen.queryByText("기존 질문 기능 17")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "질문" }));
    expect(screen.getByText("기존 질문 기능 17")).toBeVisible();
    expect(screen.getByRole("button", { name: "질문" })).toHaveAttribute("aria-expanded", "true");
    expect(confirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "확인했어요" }));
    expect(confirm).toHaveBeenCalledOnce();
  });
});

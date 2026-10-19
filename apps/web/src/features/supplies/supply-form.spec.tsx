import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { SupplyForm } from "./supply-form";

/*
 * 숙제는 준비물 표에 종류로 얹혀 있다(T-HUB-17). 교사가 무엇을 적는 중인지
 * 화면 말이 따라가지 않으면 같은 칸에 다른 것을 적게 되므로 그 연결을 묶어 둔다.
 */
describe("SupplyForm category", () => {
  it("starts on 준비물 and asks for a supply title", () => {
    render(
      <SupplyForm
        busy={false}
        onCancel={() => undefined}
        onSubmit={() => undefined}
        submitLabel="등록"
      />,
    );

    expect(screen.getByRole("radio", { name: "준비물" })).toBeChecked();
    expect(screen.getByLabelText(/준비물 제목/u)).toBeInTheDocument();
  });

  it("switches the wording when the teacher picks 숙제", () => {
    render(
      <SupplyForm
        busy={false}
        onCancel={() => undefined}
        onSubmit={() => undefined}
        submitLabel="등록"
      />,
    );

    fireEvent.click(screen.getByRole("radio", { name: "숙제" }));

    expect(screen.getByRole("radio", { name: "숙제" })).toBeChecked();
    expect(screen.getByLabelText(/숙제 제목/u)).toBeInTheDocument();
    expect(screen.getByPlaceholderText("예: 수학 익힘책 12~15쪽")).toBeInTheDocument();
  });

  it("sends the chosen category with the submitted values", () => {
    const onSubmit = vi.fn();
    render(
      <SupplyForm busy={false} onCancel={() => undefined} onSubmit={onSubmit} submitLabel="등록" />,
    );

    fireEvent.click(screen.getByRole("radio", { name: "숙제" }));
    fireEvent.change(screen.getByLabelText(/숙제 제목/u), {
      target: { value: "수학 익힘책 12~15쪽" },
    });
    fireEvent.change(screen.getByLabelText(/마감 날짜/u), { target: { value: "2026-07-20" } });
    fireEvent.click(screen.getByRole("button", { name: "등록" }));

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ category: "homework", title: "수학 익힘책 12~15쪽" }),
    );
  });

  it("opens on the category the edited item already has", () => {
    render(
      <SupplyForm
        busy={false}
        initialValue={{
          category: "homework",
          description: null,
          needed_on: "2026-07-20",
          title: "이미 숙제인 항목",
        }}
        onCancel={() => undefined}
        onSubmit={() => undefined}
        submitLabel="저장"
      />,
    );

    expect(screen.getByRole("radio", { name: "숙제" })).toBeChecked();
  });
});

describe("SupplyForm input frame", () => {
  it("requires a date, reviews the chosen date, and sends only after confirmation", () => {
    const onSubmit = vi.fn();
    render(
      <SupplyForm
        busy={false}
        onCancel={vi.fn()}
        onSubmit={onSubmit}
        selectedAudienceEnabled={false}
        serverToday="2026-07-29"
        showCompositionSteps
        showPublishSummary
        submitLabel="등록"
      />,
    );
    fireEvent.change(screen.getByRole("textbox", { name: "준비물 제목" }), {
      target: { value: "색연필" },
    });
    fireEvent.click(screen.getByRole("button", { name: "날짜를 선택해 주세요" }));
    expect(screen.getByRole("alert")).toHaveTextContent("준비물이 필요한 날짜를 선택해 주세요.");
    expect(screen.getByLabelText("필요한 날짜")).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "내일 7/30" }));
    expect(screen.getByLabelText("필요한 날짜")).toHaveValue("2026-07-30");
    fireEvent.click(screen.getByRole("button", { name: "올리기" }));
    const review = screen.getByRole("dialog", { name: "준비물 게시 전 검토" });
    expect(onSubmit).not.toHaveBeenCalled();
    expect(within(review).getByRole("heading", { name: "색연필" })).toBeVisible();
    fireEvent.click(within(review).getByRole("button", { name: "올리기" }));
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith({
      audience: { mode: "all" },
      category: "general",
      description: null,
      needed_on: "2026-07-30",
      title: "색연필",
    });
  });
  it("preserves the optional description limit in the one-screen composer", () => {
    const onSubmit = vi.fn();
    render(
      <SupplyForm
        busy={false}
        onCancel={vi.fn()}
        onSubmit={onSubmit}
        serverToday="2026-07-29"
        showCompositionSteps
        submitLabel="등록"
      />,
    );
    fireEvent.change(screen.getByRole("textbox", { name: "준비물 제목" }), {
      target: { value: "색연필" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "설명 (선택)" }), {
      target: { value: "가".repeat(501) },
    });
    fireEvent.click(screen.getByRole("button", { name: "설명을 500자 이내로 적어 주세요" }));
    expect(screen.getByRole("alert")).toHaveTextContent("설명은 500자 이하로 입력해 주세요.");
    expect(screen.getByRole("textbox", { name: "설명 (선택)" })).toHaveFocus();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

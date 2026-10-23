import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SupplyForm } from "./supply-form";

afterEach(() => vi.restoreAllMocks());

function renderForm(showCompositionSteps: boolean, description: string) {
  render(
    <MemoryRouter>
      <SupplyForm
        busy={false}
        initialValue={{
          audience: { mode: "all" },
          category: "homework",
          description,
          needed_on: "2026-10-30",
          title: "수학 익힘책",
        }}
        onCancel={() => undefined}
        onSubmit={() => undefined}
        serverToday="2026-10-23"
        showCompositionSteps={showCompositionSteps}
        submitLabel="저장"
      />
    </MemoryRouter>,
  );
  return screen.getByLabelText(/^설명/u) as HTMLTextAreaElement;
}

describe("준비물·숙제 설명 굵게·형광펜 (2026-10-23)", () => {
  it("새 쓰기 화면: [형광펜]으로 감싸면 미리보기에 형광펜으로 보인다", () => {
    const textarea = renderForm(true, "3쪽까지 풀어 오세요");
    textarea.setSelectionRange(0, 4);
    fireEvent.click(screen.getByRole("button", { name: "형광펜" }));
    expect(textarea.value).toBe("==3쪽까지== 풀어 오세요");
    const preview = screen.getAllByText("학생에게 이렇게 보여요")[0]!.closest("div")!;
    expect(within(preview).getByText("3쪽까지").tagName).toBe("MARK");
  });

  it("수정(예전 양식): [굵게]로 감싸면 서식이 있을 때만 작은 미리보기가 나온다", () => {
    const textarea = renderForm(false, "색연필 챙기기");
    expect(document.querySelector("[data-rich-text-preview]")).toBeNull();
    textarea.setSelectionRange(0, 3);
    fireEvent.click(screen.getByRole("button", { name: "굵게" }));
    expect(textarea.value).toBe("**색연필** 챙기기");
    const preview = document.querySelector<HTMLElement>("[data-rich-text-preview]")!;
    expect(within(preview).getByText("색연필").tagName).toBe("STRONG");
  });
});

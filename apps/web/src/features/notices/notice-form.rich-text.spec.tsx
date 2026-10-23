import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { RichText } from "../details/rich-text";
import { NoticeForm } from "./notice-form";

afterEach(() => vi.restoreAllMocks());

function renderForm(showCompositionSteps: boolean, content = "") {
  const onSubmit = vi.fn();
  render(
    <MemoryRouter>
      <NoticeForm
        busy={false}
        initialValue={{
          audience: { mode: "all" },
          category: "general",
          content,
          is_important: false,
          title: "체육 안내",
        }}
        onCancel={() => undefined}
        onSubmit={onSubmit}
        showCompositionSteps={showCompositionSteps}
        submitLabel="저장"
      />
    </MemoryRouter>,
  );
  return { onSubmit, textarea: screen.getByLabelText(/^공지 내용/u) as HTMLTextAreaElement };
}

describe("공지 본문 굵게·형광펜 (T-RICHTEXT)", () => {
  it("본문을 글자로만 그린다 — HTML처럼 보이는 글도 실행되지 않는다", () => {
    const { container } = render(
      <p>
        <RichText text={'**<img src=x onerror="alert(1)">** ==강당==\n보통 글'} />
      </p>,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("strong")).toHaveTextContent('<img src=x onerror="alert(1)">');
    expect(container.querySelector("mark")).toHaveTextContent("강당");
    expect(container).toHaveTextContent("보통 글");
  });

  it("새 쓰기 화면: 고른 글자를 [굵게]로 감싸고 미리보기에 굵게로 보인다", () => {
    const { onSubmit, textarea } = renderForm(true, "내일 체육복 챙겨 오세요");
    textarea.setSelectionRange(3, 6);
    fireEvent.click(screen.getByRole("button", { name: "굵게" }));
    expect(textarea.value).toBe("내일 **체육복** 챙겨 오세요");
    // 감싼 뒤에도 같은 글자를 계속 골라 두고 쓰기 칸에 초점을 둔다.
    expect(textarea).toHaveFocus();
    expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([5, 8]);
    const preview = screen.getAllByText("학생에게 이렇게 보여요")[0]!.closest("div")!;
    expect(within(preview).getByText("체육복").tagName).toBe("STRONG");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("공지 수정(예전 양식): [형광펜]으로 감싸면 서식이 있을 때만 작은 미리보기가 나온다", () => {
    const { textarea } = renderForm(false, "비가 오면 강당에서 해요");
    expect(document.querySelector("[data-rich-text-preview]")).toBeNull();
    textarea.setSelectionRange(0, 8);
    fireEvent.click(screen.getByRole("button", { name: "형광펜" }));
    expect(textarea.value).toBe("==비가 오면 강당==에서 해요");
    const preview = document.querySelector("[data-rich-text-preview]")!;
    expect(within(preview as HTMLElement).getByText("비가 오면 강당").tagName).toBe("MARK");
  });
});

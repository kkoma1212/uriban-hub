import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as birthDateApi from "../../api/account-birth-date";
import { BirthDatePanel } from "./birth-date-panel";

afterEach(() => vi.restoreAllMocks());

describe("BirthDatePanel", () => {
  it("shows a stored teacher birth date but offers birthday sharing only to students", async () => {
    vi.spyOn(birthDateApi, "getAccountBirthDate").mockResolvedValue({
      available: true,
      birth_date: "2000-03-05",
      birthday_shared: false,
    });
    const update = vi.spyOn(birthDateApi, "updateAccountBirthDate").mockResolvedValue({
      available: true,
      birth_date: "2000-03-05",
      birthday_shared: true,
    });
    const { rerender } = render(<BirthDatePanel role="teacher" />);
    expect(await screen.findByText("2000. 03. 05.", { exact: false })).toBeVisible();
    expect(screen.getByText("고치려면 운영자에게 문의해 주세요.")).toBeVisible();
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.queryByText(/켜면 생일 당일/u)).not.toBeInTheDocument();
    expect(update).not.toHaveBeenCalled();

    rerender(<BirthDatePanel role="student" />);
    const sharing = screen.getByRole("checkbox", { name: "생일에 우리 반 홈에 알리기" });
    expect(sharing).toBeVisible();
    fireEvent.click(sharing);
    await waitFor(() => expect(update).toHaveBeenCalledExactlyOnceWith({ birthday_shared: true }));
    expect(await screen.findByRole("status")).toHaveTextContent(
      "3월 5일에 우리 반 홈에 생일을 알려요.",
    );
    expect(sharing).toBeChecked();
  });

  it("locks the birth date during saving and restores editing after a failed request", async () => {
    vi.spyOn(birthDateApi, "getAccountBirthDate").mockResolvedValue({
      available: true,
      birth_date: null,
      birthday_shared: false,
    });
    let fail!: (error: Error) => void;
    const update = vi.spyOn(birthDateApi, "updateAccountBirthDate").mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          fail = reject;
        }),
    );
    render(<BirthDatePanel />);
    const input = await screen.findByLabelText("생년월일", { selector: "input" });
    fireEvent.change(input, { target: { value: "2010-03-05" } });
    fireEvent.click(screen.getByRole("button", { name: "저장" }));
    fireEvent.click(await screen.findByRole("button", { name: "맞아요, 저장" }));
    expect(input).toBeDisabled();
    expect(screen.getByRole("button", { name: "다시 고르기" })).toBeDisabled();
    expect(update).toHaveBeenCalledExactlyOnceWith({ birth_date: "2010-03-05" });
    await act(async () => {
      fail(new Error("잠시 후 다시 시도해 주세요."));
    });
    expect(await screen.findByRole("alert")).toHaveTextContent("잠시 후 다시 시도해 주세요.");
    expect(input).toBeEnabled();
    expect(input).toHaveValue("2010-03-05");
    expect(screen.getByRole("button", { name: "맞아요, 저장" })).toBeEnabled();
  });

  it("asks once more before saving a birth date that cannot be changed later (B3-12)", async () => {
    vi.spyOn(birthDateApi, "getAccountBirthDate").mockResolvedValue({
      available: true,
      birth_date: null,
      birthday_shared: false,
    });
    const update = vi.spyOn(birthDateApi, "updateAccountBirthDate").mockResolvedValue({
      available: true,
      birth_date: "2010-03-05",
      birthday_shared: false,
    });
    render(<BirthDatePanel />);
    fireEvent.change(await screen.findByLabelText("생년월일", { selector: "input" }), {
      target: { value: "2010-03-05" },
    });
    fireEvent.click(screen.getByRole("button", { name: "저장" }));
    expect(await screen.findByText(/2010년 3월 5일\(만 \d+세\)이 맞나요\?/u)).toBeVisible();
    expect(update).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "다시 고르기" }));
    expect(screen.queryByText(/이 맞나요\?/u)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "저장" }));
    fireEvent.click(await screen.findByRole("button", { name: "맞아요, 저장" }));
    await waitFor(() => expect(update).toHaveBeenCalledWith({ birth_date: "2010-03-05" }));
  });
});

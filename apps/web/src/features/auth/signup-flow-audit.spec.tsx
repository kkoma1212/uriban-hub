import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as socialAuth from "../../api/social-auth";
import { BirthDateField } from "./sign-up-choices";
import { SocialLoginButtons } from "./social-login-buttons";

afterEach(() => vi.restoreAllMocks());

describe("sign-up small defects (total audit B3)", () => {
  it("B3-03: explains why a future birth date cannot be used", () => {
    render(<BirthDateField error={undefined} inputProps={{}} value="2999-01-01" />);
    expect(screen.getByText("오늘까지의 실제 생년월일을 입력해 주세요.")).toBeInTheDocument();
    expect(screen.getByLabelText("생년월일을 입력해 주세요")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
  });

  it("B3-16: a page restored by the browser back button re-enables the quick login buttons", async () => {
    vi.spyOn(socialAuth, "getSocialProviders").mockResolvedValue(["google"]);
    vi.spyOn(socialAuth, "beginSocialLogin").mockReturnValue(new Promise(() => undefined));
    render(<SocialLoginButtons />);
    const buttons = await screen.findAllByRole("button");
    fireEvent.click(buttons[0]!);
    await waitFor(() => expect(buttons[0]).toBeDisabled());
    const restored = new Event("pageshow") as PageTransitionEvent;
    Object.defineProperty(restored, "persisted", { value: true });
    window.dispatchEvent(restored);
    await waitFor(() => expect(buttons[0]).toBeEnabled());
  });
});

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Avatar } from "./avatar";

describe("authenticated profile photo Avatar", () => {
  it("uses the name initial when no photo is available", () => {
    render(<Avatar name=" 김하나 " decorative={false} />);
    expect(screen.getByRole("img", { name: "김하나 프로필 사진" })).toHaveTextContent("김");
    expect(document.querySelector("img")).toBeNull();
  });
  it("falls back on authorization/no-photo failure and retries only for a new URL", () => {
    const first = "/api/v1/profile-photos/me?v=1234-abcd";
    const { rerender } = render(<Avatar name="김하나" photoUrl={first} />);
    const image = document.querySelector("img")!;
    expect(image).toHaveAttribute("src", first);
    fireEvent.error(image);
    expect(document.querySelector("img")).toBeNull();
    expect(screen.getByText("김")).toBeVisible();
    rerender(<Avatar name="김하나" photoUrl="/api/v1/profile-photos/me?v=5678-abcd" />);
    expect(document.querySelector("img")).toHaveAttribute(
      "src",
      "/api/v1/profile-photos/me?v=5678-abcd",
    );
  });
  it.each([
    "https://other.example/picture",
    "//other.example/picture",
    "/api/v1/profile-photos/members/2/../../../auth/logout",
    "data:image/svg+xml,<svg/>",
  ])("does not load arbitrary image sources", (photoUrl) => {
    render(<Avatar name="김하나" photoUrl={photoUrl} />);
    expect(document.querySelector("img")).toBeNull();
  });
});

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  deleteOwnProfilePhoto,
  getOwnProfilePhoto,
  prepareProfilePhoto,
  updateOwnProfilePhoto,
  type ProfilePhotoState,
} from "../../api/profile-photos";
import { ProfilePhotoSettings } from "./profile-photo-settings";

vi.mock("../../api/profile-photos", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api/profile-photos")>();
  return {
    ...actual,
    deleteOwnProfilePhoto: vi.fn(),
    getOwnProfilePhoto: vi.fn(),
    prepareProfilePhoto: vi.fn(),
    updateOwnProfilePhoto: vi.fn(),
  };
});

const LIMITS = {
  formats: ["image/jpeg", "image/png", "image/webp"],
  source_pixels: 16_000_000,
  stored_bytes: 64 * 1024,
  upload_bytes: 512 * 1024,
};
const PHOTO = {
  content_type: "image/webp" as const,
  height: 256 as const,
  url: "/api/v1/profile-photos/me?v=1234-abcd",
  version: "1234-abcd",
  width: 256 as const,
};
function enabled(photo: ProfilePhotoState["photo"]): ProfilePhotoState {
  return { enabled: true, limits: LIMITS, photo };
}
function chooseFile(): void {
  const input = screen.getByLabelText("프로필 사진 고르기");
  fireEvent.change(input, {
    target: { files: [new File(["x"], "me.png", { type: "image/png" })] },
  });
}

describe("ProfilePhotoSettings", () => {
  beforeEach(() => {
    vi.mocked(prepareProfilePhoto).mockResolvedValue({ image_base64: "UklGRg==" });
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("shows no upload controls when the server feature is off", async () => {
    vi.mocked(getOwnProfilePhoto).mockResolvedValue({ enabled: false, limits: null, photo: null });
    const { container } = render(<ProfilePhotoSettings name="김하나" />);
    await waitFor(() => expect(getOwnProfilePhoto).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it("shows a retry when loading fails and restores the controls on success", async () => {
    vi.mocked(getOwnProfilePhoto).mockRejectedValue(new Error("network"));
    render(<ProfilePhotoSettings name="김하나" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("프로필 사진을 불러오지 못했어요.");
    expect(screen.queryByRole("button", { name: /사진 고르기/u })).not.toBeInTheDocument();
    vi.mocked(getOwnProfilePhoto).mockResolvedValue(enabled(null));
    fireEvent.click(screen.getByRole("button", { name: "사진 다시 불러오기" }));
    expect(await screen.findByRole("button", { name: /사진 고르기/u })).toBeVisible();
  });

  it("previews a chosen photo and cancels without saving", async () => {
    vi.mocked(getOwnProfilePhoto).mockResolvedValue(enabled(null));
    render(<ProfilePhotoSettings name="김하나" />);
    expect(
      await screen.findByText("저장한 사진은 같은 반의 승인된 구성원과 선생님에게 보여요."),
    ).toBeVisible();
    expect(screen.queryByRole("button", { name: /사진 지우기/u })).not.toBeInTheDocument();

    chooseFile();
    const preview = await screen.findByRole("img", { name: "새 프로필 사진 미리보기" });
    expect(preview).toHaveAttribute("src", "data:image/webp;base64,UklGRg==");
    fireEvent.click(screen.getByRole("button", { name: "취소" }));

    expect(screen.queryByRole("img", { name: "새 프로필 사진 미리보기" })).not.toBeInTheDocument();
    expect(updateOwnProfilePhoto).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /사진 고르기/u })).toBeVisible();
  });

  it("saves the prepared photo and shows the stored version", async () => {
    vi.mocked(getOwnProfilePhoto).mockResolvedValue(enabled(null));
    vi.mocked(updateOwnProfilePhoto).mockResolvedValue(enabled(PHOTO));
    render(<ProfilePhotoSettings name="김하나" />);
    await screen.findByRole("button", { name: /사진 고르기/u });

    chooseFile();
    fireEvent.click(await screen.findByRole("button", { name: "이 사진으로 저장" }));

    expect(await screen.findByRole("status")).toHaveTextContent("프로필 사진을 저장했어요.");
    expect(updateOwnProfilePhoto).toHaveBeenCalledWith({ image_base64: "UklGRg==" });
    expect(
      document.querySelector('img[src="/api/v1/profile-photos/me?v=1234-abcd"]'),
    ).not.toBeNull();
    expect(screen.getByRole("button", { name: /사진 바꾸기/u })).toBeVisible();
  });

  it("keeps the preview for another try when saving fails", async () => {
    vi.mocked(getOwnProfilePhoto).mockResolvedValue(enabled(null));
    vi.mocked(updateOwnProfilePhoto).mockRejectedValue(new Error("잠시 후 다시 시도해 주세요."));
    render(<ProfilePhotoSettings name="김하나" />);
    await screen.findByRole("button", { name: /사진 고르기/u });

    chooseFile();
    fireEvent.click(await screen.findByRole("button", { name: "이 사진으로 저장" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("잠시 후 다시 시도해 주세요.");
    expect(screen.getByRole("img", { name: "새 프로필 사진 미리보기" })).toBeVisible();
    expect(screen.getByRole("button", { name: "이 사진으로 저장" })).toBeEnabled();
  });

  it("reports an unusable file without leaving a preview", async () => {
    vi.mocked(getOwnProfilePhoto).mockResolvedValue(enabled(null));
    vi.mocked(prepareProfilePhoto).mockRejectedValue(
      new Error("10MB 이하 JPG·PNG·WebP 사진을 선택해 주세요."),
    );
    render(<ProfilePhotoSettings name="김하나" />);
    await screen.findByRole("button", { name: /사진 고르기/u });

    chooseFile();

    expect(await screen.findByRole("alert")).toHaveTextContent("10MB 이하 JPG·PNG·WebP");
    expect(screen.queryByRole("img", { name: "새 프로필 사진 미리보기" })).not.toBeInTheDocument();
  });

  it("deletes the stored photo only after confirmation", async () => {
    vi.mocked(getOwnProfilePhoto).mockResolvedValue(enabled(PHOTO));
    vi.mocked(deleteOwnProfilePhoto).mockResolvedValue(enabled(null));
    render(<ProfilePhotoSettings name="김하나" />);

    fireEvent.click(await screen.findByRole("button", { name: /사진 지우기/u }));
    expect(deleteOwnProfilePhoto).not.toHaveBeenCalled();
    const dialog = await screen.findByRole("dialog", { name: "프로필 사진을 지울까요?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "사진 지우기" }));

    expect(await screen.findByRole("status")).toHaveTextContent("프로필 사진을 지웠어요.");
    expect(deleteOwnProfilePhoto).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: /사진 지우기/u })).not.toBeInTheDocument();
  });
});

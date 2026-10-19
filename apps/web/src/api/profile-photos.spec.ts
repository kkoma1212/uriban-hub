import { afterEach, describe, expect, it, vi } from "vitest";
import { apiFetch, withCsrfRecovery } from "./auth";
import {
  currentClassTeacherPhotoUrl,
  deleteOwnProfilePhoto,
  getOwnProfilePhoto,
  memberProfilePhotoUrl,
  prepareProfilePhoto,
  updateOwnProfilePhoto,
} from "./profile-photos";

vi.mock("./auth", () => ({
  apiFetch: vi.fn(),
  parseResponse: vi.fn(async (response: Response) => response.json()),
  withCsrfRecovery: vi.fn(async (callback: (context: unknown) => Promise<Response>) =>
    (await callback({ apiFetch, csrfToken: "fixture-token" })).json(),
  ),
}));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("profile photo API client", () => {
  it("keeps an unregistered API disabled without exposing an uploader", async () => {
    vi.mocked(apiFetch).mockResolvedValue(new Response(null, { status: 404 }));
    expect(await getOwnProfilePhoto()).toEqual({ enabled: false, photo: null, limits: null });
    expect(apiFetch).toHaveBeenCalledWith("/api/v1/account/profile-photo", {
      credentials: "include",
      cache: "no-store",
    });
  });
  it("sends only prepared image data and uses the existing CSRF recovery for changes/deletion", async () => {
    vi.mocked(apiFetch).mockImplementation(
      async () => new Response(JSON.stringify({ enabled: true, photo: null })),
    );
    await updateOwnProfilePhoto({ image_base64: "dGVzdA==" });
    expect(apiFetch).toHaveBeenLastCalledWith(
      "/api/v1/account/profile-photo",
      expect.objectContaining({
        method: "PUT",
        credentials: "include",
        body: '{"image_base64":"dGVzdA=="}',
        headers: { "Content-Type": "application/json", "X-CSRF-Token": "fixture-token" },
      }),
    );
    await deleteOwnProfilePhoto();
    expect(apiFetch).toHaveBeenLastCalledWith(
      "/api/v1/account/profile-photo",
      expect.objectContaining({
        method: "DELETE",
        credentials: "include",
        headers: { "X-CSRF-Token": "fixture-token" },
      }),
    );
    expect(withCsrfRecovery).toHaveBeenCalledTimes(2);
  });
  it("keeps member photo URLs relative and rejects malformed identities", () => {
    expect(memberProfilePhotoUrl("42")).toBe("/api/v1/profile-photos/members/42");
    expect(currentClassTeacherPhotoUrl("7")).toBe(
      "/api/v1/profile-photos/current-class-teacher?class_id=7",
    );
    expect(() => currentClassTeacherPhotoUrl("0")).toThrow();
    for (const id of ["0", "../me", "42?other=1", "9223372036854775808"])
      expect(() => memberProfilePhotoUrl(id)).toThrow();
  });
  it("rejects unsupported or oversized source files before decoding", async () => {
    const decode = vi.fn();
    vi.stubGlobal("createImageBitmap", decode);
    await expect(
      prepareProfilePhoto(new File(["source"], "photo.svg", { type: "image/svg+xml" })),
    ).rejects.toThrow("10MB 이하");
    await expect(
      prepareProfilePhoto({ type: "image/png", size: 10 * 1024 * 1024 + 1 } as File),
    ).rejects.toThrow("10MB 이하");
    expect(decode).not.toHaveBeenCalled();
  });
  it("reduces a supported picture locally and always releases the decoded bitmap", async () => {
    const close = vi.fn();
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => ({ width: 800, height: 400, close })),
    );
    const drawImage = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      drawImage,
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback) =>
      callback({
        type: "image/webp",
        size: 3,
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
      } as Blob),
    );
    expect(
      await prepareProfilePhoto(new File(["fake"], "photo.png", { type: "image/png" })),
    ).toEqual({ image_base64: "AQID" });
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 512, 256);
    expect(close).toHaveBeenCalledTimes(1);
  });
  it("releases an oversized decoded image without creating an upload", async () => {
    const close = vi.fn();
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => ({ width: 4001, height: 4000, close })),
    );
    await expect(
      prepareProfilePhoto(new File(["fake"], "photo.png", { type: "image/png" })),
    ).rejects.toThrow("1,600만 화소");
    expect(close).toHaveBeenCalledTimes(1);
  });
});

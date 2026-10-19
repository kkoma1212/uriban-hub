import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { InvalidProfilePhotoException } from "./profile-photo.errors.js";
import { ProfilePhotoImageService } from "./profile-photo-image.service.js";
import {
  PROFILE_PHOTO_STORED_BYTES,
  PROFILE_PHOTO_UPLOAD_BYTES,
} from "./profile-photo.constants.js";

describe("profile photo image boundary", () => {
  it("stores only an oriented 256px WebP without source metadata", async () => {
    const source = await sharp({
      create: { width: 600, height: 320, channels: 3, background: "#b42a37" },
    })
      .jpeg()
      .withMetadata({
        orientation: 6,
        exif: { IFD0: { Artist: "synthetic secret", ImageDescription: "not retained" } },
      })
      .toBuffer();
    const output = await new ProfilePhotoImageService().encode(source.toString("base64"));
    const metadata = await sharp(output).metadata();
    expect(metadata).toMatchObject({ format: "webp", width: 256, height: 256 });
    expect(metadata.exif).toBeUndefined();
    expect(metadata.xmp).toBeUndefined();
    expect(metadata.icc).toBeUndefined();
    expect(metadata.orientation).toBeUndefined();
    expect(output.byteLength).toBeLessThanOrEqual(PROFILE_PHOTO_STORED_BYTES);
    expect(output.includes(Buffer.from("synthetic secret"))).toBe(false);
  });
  it.each(["png", "webp"] as const)(
    "accepts a %s source and enforces the stored size",
    async (format) => {
      const input = sharp({
        create: { width: 16, height: 12, channels: 4, background: "#28644880" },
      });
      const source = await input.toFormat(format).toBuffer();
      const bytes = await new ProfilePhotoImageService().encode(source.toString("base64"));
      expect(await sharp(bytes).metadata()).toMatchObject({
        format: "webp",
        width: 256,
        height: 256,
      });
      expect(bytes.byteLength).toBeLessThanOrEqual(64_000);
    },
  );
  it.each([
    "",
    "not a photo",
    "data:image/png;base64,AAAA",
    "AAA",
    "AB==",
    Buffer.from("<svg xmlns='http://www.w3.org/2000/svg' width='1' height='1'/>").toString(
      "base64",
    ),
  ])("rejects noncanonical or non-raster input", async (source) => {
    await expect(new ProfilePhotoImageService().encode(source)).rejects.toBeInstanceOf(
      InvalidProfilePhotoException,
    );
  });
  it("rejects large input and excessive decoded pixel dimensions", async () => {
    const service = new ProfilePhotoImageService();
    await expect(
      service.encode(Buffer.alloc(PROFILE_PHOTO_UPLOAD_BYTES + 1).toString("base64")),
    ).rejects.toBeInstanceOf(InvalidProfilePhotoException);
    const source = await sharp({
      create: { width: 4001, height: 4000, channels: 3, background: "#fff" },
    })
      .png()
      .toBuffer();
    await expect(service.encode(source.toString("base64"))).rejects.toBeInstanceOf(
      InvalidProfilePhotoException,
    );
  });
  it("rejects animated images instead of silently retaining the first frame", async () => {
    const source = await sharp(
      Buffer.concat([Buffer.alloc(8 * 8 * 3, 0), Buffer.alloc(8 * 8 * 3, 255)]),
      { raw: { width: 8, height: 16, pageHeight: 8, channels: 3 } },
    )
      .webp({ loop: 0, delay: [100, 100] })
      .toBuffer();
    expect((await sharp(source).metadata()).pages).toBe(2);
    await expect(
      new ProfilePhotoImageService().encode(source.toString("base64")),
    ).rejects.toBeInstanceOf(InvalidProfilePhotoException);
  });
});

import { Injectable } from "@nestjs/common";
import sharp from "sharp";
import {
  PROFILE_PHOTO_INPUT_PIXELS,
  PROFILE_PHOTO_MAX_BASE64_LENGTH,
  PROFILE_PHOTO_SIZE,
  PROFILE_PHOTO_STORED_BYTES,
  PROFILE_PHOTO_UPLOAD_BYTES,
} from "./profile-photo.constants.js";
import { InvalidProfilePhotoException, ProfilePhotoBusyException } from "./profile-photo.errors.js";

@Injectable()
export class ProfilePhotoImageService {
  private active = 0;

  async encode(base64: string): Promise<Buffer> {
    if (
      typeof base64 !== "string" ||
      base64.length === 0 ||
      base64.length > PROFILE_PHOTO_MAX_BASE64_LENGTH ||
      !/^[A-Za-z0-9+/]+={0,2}$/u.test(base64)
    )
      throw new InvalidProfilePhotoException();
    const input = Buffer.from(base64, "base64");
    if (
      input.byteLength === 0 ||
      input.byteLength > PROFILE_PHOTO_UPLOAD_BYTES ||
      input.toString("base64") !== base64
    )
      throw new InvalidProfilePhotoException();
    // Bound simultaneous native decodes; do not queue unbounded image buffers.
    if (this.active >= 2) throw new ProfilePhotoBusyException();
    this.active += 1;
    try {
      const image = sharp(input, {
        limitInputPixels: PROFILE_PHOTO_INPUT_PIXELS,
        failOn: "warning",
        animated: false,
      });
      const metadata = await image.metadata();
      if (
        !metadata.width ||
        !metadata.height ||
        !["jpeg", "png", "webp"].includes(metadata.format ?? "") ||
        (metadata.pages ?? 1) !== 1 ||
        metadata.width * metadata.height > PROFILE_PHOTO_INPUT_PIXELS
      )
        throw new InvalidProfilePhotoException();
      // No keepMetadata/withMetadata: EXIF, GPS, XMP and original file names are never retained.
      const encoded = await image
        .rotate()
        .resize(PROFILE_PHOTO_SIZE, PROFILE_PHOTO_SIZE, { fit: "cover", position: "centre" })
        .webp({ quality: 80, effort: 4 })
        .timeout({ seconds: 5 })
        .toBuffer();
      if (encoded.byteLength > PROFILE_PHOTO_STORED_BYTES) throw new InvalidProfilePhotoException();
      return encoded;
    } catch (error) {
      if (error instanceof InvalidProfilePhotoException) throw error;
      throw new InvalidProfilePhotoException();
    } finally {
      this.active -= 1;
    }
  }
}

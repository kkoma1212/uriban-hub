export const PROFILE_PHOTO_UPLOAD_BYTES = 512 * 1024;
export const PROFILE_PHOTO_MAX_BASE64_LENGTH = 4 * Math.ceil(PROFILE_PHOTO_UPLOAD_BYTES / 3);
export const PROFILE_PHOTO_STORED_BYTES = 64_000;
export const PROFILE_PHOTO_INPUT_PIXELS = 16_000_000;
export const PROFILE_PHOTO_SIZE = 256;
export const PROFILE_PHOTO_FORMATS = ["image/jpeg", "image/png", "image/webp"] as const;

import { PROFILE_PHOTO_UPLOAD_BYTES } from "../../profile-photos/profile-photo.constants.js";
import { allowedPictureUrl } from "./social-auth.provider.js";
import type { SocialProvider } from "./social-auth.environment.js";

const PICTURE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

/**
 * 2026-10-01 사용자 결정: 본인이 '프로필 사진 쓰기'를 고른 첫 가입에서만 회사 프로필 사진을 받는다.
 * 회사 이미지 서버 주소만, 다른 주소로 넘기기(redirect) 없이, 512KB·5초 안에서만 받는다.
 * 실패하면 사진 없이 가입을 마친다(설정에서 직접 올릴 수 있다). 반환값은 base64 원본이다.
 */
export async function fetchProviderPicture(
  provider: SocialProvider,
  url: string,
): Promise<string | null> {
  const allowed = allowedPictureUrl(provider, url);
  if (allowed === null) return null;
  try {
    const response = await fetch(allowed, {
      redirect: "error",
      signal: AbortSignal.timeout(5000),
      headers: { Accept: "image/jpeg,image/png,image/webp" },
    });
    const type = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (!response.ok || !type || !PICTURE_TYPES.has(type) || declared > PROFILE_PHOTO_UPLOAD_BYTES)
      return null;
    const reader = response.body?.getReader();
    if (!reader) return null;
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > PROFILE_PHOTO_UPLOAD_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
    return size === 0 ? null : Buffer.concat(chunks).toString("base64");
  } catch {
    return null;
  }
}

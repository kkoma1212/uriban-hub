import { apiFetch, parseResponse, withCsrfRecovery } from "./auth";

export const PROFILE_PHOTO_ACCEPT = "image/jpeg,image/png,image/webp";
export const PROFILE_PHOTO_FILE_BYTES = 10 * 1024 * 1024;
const UPLOAD_BYTES = 512 * 1024;
const SOURCE_PIXELS = 16_000_000;
const FORMATS = ["image/jpeg", "image/png", "image/webp"];

export interface ProfilePhotoDescriptor {
  url: string;
  version: string;
  width: 256;
  height: 256;
  content_type: "image/webp";
}
export interface ProfilePhotoState {
  enabled: true;
  photo: ProfilePhotoDescriptor | null;
  limits: {
    upload_bytes: number;
    stored_bytes: number;
    source_pixels: number;
    formats: readonly string[];
  };
}
export type OwnProfilePhotoState =
  ProfilePhotoState | { enabled: false; photo: null; limits: null };
export interface PreparedProfilePhoto {
  image_base64: string;
}

export async function getOwnProfilePhoto(): Promise<OwnProfilePhotoState> {
  const response = await apiFetch("/api/v1/account/profile-photo", {
    credentials: "include",
    cache: "no-store",
  });
  // An unregistered module is an intentional feature-off state, not an empty enabled uploader.
  if (response.status === 404) return { enabled: false, photo: null, limits: null };
  return parseResponse<ProfilePhotoState>(response);
}

export async function updateOwnProfilePhoto(
  prepared: PreparedProfilePhoto,
): Promise<ProfilePhotoState> {
  return withCsrfRecovery<ProfilePhotoState>(({ apiFetch, csrfToken }) =>
    apiFetch("/api/v1/account/profile-photo", {
      body: JSON.stringify(prepared),
      credentials: "include",
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
    }),
  );
}

export async function deleteOwnProfilePhoto(): Promise<ProfilePhotoState> {
  return withCsrfRecovery<ProfilePhotoState>(({ apiFetch, csrfToken }) =>
    apiFetch("/api/v1/account/profile-photo", {
      credentials: "include",
      method: "DELETE",
      headers: { "X-CSRF-Token": csrfToken },
    }),
  );
}

export function memberProfilePhotoUrl(memberId: string): string {
  if (!/^[1-9][0-9]{0,18}$/u.test(memberId) || BigInt(memberId) > 9223372036854775807n)
    throw new TypeError("올바르지 않은 반 구성원입니다.");
  return "/api/v1/profile-photos/members/" + memberId;
}
/**
 * 목록 화면용: 사진 기능이 꺼졌거나 구성원 번호가 올바르지 않으면 주소 없이(이름 첫 글자) 둔다.
 * 목록 응답의 has_profile_photo가 false면 enabled를 false로 넘겨 404 요청을 만들지 않는다(첫 사용 점검 19번).
 * 표시가 없는 옛 응답(undefined)은 예전처럼 요청한다 — 그래서 호출부는 `!== false`로 비교한다.
 */
export function optionalMemberProfilePhotoUrl(
  enabled: boolean,
  memberId: string | null | undefined,
): string | null {
  if (!enabled || memberId === null || memberId === undefined) return null;
  try {
    return memberProfilePhotoUrl(memberId);
  } catch {
    return null;
  }
}
export function currentClassTeacherPhotoUrl(classId: string): string {
  if (!/^[1-9][0-9]{0,18}$/u.test(classId) || BigInt(classId) > 9223372036854775807n)
    throw new TypeError("올바르지 않은 반입니다.");
  return "/api/v1/profile-photos/current-class-teacher?class_id=" + classId;
}

/** Local bandwidth reduction only. The API independently validates, decodes and re-encodes. */
export async function prepareProfilePhoto(file: File): Promise<PreparedProfilePhoto> {
  if (!FORMATS.includes(file.type) || file.size === 0 || file.size > PROFILE_PHOTO_FILE_BYTES) {
    throw new Error("10MB 이하 JPG·PNG·WebP 사진을 선택해 주세요.");
  }
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    throw new Error("사진을 읽을 수 없습니다. 다른 JPG·PNG·WebP 사진을 선택해 주세요.");
  }
  try {
    if (bitmap.width < 1 || bitmap.height < 1 || bitmap.width * bitmap.height > SOURCE_PIXELS)
      throw new Error("사진 크기가 너무 큽니다. 1,600만 화소 이하로 줄인 사진을 선택해 주세요.");
    const scale = Math.min(1, 512 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (context === null) throw new Error("이 브라우저에서 사진을 처리할 수 없습니다.");
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (value) => (value ? resolve(value) : reject(new Error("사진을 처리하지 못했습니다."))),
        "image/webp",
        0.85,
      ),
    );
    if (!FORMATS.includes(blob.type) || blob.size === 0 || blob.size > UPLOAD_BYTES)
      throw new Error("사진 크기를 더 줄인 뒤 다시 선택해 주세요.");
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = "";
    for (let i = 0; i < bytes.length; i += 4096)
      binary += String.fromCharCode(...bytes.subarray(i, i + 4096));
    return { image_base64: btoa(binary) };
  } finally {
    bitmap.close();
  }
}

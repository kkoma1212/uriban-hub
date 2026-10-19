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
export interface ProfilePhotoActor {
  userId: string;
  sessionId: string;
  currentClassId: string | null;
}
export type ClassPhotoTarget = { memberId: string } | { teacher: true };

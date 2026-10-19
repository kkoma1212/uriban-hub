import { useState, type CSSProperties } from "react";

export interface AvatarProps {
  name: string;
  photoUrl?: string | null;
  size?: number;
  className?: string;
  /** Set false when no adjacent name identifies this person. */
  decorative?: boolean;
}

function safePhotoPath(value: string | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  return /^\/api\/v1\/profile-photos\/(?:me(?:\?v=[0-9a-f-]+)?|members\/[1-9][0-9]{0,18}|current-class-teacher\?class_id=[1-9][0-9]{0,18})$/u.test(
    value,
  )
    ? value
    : undefined;
}

/** Uses authenticated same-origin images only; unavailable/absent photos retain a readable initial. */
export function Avatar({ name, photoUrl, size = 40, className, decorative = true }: AvatarProps) {
  const [failedUrl, setFailedUrl] = useState<string | undefined>();
  const src = safePhotoPath(photoUrl);
  const showPhoto = src !== undefined && failedUrl !== src;
  const initial = Array.from(name.trim())[0] ?? "?";
  const style: CSSProperties = {
    alignItems: "center",
    background: "var(--color-app-surface-muted, #e8f0e9)",
    border: "1px solid var(--color-app-border, #cfdbd2)",
    borderRadius: "50%",
    color: "var(--color-app-text, #19382a)",
    display: "inline-flex",
    flexShrink: 0,
    fontSize: Math.round(size * 0.4),
    fontWeight: 700,
    height: size,
    justifyContent: "center",
    lineHeight: 1,
    overflow: "hidden",
    width: size,
  };
  return (
    <span
      className={className}
      style={style}
      aria-hidden={decorative ? true : undefined}
      role={decorative ? undefined : "img"}
      aria-label={decorative ? undefined : name.trim() + " 프로필 사진"}
    >
      {showPhoto ? (
        <img
          src={src}
          alt=""
          width={size}
          height={size}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setFailedUrl(src)}
          style={{ width: "100%", height: "100%", objectFit: "cover" }}
        />
      ) : (
        initial
      )}
    </span>
  );
}

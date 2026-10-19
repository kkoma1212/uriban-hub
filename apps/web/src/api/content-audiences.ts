export type ContentAudienceMode = "all_snapshot" | "legacy_class" | "selected_snapshot";

export type ContentAudienceRequest = { mode: "all" } | { member_ids: string[]; mode: "selected" };

export function isContentAudienceRequest(value: unknown): value is ContentAudienceRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const audience = value as { member_ids?: unknown; mode?: unknown };
  if (audience.mode === "all") return audience.member_ids === undefined;
  return (
    audience.mode === "selected" &&
    Array.isArray(audience.member_ids) &&
    audience.member_ids.length >= 1 &&
    audience.member_ids.length <= 60 &&
    audience.member_ids.every(
      (memberId) => typeof memberId === "string" && /^[1-9][0-9]*$/u.test(memberId),
    )
  );
}

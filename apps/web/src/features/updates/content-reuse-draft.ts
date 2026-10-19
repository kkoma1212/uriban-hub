import { isContentAudienceRequest } from "../../api/content-audiences";
import type { NoticeWriteRequest } from "../../api/notices";
import type { SupplyWriteRequest } from "../../api/supplies";

export type ReuseKind = "notice" | "homework";
export type ReuseWriteRequest = NoticeWriteRequest | SupplyWriteRequest;

export function isNoticeReuseRequest(value: unknown): value is NoticeWriteRequest {
  if (typeof value !== "object" || value === null) return false;
  const request = value as Partial<NoticeWriteRequest>;
  return (
    typeof request.title === "string" &&
    typeof request.content === "string" &&
    typeof request.is_important === "boolean" &&
    (request.category === "general" || request.category === "performance") &&
    (request.audience === undefined || isContentAudienceRequest(request.audience))
  );
}

export function isHomeworkReuseRequest(value: unknown): value is SupplyWriteRequest {
  if (typeof value !== "object" || value === null) return false;
  const request = value as Partial<SupplyWriteRequest>;
  return (
    typeof request.title === "string" &&
    typeof request.needed_on === "string" &&
    (request.description === null || typeof request.description === "string") &&
    request.category === "homework" &&
    (request.audience === undefined || isContentAudienceRequest(request.audience))
  );
}

/** Persist only writable fields, even if a stale or modified storage entry has extra data. */
export function readReuseDraft(storageKey: string, kind: ReuseKind): ReuseWriteRequest | undefined {
  try {
    const value: unknown = JSON.parse(window.sessionStorage.getItem(storageKey) ?? "null");
    if (kind === "notice" && isNoticeReuseRequest(value)) {
      return {
        ...(value.audience === undefined ? {} : { audience: value.audience }),
        category: value.category ?? "general",
        content: value.content,
        is_important: value.is_important,
        title: value.title,
      };
    }
    if (kind === "homework" && isHomeworkReuseRequest(value)) {
      return {
        ...(value.audience === undefined ? {} : { audience: value.audience }),
        category: "homework",
        description: value.description,
        needed_on: value.needed_on,
        title: value.title,
      };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

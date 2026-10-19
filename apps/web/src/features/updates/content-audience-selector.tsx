import { LoaderCircle, RefreshCw, UserRoundCheck, UsersRound } from "lucide-react";
import { useCallback, useEffect, useId, useState } from "react";

import { listMembers, type MemberListItem } from "../../api/auth";
import type { ContentAudienceRequest } from "../../api/content-audiences";

interface ContentAudienceSelectorProps {
  busy: boolean;
  enabled: boolean;
  errorId?: string;
  invalid?: boolean;
  locked?: boolean;
  onChange: (audience: ContentAudienceRequest) => void;
  value: ContentAudienceRequest | undefined;
}

function audienceMemberName(member: MemberListItem): string {
  return member.display_name_in_class ?? member.display_name;
}

function sortAudienceMembers(left: MemberListItem, right: MemberListItem): number {
  if (left.student_number !== right.student_number) {
    if (left.student_number === null) return 1;
    if (right.student_number === null) return -1;
    return left.student_number - right.student_number;
  }
  return audienceMemberName(left).localeCompare(audienceMemberName(right), "ko");
}

export function ContentAudienceSelector({
  busy,
  enabled,
  errorId,
  invalid = false,
  locked = false,
  onChange,
  value,
}: ContentAudienceSelectorProps): React.JSX.Element {
  const groupLabelId = useId();
  const allId = useId();
  const selectedId = useId();
  const [members, setMembers] = useState<MemberListItem[]>();
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    if (!enabled) return;
    setLoading(true);
    setLoadError(false);
    try {
      const result = await listMembers("approved");
      setMembers(
        result.members
          .filter((member) => member.status === "approved" && member.account_state === "active")
          .sort(sortAudienceMembers),
      );
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [enabled]);

  useEffect(() => {
    if (enabled) void load();
  }, [enabled, load]);

  const selectedMemberIds = value?.mode === "selected" ? value.member_ids : [];
  const disabled = busy || locked;

  function toggleMember(memberId: string, checked: boolean): void {
    const next = checked
      ? [...new Set([...selectedMemberIds, memberId])]
      : selectedMemberIds.filter((selectedMemberId) => selectedMemberId !== memberId);
    onChange({ member_ids: next, mode: "selected" });
  }

  return (
    <div aria-describedby={invalid ? errorId : undefined} aria-invalid={invalid || undefined}>
      <p className="flex items-center gap-2 font-extrabold text-role-primary" id={groupLabelId}>
        <UsersRound aria-hidden="true" size={18} />
        게시 대상
      </p>
      <div
        aria-labelledby={groupLabelId}
        className="mt-3 grid gap-2 sm:grid-cols-2"
        role="radiogroup"
      >
        <label
          className={`flex min-h-14 cursor-pointer items-start gap-3 rounded-2xl border px-4 py-3 ${
            value?.mode === "all"
              ? "border-role-primary bg-app-surface-raised"
              : "border-app-border bg-app-surface-muted"
          }`}
          htmlFor={allId}
        >
          <input
            checked={value?.mode === "all"}
            className="mt-1 size-4 accent-role-primary"
            disabled={disabled}
            id={allId}
            name={groupLabelId}
            onChange={() => onChange({ mode: "all" })}
            type="radio"
          />
          <span>
            <span className="block font-bold text-app-text">올릴 때의 반 전체 학생</span>
            <span className="mt-1 block text-xs leading-5 text-app-muted">
              지금 승인되어 활동 중인 학생을 게시 시점에 고정합니다.
            </span>
          </span>
        </label>

        <label
          className={`flex min-h-14 items-start gap-3 rounded-2xl border px-4 py-3 ${
            enabled ? "cursor-pointer" : "cursor-not-allowed opacity-65"
          } ${
            value?.mode === "selected"
              ? "border-role-primary bg-app-surface-raised"
              : "border-app-border bg-app-surface-muted"
          }`}
          htmlFor={selectedId}
        >
          <input
            checked={value?.mode === "selected"}
            className="mt-1 size-4 accent-role-primary"
            disabled={disabled || !enabled}
            id={selectedId}
            name={groupLabelId}
            onChange={() => onChange({ member_ids: [], mode: "selected" })}
            type="radio"
          />
          <span>
            <span className="block font-bold text-app-text">학생 직접 선택</span>
            <span className="mt-1 block text-xs leading-5 text-app-muted">
              {enabled
                ? "선택한 학생에게만 목록·오늘·확인 요청이 보입니다."
                : "아직 준비 중인 기능이에요."}
            </span>
          </span>
        </label>
      </div>

      {value?.mode !== "selected" ? null : (
        <div className="mt-3 rounded-2xl border border-app-border bg-app-surface-raised p-3">
          <div className="flex items-center justify-between gap-3 px-1">
            <p className="flex items-center gap-2 text-sm font-extrabold text-app-text">
              <UserRoundCheck aria-hidden="true" size={17} />
              학생 {selectedMemberIds.length}명 선택
            </p>
            {loadError ? (
              <button
                aria-label="학생 목록 다시 불러오기"
                className="ui-icon-button ui-button-secondary"
                disabled={loading}
                onClick={() => void load()}
                type="button"
              >
                <RefreshCw aria-hidden="true" className={loading ? "animate-spin" : ""} size={16} />
              </button>
            ) : null}
          </div>

          {loading && members === undefined ? (
            <p className="mt-3 flex items-center gap-2 rounded-xl bg-app-surface-muted px-3 py-3 text-sm font-semibold text-app-muted">
              <LoaderCircle aria-hidden="true" className="animate-spin" size={16} />
              학생 목록을 불러오고 있어요.
            </p>
          ) : loadError && members === undefined ? (
            <p className="mt-3 rounded-xl bg-rose-50 px-3 py-3 text-sm font-bold text-rose-700">
              학생 목록을 불러오지 못했습니다. 다시 시도해 주세요.
            </p>
          ) : members?.length === 0 ? (
            <p className="mt-3 rounded-xl bg-app-surface-muted px-3 py-3 text-sm font-semibold text-app-muted">
              선택할 수 있는 활동 중 학생이 없습니다.
            </p>
          ) : (
            <ul className="mt-3 grid max-h-72 gap-2 overflow-y-auto sm:grid-cols-2">
              {(members ?? []).map((member) => {
                const checked = selectedMemberIds.includes(member.id);
                const selectionLimitReached = !checked && selectedMemberIds.length >= 60;
                return (
                  <li key={member.id}>
                    <label
                      className={`flex min-h-12 cursor-pointer items-center gap-3 rounded-xl border px-3 py-2 ${
                        checked
                          ? "border-role-primary bg-role-soft"
                          : "border-app-border bg-app-surface"
                      }`}
                    >
                      <input
                        checked={checked}
                        className="size-4 accent-role-primary"
                        disabled={disabled || selectionLimitReached}
                        onChange={(event) => toggleMember(member.id, event.target.checked)}
                        type="checkbox"
                      />
                      <span className="min-w-0">
                        <span className="block break-words text-sm font-bold text-app-text">
                          {audienceMemberName(member)}
                        </span>
                        <span className="block text-xs text-app-muted">
                          {member.student_number === null
                            ? "번호 미지정"
                            : `${member.student_number}번`}
                        </span>
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

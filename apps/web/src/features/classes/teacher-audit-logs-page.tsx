import { AlertCircle, Clock3, History, LoaderCircle, RefreshCw, ShieldCheck } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";

import {
  DEFAULT_AUDIT_LOG_DAYS,
  getAuditLogs,
  parseAuditLogDays,
  type AuditLogDays,
  type AuditLogItem,
  type AuditSafeSnapshot,
  type AuditSafeValue,
} from "../../api/audit-logs";
import { ApiRequestError, getBootstrap } from "../../api/auth";
import { teacherOnlyAccessRedirect } from "../layout/access-redirect-notice";
import { AppShell, AppShellBar } from "../layout/app-shell";
import { PageHeader } from "../layout/page-header";

const ACTION_LABELS: Record<string, string> = {
  "attendance_notification.acknowledged": "출결 연락을 확인했어요",
  "attendance_notification.canceled": "출결 연락을 취소했어요",
  "attendance_notification.created": "출결 연락을 등록했어요",
  "attendance_notification.updated": "출결 연락을 수정했어요",
  "class.archived": "반 운영을 종료했어요",
  "class.created": "반을 만들었어요",
  "class.reactivated": "반 운영을 다시 시작했어요",
  "class.suspended": "반 운영을 일시 중지했어요",
  "class.teacher_transferred": "담임 선생님을 이관했어요",
  "class.updated": "반 정보를 수정했어요",
  "invite_code.created": "반 초대 코드를 발급했어요",
  "invite_code.revoked": "반 초대 코드를 폐기했어요",
  "member.account_deleted": "탈퇴 계정의 반 접근을 종료했어요",
  "member.approved": "반 참여 요청을 승인했어요",
  "member.left": "학생이 반을 나갔어요",
  "member.profile_updated": "학생 정보를 수정했어요",
  "member.rejected": "반 참여 요청을 거절했어요",
  "member.rejoin_allowed": "다시 참여를 허용했어요",
  "member.removed": "학생을 반에서 제외했어요",
  "member.request_canceled": "반 참여 요청을 취소했어요",
  "member.requested": "반 참여를 요청했어요",
  "notice.created": "공지를 등록했어요",
  "notice.deleted": "공지를 삭제했어요",
  "notice.reminder_created": "공지 다시 확인을 요청했어요",
  "notice.updated": "공지를 수정했어요",
  "poll.closed": "투표를 종료했어요",
  "poll.created": "투표를 만들었어요",
  "poll.deleted": "투표를 삭제했어요",
  "poll.updated": "투표를 수정했어요",
  "schedule.created": "일정을 등록했어요",
  "schedule.deleted": "일정을 삭제했어요",
  "schedule.updated": "일정을 수정했어요",
  // 서버 감사는 준비물·숙제를 한 종류(supply)로 남기고 구분을 기록하지 않는다(T-HUB-48).
  "supply.created": "준비물·숙제를 등록했어요",
  "supply.deleted": "준비물·숙제를 삭제했어요",
  "supply.reminder_created": "준비물·숙제 다시 확인을 요청했어요",
  "supply.updated": "준비물·숙제를 수정했어요",
  "seat_draw.adjusted": "자리표를 조정했어요",
  "seat_draw.created": "자리표 초안을 만들었어요",
  "seat_draw.deleted": "자리표를 삭제했어요",
  "seat_draw.published": "자리표를 공개했어요",
  "seat_draw.superseded": "이전 자리표로 전환했어요",
  "team_draw.adjusted": "모둠표를 조정했어요",
  "team_draw.created": "모둠표 초안을 만들었어요",
  "team_draw.deleted": "모둠표를 삭제했어요",
  "team_draw.published": "모둠표를 공개했어요",
  "team_draw.superseded": "이전 모둠표로 전환했어요",
  "duty_role.created": "당번 역할을 추가했어요",
  "duty_role.updated": "당번 역할을 수정했어요",
  "duty_role.archived": "당번 역할을 보관했어요",
  "duty_roster.created": "당번표 초안을 만들었어요",
  "duty_roster.published": "당번표를 공개했어요",
  "duty_roster.superseded": "이전 당번표로 전환했어요",
  "duty_roster.deleted": "당번표를 삭제했어요",
};

// Retained history remains readable; retired tools have no filter/menu entry.
const ACTION_OPTIONS = Object.keys(ACTION_LABELS).filter(
  (action) => !/^(seat_draw|team_draw|duty_role|duty_roster)\./u.test(action),
);

const REASON_LABELS: Record<string, string> = {
  "seat_draw.adjusted:teacher_move_assignment": "학생 한 명의 자리를 이동함",
  "seat_draw.adjusted:teacher_swap_assignments": "두 학생의 자리를 서로 바꿈",
  "team_draw.adjusted:teacher_swap_assignments": "두 학생의 모둠을 서로 바꿈",
};

const FIELD_LABELS: Record<string, string> = {
  academic_year: "학년도",
  archived_at: "운영 종료 시각",
  assigned_student_count: "배정 학생 수",
  closes_at: "마감 시각",
  column_count: "열 수",
  content_revision: "몇 번째 내용",
  cooldown_suppressed_count: "재요청 대기 중인 학생 수",
  created_count: "새로 요청한 학생 수",
  current_unresolved_count: "현재 미확인 학생 수",
  deleted_at: "삭제 시각",
  display_name_snapshot: "표시명",
  due_date: "마감일",
  expected_student_count: "예상 학생 수",
  excluded_student_count: "제외 학생 수",
  expires_at: "만료 시각",
  grade: "학년",
  group_count: "모둠 수",
  is_important: "중요 공지",
  name: "반 이름",
  needed_on: "준비 날짜",
  notification_date: "연락 날짜",
  notification_type: "출결 유형",
  option_count: "선택지 수",
  published_at: "게시 시각",
  reason: "사유",
  revoke_reason: "폐기 사유",
  revoked_at: "폐기 시각",
  role: "역할",
  schedule_type: "일정 유형",
  row_count: "행 수",
  status: "상태",
  subject: "과목",
  suspended_reason: "중지 사유",
  superseded_at: "이전 기록 전환 시각",
  title: "제목",
  usable_seat_count: "사용 가능 자리 수",
  vote_count: "참여 수",
};

const VALUE_LABELS: Record<string, string> = {
  absent: "결석",
  acknowledged: "확인 완료",
  active: "운영 중",
  approved: "승인",
  archived: "운영 종료",
  canceled: "취소",
  draft: "초안",
  early: "조퇴",
  exam: "시험",
  false: "아니요",
  late: "지각",
  operator: "관리자",
  other: "기타",
  pending: "대기",
  performance: "수행평가",
  published: "현재 공개",
  rejected: "거절",
  removed: "반에서 제외",
  schedule: "일정",
  student: "학생",
  suspended: "일시 중지",
  superseded: "이전 공개",
  teacher: "선생님",
  true: "예",
};

const TARGET_LABELS: Record<string, string> = {
  attendance_notification: "출결 연락",
  class: "반",
  invite_code: "반 초대 코드",
  member: "학생",
  notice: "공지",
  poll: "투표",
  schedule: "일정",
  seat_draw: "자리표",
  supply: "준비물·숙제",
  team_draw: "모둠표",
};

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "시간 정보 없음";
  return new Intl.DateTimeFormat("ko-KR", {
    dateStyle: "medium",
    timeStyle: "short",
    // 감사 기록 시각은 뷰어 기기 시간대가 아니라 KST 기준으로 고정한다.
    timeZone: "Asia/Seoul",
  }).format(date);
}

function formatValue(value: AuditSafeValue): string {
  if (value === null || value === "") return "없음";
  const raw = String(value);
  return VALUE_LABELS[raw] ?? raw;
}

function visibleKeys(snapshot: AuditSafeSnapshot | null): string[] {
  if (snapshot === null) return [];
  return Object.keys(snapshot).filter((key) => !key.endsWith("_id") && key !== "class_id");
}

export function auditActionLabel(action: string): string {
  return ACTION_LABELS[action] ?? "기타 활동";
}

export function auditReasonLabel(action: string, reason: string): string {
  return REASON_LABELS[`${action}:${reason}`] ?? reason;
}

export function auditChangeSummary(item: AuditLogItem): string[] {
  if (item.before !== null || item.after !== null) {
    const keys = [...new Set([...visibleKeys(item.before), ...visibleKeys(item.after)])];
    return keys.map((key) => {
      const label = FIELD_LABELS[key] ?? key;
      const before = item.before?.[key];
      const after = item.after?.[key];
      if (before !== undefined && after !== undefined) {
        return `${label}: ${formatValue(before)} → ${formatValue(after)}`;
      }
      if (after !== undefined) return `${label}: ${formatValue(after)}`;
      return `${label}: ${formatValue(before ?? null)} → 없음`;
    });
  }
  if (item.target.snapshot !== null) {
    return visibleKeys(item.target.snapshot).map((key) => {
      const label = FIELD_LABELS[key] ?? key;
      return `${label}: ${formatValue(item.target.snapshot?.[key] ?? null)}`;
    });
  }
  return [];
}

function targetLabel(item: AuditLogItem): string {
  const values = [item.target.snapshot, item.after, item.before];
  for (const snapshot of values) {
    const label = snapshot?.display_name_snapshot ?? snapshot?.title ?? snapshot?.name;
    if (typeof label === "string" && label.length > 0) return label;
  }
  return TARGET_LABELS[item.target.type] ?? "관련 기록";
}

function actorRoleLabel(role: AuditLogItem["actor"]["role"]): string {
  return VALUE_LABELS[role] ?? "사용자";
}

export function TeacherAuditLogsPage(): React.JSX.Element {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const actionParameter = searchParams.get("action");
  const action =
    actionParameter !== null && Object.hasOwn(ACTION_LABELS, actionParameter)
      ? actionParameter
      : null;
  const days = parseAuditLogDays(searchParams.get("days"));
  const [items, setItems] = useState<AuditLogItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState<string>();
  const [moreError, setMoreError] = useState<string>();
  const [announcement, setAnnouncement] = useState("");
  const [loadAttempt, setLoadAttempt] = useState(0);
  const moreInFlightRef = useRef(false);
  const moreErrorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setLoadError(undefined);
    setItems([]);
    setNextCursor(null);
    setMoreError(undefined);
    setAnnouncement("");
    void (async () => {
      try {
        const bootstrap = await getBootstrap();
        const accessRedirect = teacherOnlyAccessRedirect(bootstrap);
        if (accessRedirect !== null) {
          void navigate(accessRedirect.path, {
            replace: true,
            ...(accessRedirect.path === "/home" ? { state: accessRedirect.state } : {}),
          });
          return;
        }
        const page = await getAuditLogs({ action, days });
        if (!active) return;
        setItems(page.items);
        setNextCursor(page.next_cursor);
      } catch (error) {
        if (!active) return;
        if (error instanceof ApiRequestError && error.status === 401) {
          void navigate("/login", { replace: true });
          return;
        }
        if (
          error instanceof ApiRequestError &&
          (error.status === 403 || error.status === 404 || error.status === 423)
        ) {
          void navigate("/bootstrap", { replace: true });
          return;
        }
        setLoadError(error instanceof Error ? error.message : "감사 로그를 불러오지 못했습니다.");
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [action, days, loadAttempt, navigate]);

  useEffect(() => {
    if (moreError !== undefined) moreErrorRef.current?.focus();
  }, [moreError]);

  async function loadMore(): Promise<void> {
    if (nextCursor === null || moreInFlightRef.current) return;
    moreInFlightRef.current = true;
    setLoadingMore(true);
    setMoreError(undefined);
    setAnnouncement("");
    try {
      const page = await getAuditLogs({ action, cursor: nextCursor, days });
      setItems((current) => [...current, ...page.items]);
      setNextCursor(page.next_cursor);
      setAnnouncement(`${page.items.length}개의 이전 활동을 더 불러왔습니다.`);
    } catch (error) {
      setMoreError(
        error instanceof Error ? error.message : "이전 감사 로그 일부를 불러오지 못했습니다.",
      );
    } finally {
      moreInFlightRef.current = false;
      setLoadingMore(false);
    }
  }

  function updateFilters(nextAction: string | null, nextDays: AuditLogDays): void {
    const next = new URLSearchParams();
    if (nextAction !== null) next.set("action", nextAction);
    next.set("days", String(nextDays));
    setSearchParams(next);
  }

  return (
    <AppShell navigationRole="teacher" width="medium">
      <AppShellBar
        backLabel="반 관리로"
        backTo="/class/manage"
        brandTo="/home"
        context="반 관리 기록"
      />

      <PageHeader
        description="이 반에서 성공한 관리 활동을 최신순으로 확인할 수 있어요."
        eyebrow="반 관리"
        title="반 관리 기록"
      />
      <section
        aria-label="감사 로그 필터"
        className="mt-4 grid min-w-0 gap-3 rounded-shell border border-app-border bg-app-surface-raised p-4 shadow-card sm:grid-cols-2 sm:p-5"
      >
        <label className="min-w-0 text-sm font-bold text-app-text">
          활동 종류
          <select
            className="mt-2 min-h-11 w-full min-w-0 rounded-2xl border border-app-border bg-app-surface-raised px-3 text-base text-app-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-role-primary"
            onChange={(event) => updateFilters(event.target.value || null, days)}
            value={action ?? ""}
          >
            <option value="">모든 활동</option>
            {ACTION_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {ACTION_LABELS[option]}
              </option>
            ))}
          </select>
        </label>
        <label className="min-w-0 text-sm font-bold text-app-text">
          조회 기간
          <select
            className="mt-2 min-h-11 w-full min-w-0 rounded-2xl border border-app-border bg-app-surface-raised px-3 text-base text-app-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-role-primary"
            onChange={(event) => updateFilters(action, Number(event.target.value) as AuditLogDays)}
            value={days}
          >
            <option value={7}>최근 7일</option>
            <option value={30}>최근 30일</option>
            <option value={90}>최근 90일</option>
            <option value={180}>최근 180일</option>
            <option value={365}>최근 1년 (보관 기간 전체)</option>
          </select>
        </label>
      </section>

      <p aria-live="polite" className="sr-only" role="status">
        {announcement}
      </p>

      {loading ? (
        <div aria-live="polite" className="py-16 text-center" role="status">
          <LoaderCircle
            aria-hidden="true"
            className="mx-auto animate-spin text-role-primary"
            size={32}
          />
          <p className="mt-4 font-bold text-app-text">감사 로그를 불러오고 있어요.</p>
        </div>
      ) : loadError !== undefined ? (
        <section
          aria-labelledby="audit-log-load-error-title"
          className="mt-5 rounded-shell border border-rose-200 bg-app-surface-raised p-5 text-center shadow-card sm:p-6"
          role="alert"
        >
          <AlertCircle aria-hidden="true" className="mx-auto text-rose-500" size={32} />
          <h2 className="mt-4 font-black text-rose-800" id="audit-log-load-error-title">
            감사 로그를 불러오지 못했습니다
          </h2>
          <p className="mt-2 break-keep text-sm leading-6 text-app-muted">{loadError}</p>
          <button
            className="ui-button ui-button-primary mt-5 text-sm"
            onClick={() => setLoadAttempt((attempt) => attempt + 1)}
            type="button"
          >
            <RefreshCw aria-hidden="true" size={17} /> 다시 시도
          </button>
        </section>
      ) : items.length === 0 ? (
        <section className="mt-5 rounded-shell border border-app-border bg-app-surface-raised p-5 text-center shadow-card sm:p-6">
          <ShieldCheck aria-hidden="true" className="mx-auto text-role-primary" size={36} />
          <h2 className="mt-4 text-xl font-black text-app-text">
            {action !== null || days !== DEFAULT_AUDIT_LOG_DAYS
              ? "조건에 맞는 활동이 없어요"
              : "아직 기록된 활동이 없어요"}
          </h2>
          <p className="mt-2 break-keep text-sm leading-6 text-app-muted">
            {action !== null || days !== DEFAULT_AUDIT_LOG_DAYS
              ? "활동 종류나 조회 기간을 바꾸어 다시 확인해 주세요."
              : "반 정보 수정이나 학생 관리처럼 성공한 활동이 생기면 여기에 표시됩니다."}
          </p>
        </section>
      ) : (
        <section aria-labelledby="audit-log-list-title" className="mt-5">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-lg font-black text-app-text" id="audit-log-list-title">
              최근 활동
            </h2>
            <span className="text-sm font-bold text-app-muted">최신순</span>
          </div>
          <ol className="mt-3 space-y-3">
            {items.map((item, index) => {
              const summary = auditChangeSummary(item);
              const headingId = `audit-log-${index}-heading`;
              return (
                <li key={`${item.created_at}-${item.target.type}-${item.target.id}-${index}`}>
                  <article
                    aria-labelledby={headingId}
                    className="min-w-0 overflow-hidden rounded-shell border border-app-border bg-app-surface-raised p-4 shadow-card sm:p-5"
                  >
                    <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <div className="min-w-0">
                        <p className="break-words text-sm font-bold text-role-primary">
                          {targetLabel(item)}
                        </p>
                        <h3
                          className="mt-1 break-keep text-lg font-black text-app-text"
                          id={headingId}
                        >
                          {auditActionLabel(item.action)}
                        </h3>
                      </div>
                      <time
                        className="flex shrink-0 items-center gap-1.5 text-xs font-bold text-app-muted"
                        dateTime={item.created_at}
                      >
                        <Clock3 aria-hidden="true" size={14} /> {formatDateTime(item.created_at)}
                      </time>
                    </div>

                    {summary.length === 0 ? (
                      <p className="mt-4 break-keep rounded-2xl bg-app-surface-muted px-4 py-3 text-sm leading-6 text-app-muted">
                        변경 내용이 안전한 최소 정보로 기록되었습니다.
                      </p>
                    ) : (
                      <ul className="mt-4 space-y-2 rounded-2xl bg-app-surface-muted px-4 py-3 text-sm leading-6 text-app-text">
                        {summary.map((line) => (
                          <li className="break-words" key={line}>
                            {line}
                          </li>
                        ))}
                      </ul>
                    )}

                    <div className="mt-4 flex flex-col gap-2 border-t border-app-border pt-4 text-sm text-app-muted sm:flex-row sm:items-start sm:justify-between sm:gap-4">
                      <p className="break-words">
                        실행: <strong>{item.actor.display_name}</strong> ·{" "}
                        {actorRoleLabel(item.actor.role)}
                      </p>
                      {item.reason === null ? null : (
                        <p className="break-words sm:text-right">
                          사유: <strong>{auditReasonLabel(item.action, item.reason)}</strong>
                        </p>
                      )}
                    </div>
                  </article>
                </li>
              );
            })}
          </ol>

          {moreError === undefined ? null : (
            <div
              aria-label="이전 감사 로그 일부 불러오기 오류"
              className="mt-5 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900"
              ref={moreErrorRef}
              role="alert"
              tabIndex={-1}
            >
              <p className="font-black">이전 기록 일부를 불러오지 못했습니다.</p>
              <p className="mt-1 break-keep leading-6">{moreError}</p>
              <button
                className="ui-button ui-button-secondary mt-3 text-sm"
                onClick={() => void loadMore()}
                type="button"
              >
                <RefreshCw aria-hidden="true" size={16} /> 다시 시도
              </button>
            </div>
          )}

          {nextCursor === null ? (
            <p className="mt-6 text-center text-sm font-bold text-app-muted">
              모든 활동을 확인했습니다.
            </p>
          ) : (
            <button
              aria-busy={loadingMore}
              className="ui-button ui-button-secondary mt-6 w-full text-sm"
              disabled={loadingMore}
              onClick={() => void loadMore()}
              type="button"
            >
              {loadingMore ? (
                <LoaderCircle aria-hidden="true" className="animate-spin" size={17} />
              ) : (
                <History aria-hidden="true" size={17} />
              )}
              {loadingMore ? "이전 활동 불러오는 중" : "이전 활동 더 보기"}
            </button>
          )}
        </section>
      )}
    </AppShell>
  );
}

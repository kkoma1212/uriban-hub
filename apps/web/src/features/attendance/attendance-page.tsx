import {
  AlertCircle,
  CheckCircle2,
  Clock,
  Eye,
  House,
  LogOut,
  LoaderCircle,
  Pencil,
  RefreshCw,
  Send,
  Trash2,
  UserCheck,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";

import {
  acknowledgeAttendanceNotification,
  cancelAttendanceNotification,
  createAttendanceNotification,
  getAttendanceHistory,
  getTodayAttendance,
  updateAttendanceNotification,
  type AttendanceCounts,
  type AttendanceHistoryCounts,
  type AttendanceNotificationItem,
  type AttendanceNotificationType,
  type AttendanceStatusFilter,
  type AttendanceStudentHistory,
  type AttendanceStudentToday,
  type AttendanceTeacherItem,
  type AttendanceTypeFilter,
  type AttendanceWriteRequest,
} from "../../api/attendance-notifications";
import { ApiRequestError, getBootstrap, type BootstrapResponse } from "../../api/auth";
import { AUTHENTICATED_CLIENT_STATE_CLEARED_EVENT } from "../../lib/authenticated-client-state";
import { formatKstCalendarDate, formatKstTimeOfDay } from "../../lib/kst-format";
import {
  changedMutationResultMessage,
  clearIdempotentCreateAttempt,
  expiredMutationResultMessage,
  idempotentCreateStorageKey,
  type IdempotentCreateAttempt,
  isMutationOutcomeUnknown,
  persistIdempotentCreateAttempt,
  prepareIdempotentCreateAttempt,
  readIdempotentCreateAttempt,
  unavailableMutationStorageMessage,
  unknownMutationResultMessage,
} from "../../lib/idempotent-create";
import { AppShell } from "../layout/app-shell";
import { AttendanceHistoryDialog } from "./attendance-history-dialog";
import { ConfirmDialog } from "../layout/confirm-dialog";
import { useContentDesktop } from "../updates/content-list-view";
import {
  ContentFrameBody,
  ContentFrameHeader,
  ContentFilters,
  ContentSplit,
} from "../layout/content-frame";
import { ContentInputFrame } from "../layout/content-input-frame";
import "./attendance-page.css";

const TYPE_LABEL: Record<AttendanceNotificationType, string> = {
  absent: "결석",
  early: "조퇴",
  late: "지각",
};
const TYPE_ORDER: AttendanceNotificationType[] = ["late", "absent", "early"];
const UNKNOWN_CREATE_MESSAGE = unknownMutationResultMessage("출결 연락 전송 요청");

function useAttendanceRequestLifetime(context: string): () => () => boolean {
  const lifetime = useRef({ context, contextGeneration: 0, epoch: 0, mounted: false });
  if (lifetime.current.context !== context) {
    lifetime.current.context = context;
    lifetime.current.contextGeneration += 1;
  }
  const contextGeneration = lifetime.current.contextGeneration;
  useEffect(() => {
    lifetime.current.mounted = true;
    const invalidate = () => {
      lifetime.current.mounted = false;
      lifetime.current.epoch += 1;
    };
    window.addEventListener(AUTHENTICATED_CLIENT_STATE_CLEARED_EVENT, invalidate);
    return () => {
      lifetime.current.mounted = false;
      invalidate();
      window.removeEventListener(AUTHENTICATED_CLIENT_STATE_CLEARED_EVENT, invalidate);
    };
  }, []);
  return useCallback(() => {
    const epoch = lifetime.current.epoch;
    return () =>
      lifetime.current.mounted &&
      lifetime.current.epoch === epoch &&
      lifetime.current.contextGeneration === contextGeneration;
  }, [contextGeneration]);
}

interface AttendanceCreateAttemptRequest {
  body: AttendanceWriteRequest;
  serverToday: string;
}

const TYPE_HELP: Record<AttendanceNotificationType, string> = {
  absent: "오늘 학교에 가지 못할 예정이에요.",
  early: "수업 중 학교에서 먼저 나갈 예정이에요.",
  late: "등교 시각보다 늦게 도착할 예정이에요.",
};

const CONFLICT_CODES = new Set([
  "ATTENDANCE_NOTIFICATION_ALREADY_ACKNOWLEDGED",
  "ATTENDANCE_NOTIFICATION_DATE_CHANGED",
  "INVALID_SERVER_TODAY",
  "RESOURCE_VERSION_CHANGED",
  "SERVER_TODAY_REQUIRED",
]);

function addCalendarDays(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function expectedTimeLabel(
  item: Pick<AttendanceNotificationItem, "expected_time" | "notification_type">,
): string {
  if (item.notification_type === "absent") return "하루 종일";
  const expectedTime = item.expected_time;
  return expectedTime === null || expectedTime === "" ? "시각 미정" : `${expectedTime} 예정`;
}

function errorCopy(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function isAuthenticationError(error: unknown): boolean {
  return error instanceof ApiRequestError && error.status === 401;
}

function isConflictError(error: unknown): error is ApiRequestError {
  return error instanceof ApiRequestError && CONFLICT_CODES.has(error.code);
}

function isAttendanceCreateAttemptRequest(value: unknown): value is AttendanceCreateAttemptRequest {
  if (typeof value !== "object" || value === null) return false;
  const request = value as Partial<AttendanceCreateAttemptRequest>;
  const body = request.body;
  return (
    typeof request.serverToday === "string" &&
    typeof body === "object" &&
    body !== null &&
    (body.expected_time === null || typeof body.expected_time === "string") &&
    ["absent", "early", "late"].includes(body.notification_type ?? "")
  );
}

function conflictSuccessCopy(code: string): string {
  if (code === "ATTENDANCE_NOTIFICATION_DATE_CHANGED") {
    return "요청은 반영되지 않았습니다. 날짜가 바뀌어 최신 오늘 화면을 불러왔어요.";
  }
  if (code === "ATTENDANCE_NOTIFICATION_ALREADY_ACKNOWLEDGED") {
    return "요청은 반영되지 않았습니다. 선생님이 이미 읽은 최신 상태를 불러왔어요.";
  }
  return "요청은 반영되지 않았습니다. 다른 변경이 있어 최신 상태를 불러왔어요.";
}

function conflictFailureCopy(): string {
  return "요청은 반영되지 않았습니다. 최신 상태도 불러오지 못해 기존 입력과 화면을 그대로 두었어요. 네트워크를 확인한 뒤 새로고침해 주세요.";
}

function BoundaryNotice({
  className = "",
  compact = false,
}: {
  className?: string;
  compact?: boolean;
}): React.JSX.Element {
  // 선생님 화면은 목록·상세 칸이 높이를 쓰도록 같은 안내를 한 줄로 줄인다(문구는 같다).
  if (compact)
    return (
      <aside
        className={`${className} flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 rounded-2xl border border-home-meal-line bg-home-meal-soft px-4 py-2 text-sm`}
        data-attendance-surface="boundary"
      >
        <AlertCircle aria-hidden="true" className="shrink-0 text-home-meal" size={17} />
        <h2 className="break-keep font-extrabold text-home-meal">
          공식 출결이 아닌 사전 연락이에요
        </h2>
        <p className="break-keep text-app-text">
          선생님의 확인은 연락을 읽었다는 뜻이며 출결 확정이 아닙니다.
        </p>
        <details className="text-xs font-semibold leading-5 text-app-muted">
          <summary className="min-h-11 w-fit cursor-pointer py-1 text-home-meal">
            자세한 안내
          </summary>
          <p className="mt-1 break-keep">
            사유나 자세한 설명이 필요하면 학교가 안내한 별도 연락 채널을 이용해 주세요.
          </p>
        </details>
      </aside>
    );
  return (
    <aside
      className={`${className} rounded-2xl border border-home-meal-line bg-home-meal-soft p-4`}
      data-attendance-surface="boundary"
    >
      <div className="flex items-start gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-app-surface-raised text-home-meal shadow-sm">
          <AlertCircle aria-hidden="true" size={18} />
        </span>
        <div className="min-w-0">
          <h2 className="break-keep text-sm font-extrabold text-home-meal">
            공식 출결이 아닌 사전 연락이에요
          </h2>
          <p className="mt-1 break-keep text-sm leading-5 text-app-text">
            선생님의 확인은 연락을 읽었다는 뜻이며 출결 확정이 아닙니다.
          </p>
          <details className="mt-2 text-xs font-semibold leading-5 text-app-muted">
            <summary className="min-h-8 w-fit cursor-pointer py-1 text-home-meal">
              자세한 안내
            </summary>
            <p className="mt-1 break-keep">
              사유나 자세한 설명이 필요하면 학교가 안내한 별도 연락 채널을 이용해 주세요.
            </p>
          </details>
        </div>
      </div>
    </aside>
  );
}

function AttendanceIntro({
  bootstrap,
  children,
}: {
  bootstrap: BootstrapResponse;
  children?: React.ReactNode;
}): React.JSX.Element {
  const teacher = bootstrap.current_membership?.role === "teacher";
  return (
    <ContentFrameHeader
      data-attendance-header-role={teacher ? "teacher" : "student"}
      title="출결 연락"
    >
      {children}
    </ContentFrameHeader>
  );
}

function LoadingPanel({ label }: { label: string }): React.JSX.Element {
  return (
    <div
      aria-live="polite"
      className="mt-5 grid min-h-56 place-items-center rounded-card border border-app-border bg-app-surface text-role-primary"
      data-attendance-surface="loading"
      role="status"
    >
      <div className="text-center">
        <LoaderCircle aria-hidden="true" className="mx-auto animate-spin" size={30} />
        <p className="mt-3 text-sm font-bold text-app-muted">{label}</p>
      </div>
    </div>
  );
}

interface StudentFormProps {
  busy: boolean;
  editing: boolean;
  expectedTime: string;
  formError?: string | undefined;
  formRef: React.RefObject<HTMLFormElement | null>;
  locked: boolean;
  onCancelEdit: () => void;
  onExpectedTimeChange: (value: string) => void;
  onSubmit: () => void;
  onTypeChange: (value: AttendanceNotificationType) => void;
  type: AttendanceNotificationType;
}

function StudentForm({
  busy,
  editing,
  expectedTime,
  formError,
  formRef,
  locked,
  onCancelEdit,
  onExpectedTimeChange,
  onSubmit,
  onTypeChange,
  type,
}: StudentFormProps): React.JSX.Element {
  const needsTime = type !== "absent";
  const timeInputRef = useRef<HTMLInputElement>(null);
  const times =
    type === "early"
      ? ["13:00", "13:30", "14:00", "14:30", "15:00"]
      : ["09:00", "09:30", "10:00", "10:30", "11:00"];
  const missingTime = needsTime && expectedTime === "";
  return (
    <form
      ref={formRef}
      data-attendance-surface="student-form"
      data-input-form="attendance"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <ContentInputFrame
        actions={
          <div className={"grid w-full gap-2 " + (editing ? "grid-cols-2" : "grid-cols-1")}>
            {editing ? (
              <button
                className="ui-button ui-button-secondary min-h-[52px]"
                disabled={busy}
                onClick={onCancelEdit}
                type="button"
              >
                수정 취소
              </button>
            ) : null}
            <button
              aria-busy={busy}
              className="ui-button content-input-submit min-h-[52px] text-base"
              data-incomplete={!locked && missingTime}
              disabled={busy || (!locked && missingTime)}
              type="submit"
            >
              {busy ? (
                <LoaderCircle aria-hidden="true" className="animate-spin" size={18} />
              ) : (
                <Send aria-hidden="true" size={18} />
              )}
              {busy
                ? "반영 중"
                : locked
                  ? "결과 다시 확인"
                  : missingTime
                    ? "예정 시각을 입력해 주세요"
                    : editing
                      ? "수정 내용 저장"
                      : "연락 보내기"}
            </button>
          </div>
        }
        preview={
          <div className="grid gap-3">
            <p className="text-[15px] font-extrabold text-app-text">선생님께 이렇게 보여요</p>
            <section className="content-card p-5">
              <div className="flex items-center justify-between gap-3">
                <span className="rounded-lg bg-app-surface-muted px-2 py-1 text-xs font-bold text-app-muted">
                  출결 연락
                </span>
                <span className="text-xs font-bold text-role-primary">확인 대기</span>
              </div>
              <h3 className="mt-4 text-[21px] font-extrabold text-app-text">{TYPE_LABEL[type]}</h3>
              <p className="mt-2 text-base font-bold text-app-text">
                {needsTime
                  ? expectedTime
                    ? expectedTime + " 예정"
                    : "예정 시각을 입력해 주세요"
                  : "하루 종일"}
              </p>
              <p className="mt-3 text-sm leading-6 text-app-muted">{TYPE_HELP[type]}</p>
              <p className="mt-4 border-t border-app-border pt-3 text-sm text-app-muted">
                받는 사람 · 담임 선생님
              </p>
            </section>
          </div>
        }
      >
        <fieldset className="content-card shrink-0 p-3.5" disabled={busy || locked}>
          <legend className="sr-only">
            {editing ? "유형과 시각 바로 변경" : "출결 연락 보내기"}
          </legend>
          <p className="mb-2.5 text-sm font-bold text-app-muted">오늘 무엇을 알릴까요?</p>
          <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-label="출결 연락 종류">
            {(["late", "early", "absent"] as const).map((value) => {
              const Icon = value === "late" ? Clock : value === "early" ? LogOut : House;
              return (
                <label
                  className={
                    "flex min-h-[78px] min-w-0 cursor-pointer flex-col items-center justify-center gap-1 rounded-[14px] border-2 px-2 text-base font-extrabold focus-within:ring-2 focus-within:ring-role-primary " +
                    (type === value
                      ? "border-role-primary bg-role-soft text-role-primary"
                      : "border-transparent bg-app-surface-muted text-app-muted")
                  }
                  key={value}
                >
                  <input
                    checked={type === value}
                    className="sr-only"
                    name="attendance-type"
                    onChange={() => onTypeChange(value)}
                    type="radio"
                    value={value}
                  />
                  <Icon aria-hidden="true" size={24} />
                  {TYPE_LABEL[value]}
                </label>
              );
            })}
          </div>
          <p className="mt-2 text-xs leading-5 text-app-muted">{TYPE_HELP[type]}</p>
        </fieldset>
        <div className="content-input-support">
          {needsTime ? (
            <fieldset className="content-card p-3.5" disabled={busy || locked}>
              <legend className="sr-only">예정 시각</legend>
              <p className="mb-2.5 text-sm font-bold text-app-muted">
                {type === "late" ? "몇 시쯤 도착해요?" : "몇 시쯤 조퇴해요?"}
              </p>
              <div className="grid grid-cols-3 gap-2">
                {times.map((time) => (
                  <button
                    aria-pressed={expectedTime === time}
                    className={
                      "min-h-[46px] rounded-xl border-2 text-[15px] font-extrabold " +
                      (expectedTime === time
                        ? "border-role-primary bg-role-soft text-role-primary"
                        : "border-transparent bg-app-surface-muted text-app-text")
                    }
                    key={time}
                    onClick={() => onExpectedTimeChange(time)}
                    type="button"
                  >
                    {time}
                  </button>
                ))}
                <button
                  className="min-h-[46px] rounded-xl bg-app-surface-muted text-sm font-bold text-app-text"
                  onClick={() => {
                    timeInputRef.current?.focus();
                    try {
                      timeInputRef.current?.showPicker?.();
                    } catch {
                      /* 직접 입력도 그대로 사용할 수 있다. */
                    }
                  }}
                  type="button"
                >
                  직접 입력
                </button>
              </div>
              <label className="mt-3 flex min-w-0 items-center gap-3 text-[13px] font-bold text-app-muted">
                <span className="shrink-0">
                  {type === "late" ? "도착 예정 시각" : "조퇴 예정 시각"}
                </span>
                <input
                  aria-describedby={formError === undefined ? undefined : "attendance-form-error"}
                  className="ui-input ui-input-compact min-w-0 flex-1"
                  onChange={(event) => onExpectedTimeChange(event.target.value)}
                  ref={timeInputRef}
                  required
                  step="60"
                  type="time"
                  value={expectedTime}
                />
              </label>
            </fieldset>
          ) : (
            <section className="content-card p-3.5">
              <p className="text-sm font-bold text-role-primary">하루 종일</p>
              <p className="mt-1 text-xs leading-5 text-app-muted">
                결석은 예정 시각 없이 하루 일정으로 전송됩니다.
              </p>
            </section>
          )}
          <aside className="mt-2 rounded-2xl bg-role-soft p-3.5 text-sm leading-6 text-role-primary">
            <p className="flex items-start gap-2">
              <Send aria-hidden="true" className="mt-1 shrink-0" size={18} />
              <span>담임 선생님께 바로 가요.</span>
            </p>
            <p className="mt-1 flex items-start gap-2">
              <Eye aria-hidden="true" className="mt-1 shrink-0" size={18} />
              <span>
                선생님이 읽으면 <strong className="whitespace-nowrap">'선생님이 봤어요'</strong>로
                바뀌어요.
              </span>
            </p>
            <details className="mt-2 border-t border-role-border pt-1 text-xs leading-5">
              <summary className="min-h-8 cursor-pointer py-1 font-bold">
                공식 출결이 아닌 사전 연락이에요
              </summary>
              <p>선생님의 확인은 연락을 읽었다는 뜻이며 출결 확정이 아닙니다.</p>
              <p className="mt-1">
                사유나 자세한 설명이 필요하면 학교가 안내한 별도 연락 채널을 이용해 주세요.
              </p>
            </details>
          </aside>
          {formError === undefined ? null : (
            <p
              className="mt-2 rounded-xl bg-danger-surface px-3 py-2 text-sm font-bold text-danger"
              id="attendance-form-error"
              role="alert"
            >
              {formError}
            </p>
          )}
        </div>
      </ContentInputFrame>
    </form>
  );
}

interface StudentStatusCardProps {
  busy: boolean;
  item: AttendanceNotificationItem;
  onCancel: (button: HTMLButtonElement) => void;
  onEdit: () => void;
}

function StudentStatusCard({
  busy,
  item,
  onCancel,
  onEdit,
}: StudentStatusCardProps): React.JSX.Element {
  const acknowledged = item.status === "acknowledged";
  return (
    <section
      className="rounded-card border border-role-border bg-app-surface p-5 shadow-sm sm:p-7"
      aria-label="내 오늘 출결 연락"
      data-attendance-surface="student-status"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm font-bold text-role-primary">내 오늘 연락</p>
          <h2 className="mt-1 text-2xl font-extrabold text-app-text">
            {TYPE_LABEL[item.notification_type]} · {expectedTimeLabel(item)}
          </h2>
        </div>
        <span
          className={`inline-flex min-h-8 items-center rounded-full px-3 text-xs font-extrabold ${
            acknowledged
              ? "bg-home-supplies-soft text-home-supplies"
              : "bg-app-danger/10 text-app-danger"
          }`}
        >
          {acknowledged ? "선생님이 봤어요" : "확인 대기"}
        </span>
      </div>
      <p className="mt-4 break-keep rounded-2xl bg-app-surface-muted px-4 py-3 text-sm leading-6 text-app-muted">
        {acknowledged
          ? `선생님이 ${formatKstTimeOfDay(item.acknowledged_at) ?? "오늘"} 연락을 읽었어요. 공식 출결 확정은 아니며, 읽은 뒤에는 수정하거나 취소할 수 없습니다.`
          : "아직 선생님이 읽기 전이에요. 지금은 내용을 수정하거나 연락을 취소할 수 있습니다."}
      </p>
      {acknowledged ? null : (
        <div className="mt-5 grid grid-cols-2 gap-3">
          <button
            className="ui-button ui-button-primary"
            disabled={busy}
            onClick={onEdit}
            type="button"
          >
            <Pencil aria-hidden="true" size={17} /> 유형·시각 수정
          </button>
          <button
            className="ui-button ui-button-danger"
            disabled={busy}
            onClick={(event) => onCancel(event.currentTarget)}
            type="button"
          >
            <Trash2 aria-hidden="true" size={17} /> 연락 취소
          </button>
        </div>
      )}
    </section>
  );
}

const STUDENT_HISTORY_COUNTS: Array<{
  key: keyof AttendanceHistoryCounts;
  label: string;
}> = [
  { key: "total", label: "전체" },
  { key: "late", label: "지각" },
  { key: "absent", label: "결석" },
  { key: "early", label: "조퇴" },
];

function StudentHistorySummary({
  error,
  history,
  loading,
  onOpenType,
  onRetry,
}: {
  error: boolean;
  history: AttendanceStudentHistory | undefined;
  loading: boolean;
  onOpenType: (type: AttendanceNotificationType) => void;
  onRetry: () => void;
}): React.JSX.Element {
  return (
    <section
      aria-labelledby="student-attendance-history-title"
      className="mt-5 rounded-card border border-app-border bg-app-surface p-5 shadow-sm sm:p-6"
      data-attendance-surface="student-history"
    >
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-bold text-role-primary">최근 1년</p>
          <h2
            className="mt-1 text-lg font-extrabold text-app-text"
            id="student-attendance-history-title"
          >
            내가 알린 출결
          </h2>
          <p className="mt-1 break-keep text-sm leading-5 text-app-muted">
            공식 출석부가 아니라 내가 담임 선생님께 보낸 연락만 모아 보여줘요.
          </p>
        </div>
        {history === undefined ? null : (
          <p className="rounded-full bg-app-surface-muted px-3 py-1.5 text-xs font-bold text-app-muted">
            {history.range.from} ~ {history.range.to}
          </p>
        )}
      </div>

      {loading && history === undefined ? (
        <p
          className="mt-4 flex min-h-16 items-center justify-center gap-2 rounded-2xl bg-app-surface-muted text-sm font-bold text-role-primary"
          role="status"
        >
          <LoaderCircle aria-hidden="true" className="animate-spin" size={17} />
          출결 기록을 불러오고 있어요.
        </p>
      ) : error && history === undefined ? (
        <div
          className="mt-4 flex min-w-0 flex-wrap items-center justify-between gap-3 rounded-2xl border border-danger bg-danger-surface px-4 py-3"
          role="status"
        >
          <p className="text-sm font-bold text-danger">출결 기록을 불러오지 못했어요.</p>
          <button className="ui-button ui-button-secondary text-sm" onClick={onRetry} type="button">
            <RefreshCw aria-hidden="true" size={16} />
            다시 시도
          </button>
        </div>
      ) : history === undefined ? null : (
        <dl className="mt-4 grid grid-cols-4 gap-2">
          {STUDENT_HISTORY_COUNTS.map((item) => {
            const count = history.counts[item.key];
            const body = (
              <>
                <dt className="text-xs font-bold text-app-muted">{item.label}</dt>
                <dd className="text-sm font-bold text-app-muted">
                  {count}
                  <span className="ml-0.5 text-xs font-bold text-app-muted">회</span>
                </dd>
              </>
            );
            /*
             * "전체"는 세 유형이 섞여 있어 날짜만 늘어놓으면 무엇이 무엇인지 모른다.
             * 유형별로만 열 수 있게 두고, 없는 날은 열어도 소용없으니 잠근다.
             */
            if (item.key === "total" || count === 0) {
              return (
                <div
                  className="min-w-0 rounded-2xl border border-app-border bg-app-surface-raised px-2 py-3 text-center"
                  key={item.key}
                >
                  {body}
                </div>
              );
            }
            return (
              <button
                aria-label={`${item.label} ${count}회 날짜 보기`}
                className="min-w-0 rounded-2xl border border-app-border bg-app-surface-raised px-2 py-3 text-center transition hover:border-role-border hover:bg-app-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-role-primary focus-visible:ring-offset-2"
                key={item.key}
                onClick={() => onOpenType(item.key as AttendanceNotificationType)}
                type="button"
              >
                {body}
              </button>
            );
          })}
        </dl>
      )}
    </section>
  );
}

function StudentAttendance({
  bootstrap,
  membershipId,
}: {
  bootstrap: BootstrapResponse;
  membershipId: string;
}): React.JSX.Element {
  const navigate = useNavigate();
  const captureRequest = useAttendanceRequestLifetime(membershipId);
  const createAttemptStorageKey = idempotentCreateStorageKey("attendance", membershipId);
  const createAttemptRef = useRef<
    IdempotentCreateAttempt<AttendanceCreateAttemptRequest> | undefined
  >(undefined);
  const createAttemptLoadedRef = useRef(false);
  if (!createAttemptLoadedRef.current) {
    createAttemptRef.current = readIdempotentCreateAttempt(
      createAttemptStorageKey,
      isAttendanceCreateAttemptRequest,
    );
    createAttemptLoadedRef.current = true;
  }
  const initialCreateAttempt = createAttemptRef.current;
  const [today, setToday] = useState<AttendanceStudentToday>();
  const [history, setHistory] = useState<AttendanceStudentHistory>();
  const [historyDialogType, setHistoryDialogType] = useState<AttendanceNotificationType>();
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState(false);
  const [etag, setEtag] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [type, setType] = useState<AttendanceNotificationType>(
    initialCreateAttempt?.request.body.notification_type ?? "late",
  );
  const [expectedTime, setExpectedTime] = useState(
    initialCreateAttempt?.request.body.expected_time ?? "",
  );
  const [error, setError] = useState<string | undefined>(
    initialCreateAttempt === undefined ? undefined : UNKNOWN_CREATE_MESSAGE,
  );
  const [notice, setNotice] = useState<string>();
  const [formError, setFormError] = useState<string>();
  const [createOutcomeUnknown, setCreateOutcomeUnknown] = useState(
    initialCreateAttempt !== undefined,
  );
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReturnFocus, setCancelReturnFocus] = useState<HTMLElement | null>(null);
  const studentFormRef = useRef<HTMLFormElement>(null);
  const dateFocusRef = useRef<HTMLParagraphElement>(null);
  const focusFormAfterCancelRef = useRef(false);
  useEffect(() => {
    if (!focusFormAfterCancelRef.current || busy || today?.notification !== null) return;
    const selectedType = studentFormRef.current?.querySelector<HTMLInputElement>(
      'input[name="attendance-type"]:checked',
    );
    if (selectedType == null || selectedType.disabled) return;
    focusFormAfterCancelRef.current = false;
    selectedType.focus();
  }, [busy, today?.notification]);
  const generationRef = useRef(0);
  const historyGenerationRef = useRef(0);
  const editingRef = useRef(editing);
  const busyRef = useRef(busy);
  editingRef.current = editing;
  busyRef.current = busy;

  const loadHistory = useCallback(
    async (serverToday: string): Promise<void> => {
      const isCurrent = captureRequest();
      if (!isCurrent()) return;
      const generation = ++historyGenerationRef.current;
      setHistoryLoading(true);
      setHistoryError(false);
      try {
        const result = await getAttendanceHistory(addCalendarDays(serverToday, -365), serverToday);
        if (!isCurrent() || generation !== historyGenerationRef.current) return;
        setHistory(result);
      } catch (requestError) {
        if (!isCurrent() || generation !== historyGenerationRef.current) return;
        if (isAuthenticationError(requestError)) {
          void navigate("/login", { replace: true });
          return;
        }
        setHistoryError(true);
      } finally {
        if (isCurrent() && generation === historyGenerationRef.current) setHistoryLoading(false);
      }
    },
    [captureRequest, navigate],
  );

  const load = useCallback(
    async (
      options: { failureMessage?: string; preserveDraft?: boolean } = {},
    ): Promise<boolean> => {
      const isCurrent = captureRequest();
      if (!isCurrent()) return false;
      const generation = ++generationRef.current;
      setLoading(true);
      setError(undefined);
      try {
        const result = await getTodayAttendance();
        if (!isCurrent() || generation !== generationRef.current) return false;
        if (result.data.role !== "student") {
          throw new Error("출결 정보를 확인하지 못했어요. 새로고침해 주세요.");
        }
        setToday(result.data);
        setEtag(result.etag);
        const pendingCreate = createAttemptRef.current;
        if (pendingCreate !== undefined) {
          if (result.data.notification !== null) {
            clearIdempotentCreateAttempt(createAttemptStorageKey, pendingCreate.idempotencyKey);
            createAttemptRef.current = undefined;
            setCreateOutcomeUnknown(false);
            setError(undefined);
            setNotice("이전에 보낸 출결 연락이 오늘 화면에서 확인되었습니다.");
          } else if (pendingCreate.request.serverToday !== result.data.server_today) {
            clearIdempotentCreateAttempt(createAttemptStorageKey, pendingCreate.idempotencyKey);
            createAttemptRef.current = undefined;
            setType(pendingCreate.request.body.notification_type);
            setExpectedTime(pendingCreate.request.body.expected_time ?? "");
            setCreateOutcomeUnknown(false);
            setError(undefined);
            setNotice(
              "기준 날짜가 바뀌어 이전 날짜 요청은 다시 보내지 않았습니다. 내용을 확인한 뒤 오늘 연락을 새로 보낼 수 있어요.",
            );
          } else {
            setType(pendingCreate.request.body.notification_type);
            setExpectedTime(pendingCreate.request.body.expected_time ?? "");
            setCreateOutcomeUnknown(true);
            setError(UNKNOWN_CREATE_MESSAGE);
          }
        }
        if (result.data.notification?.status === "acknowledged") setEditing(false);
        if (!options.preserveDraft && !editingRef.current && result.data.notification !== null) {
          setType(result.data.notification.notification_type);
          setExpectedTime(result.data.notification.expected_time ?? "");
        }
        return true;
      } catch (requestError) {
        if (!isCurrent() || generation !== generationRef.current) return false;
        if (isAuthenticationError(requestError)) {
          void navigate("/login", { replace: true });
          return false;
        }
        setError(
          options.failureMessage ??
            errorCopy(requestError, "오늘 출결 연락을 불러오지 못했습니다."),
        );
        return false;
      } finally {
        if (isCurrent() && generation === generationRef.current) setLoading(false);
      }
    },
    [captureRequest, createAttemptStorageKey, navigate],
  );

  useEffect(() => {
    void load();
    const onVisibility = (): void => {
      if (document.visibilityState === "visible" && !busyRef.current) {
        void load({ preserveDraft: true });
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      generationRef.current += 1;
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [load]);

  useEffect(() => {
    if (today === undefined) return;
    void loadHistory(today.server_today);
    return () => {
      historyGenerationRef.current += 1;
    };
  }, [loadHistory, today?.server_today]);

  async function reconcile(errorCode: string): Promise<void> {
    const refreshed = await load({ failureMessage: conflictFailureCopy(), preserveDraft: true });
    if (refreshed) setNotice(conflictSuccessCopy(errorCode));
  }

  async function submit(): Promise<void> {
    const isCurrent = captureRequest();
    if (!isCurrent() || busyRef.current) return;
    if (type !== "absent" && expectedTime === "") {
      setFormError("예정 시각을 입력해 주세요.");
      return;
    }
    if (today === undefined) return;
    const request: AttendanceWriteRequest = {
      expected_time: type === "absent" ? null : expectedTime,
      notification_type: type,
    };
    const current = today.notification;
    if (current !== null && (!editing || etag === null)) return;

    let createAttempt: IdempotentCreateAttempt<AttendanceCreateAttemptRequest> | undefined;
    if (current === null) {
      const preparation = prepareIdempotentCreateAttempt(
        createAttemptStorageKey,
        { body: request, serverToday: today.server_today },
        createAttemptRef.current,
      );
      if (preparation.kind === "mismatch") {
        setError(changedMutationResultMessage());
        return;
      }
      if (preparation.kind === "expired") {
        setError(expiredMutationResultMessage("출결 연락 전송 요청"));
        return;
      }
      if (preparation.kind === "storage-unavailable") {
        setError(unavailableMutationStorageMessage());
        return;
      }
      createAttempt = preparation.attempt;
      createAttemptRef.current = createAttempt;
    }

    busyRef.current = true;
    generationRef.current += 1;
    setLoading(false);
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    setFormError(undefined);
    try {
      const result =
        current === null
          ? await createAttendanceNotification(
              request,
              today.server_today,
              createAttempt!.idempotencyKey,
            )
          : await updateAttendanceNotification(current.id, request, today.server_today, etag!);
      if (!isCurrent()) return;
      if (result.item.status !== "pending")
        throw new Error("연락 상태를 확인하지 못했어요. 새로고침해 주세요.");
      const notification: AttendanceNotificationItem = {
        ...result.item,
        status: result.item.status,
      };
      setToday({ ...today, notification });
      setEtag(result.etag);
      setEditing(false);
      void loadHistory(today.server_today);
      if (current === null) {
        clearIdempotentCreateAttempt(createAttemptStorageKey, createAttempt!.idempotencyKey);
        createAttemptRef.current = undefined;
        setCreateOutcomeUnknown(false);
      }
      setNotice(current === null ? "오늘 출결 연락을 보냈어요." : "출결 연락을 수정했어요.");
    } catch (requestError) {
      if (!isCurrent()) return;
      if (current === null && isMutationOutcomeUnknown(requestError)) {
        setCreateOutcomeUnknown(true);
        setError(
          persistIdempotentCreateAttempt(createAttemptStorageKey, createAttempt!)
            ? UNKNOWN_CREATE_MESSAGE
            : `${UNKNOWN_CREATE_MESSAGE} 이 화면을 닫거나 새로고침하지 마세요. 닫으면 저장됐는지 다시 확인할 수 없어요.`,
        );
      } else {
        if (current === null) {
          clearIdempotentCreateAttempt(createAttemptStorageKey, createAttempt!.idempotencyKey);
          createAttemptRef.current = undefined;
          setCreateOutcomeUnknown(false);
        }
        if (isAuthenticationError(requestError)) {
          void navigate("/login", { replace: true });
        } else if (isConflictError(requestError)) {
          await reconcile(requestError.code);
        } else {
          setError(
            errorCopy(
              requestError,
              current === null
                ? "출결 연락을 보내지 못했습니다."
                : "출결 연락을 수정하지 못했습니다.",
            ),
          );
        }
      }
    } finally {
      if (!isCurrent()) return;
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function cancel(): Promise<void> {
    const isCurrent = captureRequest();
    if (!isCurrent() || busyRef.current) return;
    const currentToday = today;
    const current = currentToday?.notification;
    if (currentToday === undefined || current === undefined || current === null || etag === null)
      return;
    busyRef.current = true;
    generationRef.current += 1;
    setLoading(false);
    setCancelOpen(false);
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const result = await cancelAttendanceNotification(
        current.id,
        currentToday.server_today,
        etag,
      );
      if (!isCurrent()) return;
      if (result.item.status !== "canceled")
        throw new Error("연락 상태를 확인하지 못했어요. 새로고침해 주세요.");
      focusFormAfterCancelRef.current = true;
      setToday({ ...currentToday, notification: null });
      setEtag(null);
      setEditing(false);
      void loadHistory(currentToday.server_today);
      setNotice("오늘 출결 연락을 취소했어요. 필요하면 다시 보낼 수 있습니다.");
    } catch (requestError) {
      if (!isCurrent()) return;
      if (isAuthenticationError(requestError)) {
        void navigate("/login", { replace: true });
      } else if (isConflictError(requestError)) {
        await reconcile(requestError.code);
      } else {
        setError(errorCopy(requestError, "출결 연락을 취소하지 못했습니다."));
      }
    } finally {
      if (!isCurrent()) return;
      busyRef.current = false;
      setBusy(false);
    }
  }

  if (today === undefined && loading)
    return (
      <>
        <AttendanceIntro bootstrap={bootstrap} />
        <ContentFrameBody>
          <LoadingPanel label="내 오늘 출결 연락을 불러오고 있어요." />
        </ContentFrameBody>
      </>
    );
  if (today === undefined) {
    return (
      <>
        <AttendanceIntro bootstrap={bootstrap} />
        <ContentFrameBody>
          <div
            className="mt-5 rounded-card border border-danger bg-danger-surface p-6 text-center"
            data-attendance-surface="student-error"
            role="alert"
          >
            <p className="font-bold text-danger">{error}</p>
            <button
              className="ui-button ui-button-primary mt-5"
              onClick={() => void load()}
              type="button"
            >
              <RefreshCw aria-hidden="true" size={17} /> 다시 시도
            </button>
          </div>
        </ContentFrameBody>
      </>
    );
  }

  const current = today.notification;
  return (
    <>
      {/* 기준 날짜·새로고침은 제목 영역 둘째 줄(다른 탭의 필터 줄 자리)에 둔다 — 비어 있던 줄 활용. */}
      <AttendanceIntro bootstrap={bootstrap}>
        <section
          className="mt-2 flex min-w-0 items-center justify-between gap-3"
          data-attendance-surface="student-date"
        >
          <p className="text-sm font-bold text-app-muted" ref={dateFocusRef} tabIndex={-1}>
            기준 날짜 ·{" "}
            <time dateTime={today.server_today}>{formatKstCalendarDate(today.server_today)}</time>
          </p>
          <button
            aria-busy={loading}
            aria-label="새로고침"
            className="ui-icon-button ui-button-secondary"
            disabled={loading || busy}
            onClick={() => void load({ preserveDraft: true })}
            type="button"
          >
            <RefreshCw aria-hidden="true" className={loading ? "animate-spin" : ""} size={17} />
          </button>
        </section>
      </AttendanceIntro>
      <ContentFrameBody>
        {error === undefined ? null : (
          <div
            className="mt-4 rounded-2xl border border-danger bg-danger-surface px-4 py-3 text-sm font-bold text-danger"
            role="alert"
          >
            <p>{error}</p>
          </div>
        )}
        {notice === undefined ? null : (
          <p
            className="mt-4 flex items-center gap-2 rounded-2xl border border-home-supplies-line bg-home-supplies-soft px-4 py-3 text-sm font-bold text-home-supplies"
            role="status"
          >
            <CheckCircle2 aria-hidden="true" size={18} />
            {notice}
          </p>
        )}

        {current === null || editing ? (
          <>
            {current === null ? (
              <p className="mb-3 text-sm text-app-muted" data-attendance-surface="student-empty">
                오늘 보낸 출결 연락이 없어요.
              </p>
            ) : null}
            <StudentForm
              busy={busy}
              editing={editing}
              expectedTime={expectedTime}
              formError={formError}
              formRef={studentFormRef}
              locked={current === null && createOutcomeUnknown}
              onCancelEdit={() => {
                setEditing(false);
                setFormError(undefined);
              }}
              onExpectedTimeChange={(value) => {
                setExpectedTime(value);
                setFormError(undefined);
              }}
              onSubmit={() => void submit()}
              onTypeChange={(value) => {
                setType(value);
                setFormError(undefined);
              }}
              type={type}
            />
            <details className="mt-4 rounded-2xl border border-app-border bg-app-surface px-4">
              <summary className="min-h-11 cursor-pointer py-3 text-sm font-bold text-app-muted">
                최근 출결 연락 보기
              </summary>
              <StudentHistorySummary
                error={historyError}
                history={history}
                loading={historyLoading}
                onOpenType={setHistoryDialogType}
                onRetry={() => void loadHistory(today.server_today)}
              />
            </details>
          </>
        ) : (
          <>
            <div
              className="mt-5 grid min-w-0 items-start gap-6 xl:grid-cols-[minmax(0,1fr)_440px]"
              data-attendance-surface="student-boundary-layout"
            >
              <StudentStatusCard
                busy={busy}
                item={current}
                onCancel={(button) => {
                  setCancelReturnFocus(button);
                  setCancelOpen(true);
                }}
                onEdit={() => {
                  setType(current.notification_type);
                  setExpectedTime(current.expected_time ?? "");
                  setEditing(true);
                  setFormError(undefined);
                  setError(undefined);
                }}
              />
              <BoundaryNotice />
            </div>
            <StudentHistorySummary
              error={historyError}
              history={history}
              loading={historyLoading}
              onOpenType={setHistoryDialogType}
              onRetry={() => void loadHistory(today.server_today)}
            />
          </>
        )}
        <AttendanceHistoryDialog
          items={history?.items ?? []}
          onClose={() => setHistoryDialogType(undefined)}
          open={historyDialogType !== undefined}
          type={historyDialogType}
        />
        <ConfirmDialog
          confirmLabel="연락 취소"
          fallbackFocusTo={dateFocusRef.current}
          description="선생님이 아직 읽지 않은 오늘 연락을 취소합니다. 취소 뒤에는 오늘 연락이 없는 상태로 바뀌며, 필요하면 다시 보낼 수 있어요."
          onCancel={() => setCancelOpen(false)}
          onConfirm={() => void cancel()}
          open={cancelOpen}
          returnFocusTo={cancelReturnFocus}
          title="오늘 출결 연락을 취소할까요?"
        />
      </ContentFrameBody>
    </>
  );
}

function typeFromSearch(search: URLSearchParams): AttendanceTypeFilter {
  const value = search.get("type");
  return value === "late" || value === "absent" || value === "early" ? value : "all";
}

function statusFromSearch(search: URLSearchParams): AttendanceStatusFilter {
  const value = search.get("status");
  return value === "pending" || value === "acknowledged" ? value : "all";
}

function teacherKey(
  type: AttendanceTypeFilter,
  status: AttendanceStatusFilter,
  cursor?: string,
): string {
  return `${type}|${status}|${cursor ?? ""}`;
}

interface TeacherView {
  baseItems: AttendanceTeacherItem[];
  counts: AttendanceCounts;
  items: AttendanceTeacherItem[];
  nextCursor: string | null;
  serverToday: string;
}

function deduplicate(items: AttendanceTeacherItem[]): AttendanceTeacherItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

const COUNT_ITEMS: Array<{ key: keyof AttendanceCounts; label: string }> = [
  { key: "total", label: "전체" },
  { key: "late", label: "지각" },
  { key: "absent", label: "결석" },
  { key: "early", label: "조퇴" },
  { key: "pending", label: "확인 대기" },
  { key: "acknowledged", label: "확인 완료" },
];

function membershipBadge(item: AttendanceTeacherItem): string[] {
  const badges: string[] = [];
  if (item.membership_state === "left") badges.push("반에서 나감");
  if (item.membership_state === "removed") badges.push("반에서 제외");
  if (item.membership_state === "account_deleted") badges.push("현재 반 소속 아님");
  return badges;
}

function TeacherItemCard({
  busy,
  disabled,
  item,
  onAcknowledge,
}: {
  busy: boolean;
  disabled: boolean;
  item: AttendanceTeacherItem;
  onAcknowledge: (item: AttendanceTeacherItem, button: HTMLButtonElement) => void;
}): React.JSX.Element {
  const badges = membershipBadge(item);
  return (
    <article
      className="content-card flex min-w-0 flex-col p-3 sm:p-5"
      aria-label={`${item.display_name} 출결 연락`}
      data-attendance-surface="teacher-item"
    >
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-2 sm:gap-3">
        <div className="min-w-0 flex-1 sm:flex-none">
          <div className="flex min-w-0 items-baseline gap-2 sm:block">
            <p className="shrink-0 text-xs font-bold text-app-muted">
              {item.student_number === null ? "번호 없음" : `${item.student_number}번`}
            </p>
            <h3 className="min-w-0 break-words text-base font-extrabold text-app-text sm:mt-1 sm:text-lg">
              {item.display_name}
            </h3>
          </div>
          {badges.length === 0 ? null : (
            <div className="mt-1 flex flex-wrap gap-1.5 sm:mt-2" aria-label="현재 반 소속 상태">
              {badges.map((badge) => (
                <span
                  className="rounded-full bg-app-surface-muted px-2.5 py-1 text-xs font-extrabold text-app-muted"
                  key={badge}
                >
                  {badge}
                </span>
              ))}
            </div>
          )}
        </div>
        <span
          className={`inline-flex min-h-8 items-center rounded-full px-3 text-xs font-extrabold ${
            item.status === "pending"
              ? "bg-app-danger/10 text-app-danger"
              : "bg-home-supplies-soft text-home-supplies"
          }`}
        >
          {item.status === "pending" ? "확인 대기" : "확인 완료"}
        </span>
      </div>
      <div className="mt-2 flex min-w-0 items-center gap-2 sm:mt-4 sm:gap-3 sm:rounded-2xl sm:bg-app-surface-muted sm:px-4 sm:py-3">
        <Clock aria-hidden="true" className="shrink-0 text-role-primary" size={19} />
        <p className="min-w-0 break-words text-sm font-extrabold text-app-text">
          {TYPE_LABEL[item.notification_type]} · {expectedTimeLabel(item)}
        </p>
      </div>
      {item.status === "pending" ? (
        <button
          aria-busy={busy}
          className="ui-button ui-button-primary mt-3 min-h-11 w-full sm:mt-4"
          disabled={disabled}
          onClick={(event) => onAcknowledge(item, event.currentTarget)}
          type="button"
        >
          {busy ? (
            <LoaderCircle aria-hidden="true" className="animate-spin" size={18} />
          ) : (
            <UserCheck aria-hidden="true" size={18} />
          )}
          {busy ? "처리 중" : "읽음으로 확인"}
        </button>
      ) : (
        <p className="mt-2 text-xs font-bold text-app-muted sm:mt-4">
          {formatKstTimeOfDay(item.acknowledged_at) ?? "오늘"} 읽음 처리
        </p>
      )}
    </article>
  );
}

function TeacherAttendance({ bootstrap }: { bootstrap: BootstrapResponse }): React.JSX.Element {
  const captureMembership = useAttendanceRequestLifetime(`${bootstrap.current_membership?.id}`);
  const desktop = useContentDesktop();
  const [selectedId, setSelectedId] = useState<string>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const type = typeFromSearch(searchParams);
  const status = statusFromSearch(searchParams);
  const cursor = searchParams.get("cursor") || undefined;
  const key = teacherKey(type, status, cursor);
  const captureRequest = useAttendanceRequestLifetime(`${bootstrap.current_membership?.id}:${key}`);
  const [current, setCurrent] = useState<{ key: string; view: TeacherView }>();
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [acknowledgingId, setAcknowledgingId] = useState<string>();
  const [confirmItem, setConfirmItem] = useState<AttendanceTeacherItem>();
  const [confirmReturnFocus, setConfirmReturnFocus] = useState<HTMLElement | null>(null);
  const listHeadingRef = useRef<HTMLHeadingElement>(null);
  const cacheRef = useRef(new Map<string, TeacherView>());
  const pendingBaseRef = useRef(new Map<string, AttendanceTeacherItem[]>());
  const currentRef = useRef(current);
  const generationRef = useRef(0);
  const acknowledgingRef = useRef(acknowledgingId);
  currentRef.current = current;
  acknowledgingRef.current = acknowledgingId;
  const activeView = current?.key === key ? current.view : undefined;

  const loadPage = useCallback(
    async (
      query: {
        cursor: string | undefined;
        status: AttendanceStatusFilter;
        type: AttendanceTypeFilter;
      },
      baseItems: AttendanceTeacherItem[],
      options: { failureMessage?: string; more?: boolean } = {},
    ): Promise<boolean> => {
      const targetKey = teacherKey(query.type, query.status, query.cursor);
      const isCurrent = captureRequest();
      if (!isCurrent()) return false;
      const generation = ++generationRef.current;
      if (options.more) setLoadingMore(true);
      else setLoading(true);
      setError(undefined);
      try {
        const result = await getTodayAttendance(query.type, query.status, query.cursor);
        if (!isCurrent() || generation !== generationRef.current) return false;
        if (result.data.role !== "teacher") throw new Error("출결 현황을 확인할 수 없습니다.");
        const view: TeacherView = {
          baseItems,
          counts: result.data.counts,
          items: deduplicate([...baseItems, ...result.data.items]),
          nextCursor: result.data.next_cursor,
          serverToday: result.data.server_today,
        };
        cacheRef.current.set(targetKey, view);
        setCurrent({ key: targetKey, view });
        return true;
      } catch (requestError) {
        if (!isCurrent() || generation !== generationRef.current) return false;
        if (isAuthenticationError(requestError)) {
          void navigate("/login", { replace: true });
          return false;
        }
        setError(
          options.failureMessage ??
            (cacheRef.current.has(targetKey) || currentRef.current !== undefined
              ? `기존 목록은 그대로 두었습니다. ${errorCopy(requestError, "새 출결 현황을 불러오지 못했습니다.")}`
              : errorCopy(requestError, "오늘 출결 현황을 불러오지 못했습니다.")),
        );
        return false;
      } finally {
        if (isCurrent() && generation === generationRef.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [captureRequest, navigate],
  );

  useEffect(() => {
    const cached = cacheRef.current.get(key);
    if (cached !== undefined) {
      generationRef.current += 1;
      setLoadingMore(false);
      setCurrent({ key, view: cached });
      setLoading(false);
      setError(undefined);
      return;
    }
    const base = pendingBaseRef.current.get(key) ?? [];
    pendingBaseRef.current.delete(key);
    void loadPage({ cursor, status, type }, base, { more: base.length > 0 });
  }, [cursor, key, loadPage, status, type]);

  useEffect(
    () => () => {
      generationRef.current += 1;
    },
    [],
  );

  useEffect(() => {
    const onVisibility = (): void => {
      if (document.visibilityState !== "visible") return;
      if (acknowledgingRef.current !== undefined) return;
      const latest = cacheRef.current.get(key) ?? currentRef.current?.view;
      void loadPage({ cursor, status, type }, latest?.baseItems ?? []);
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [cursor, key, loadPage, status, type]);

  function changeFilters(nextType: AttendanceTypeFilter, nextStatus: AttendanceStatusFilter): void {
    const next = new URLSearchParams();
    if (nextType !== "all") next.set("type", nextType);
    if (nextStatus !== "all") next.set("status", nextStatus);
    const nextKey = teacherKey(nextType, nextStatus);
    if (!cacheRef.current.has(nextKey)) setLoading(true);
    setError(undefined);
    setNotice(undefined);
    setSearchParams(next);
  }

  async function reconcile(errorCode: string): Promise<void> {
    if (activeView === undefined) return;
    const resetCursor =
      errorCode === "ATTENDANCE_NOTIFICATION_DATE_CHANGED" ||
      errorCode === "INVALID_SERVER_TODAY" ||
      errorCode === "SERVER_TODAY_REQUIRED";
    const targetCursor = resetCursor ? undefined : cursor;
    const base = resetCursor ? [] : activeView.baseItems;
    const targetKey = teacherKey(type, status, targetCursor);
    const isCurrent = captureRequest();
    if (!isCurrent()) return;
    const generation = ++generationRef.current;
    try {
      const result = await getTodayAttendance(type, status, targetCursor);
      if (!isCurrent() || generation !== generationRef.current) return;
      if (result.data.role !== "teacher") throw new Error("출결 현황을 확인할 수 없습니다.");
      const view: TeacherView = {
        baseItems: base,
        counts: result.data.counts,
        items: deduplicate([...base, ...result.data.items]),
        nextCursor: result.data.next_cursor,
        serverToday: result.data.server_today,
      };
      cacheRef.current.clear();
      cacheRef.current.set(targetKey, view);
      setCurrent({ key: targetKey, view });
      if (resetCursor && cursor !== undefined) {
        const next = new URLSearchParams(searchParams);
        next.delete("cursor");
        setSearchParams(next, { replace: true });
      }
      setNotice(conflictSuccessCopy(errorCode));
    } catch (requestError) {
      if (!isCurrent() || generation !== generationRef.current) return;
      if (isAuthenticationError(requestError)) void navigate("/login", { replace: true });
      else setError(conflictFailureCopy());
    }
  }

  async function acknowledge(): Promise<void> {
    const isCurrent = captureRequest();
    const isSameMembership = captureMembership();
    if (!isCurrent()) return;
    const item = confirmItem;
    if (item === undefined || activeView === undefined || acknowledgingRef.current !== undefined)
      return;
    acknowledgingRef.current = item.id;
    cacheRef.current.clear();
    generationRef.current += 1;
    setLoading(false);
    setLoadingMore(false);
    setConfirmItem(undefined);
    setAcknowledgingId(item.id);
    setError(undefined);
    setNotice(undefined);
    try {
      const result = await acknowledgeAttendanceNotification(
        item.id,
        activeView.serverToday,
        `"${item.row_version}"`,
      );
      if (!isCurrent()) return;
      if (result.item.status !== "acknowledged")
        throw new Error("연락 상태를 확인하지 못했어요. 새로고침해 주세요.");
      const updateItems = (items: AttendanceTeacherItem[]): AttendanceTeacherItem[] =>
        status === "pending"
          ? items.filter((candidate) => candidate.id !== item.id)
          : items.map((candidate) =>
              candidate.id === item.id
                ? { ...candidate, ...result.item, status: "acknowledged" as const }
                : candidate,
            );
      const updatedItems = updateItems(activeView.items);
      const view: TeacherView = {
        ...activeView,
        baseItems: updateItems(activeView.baseItems),
        counts: {
          ...activeView.counts,
          acknowledged: activeView.counts.acknowledged + 1,
          pending: Math.max(0, activeView.counts.pending - 1),
        },
        items: updatedItems,
      };
      cacheRef.current.clear();
      cacheRef.current.set(key, view);
      setCurrent({ key, view });
      setNotice(`${item.display_name} 학생의 연락을 읽음으로 확인했어요.`);
    } catch (requestError) {
      if (!isCurrent()) return;
      if (isAuthenticationError(requestError)) {
        void navigate("/login", { replace: true });
      } else if (isConflictError(requestError)) {
        await reconcile(requestError.code);
      } else {
        setError(errorCopy(requestError, "읽음으로 확인하지 못했습니다."));
      }
    } finally {
      if (!isSameMembership()) return;
      acknowledgingRef.current = undefined;
      setAcknowledgingId(undefined);
    }
  }

  if (activeView === undefined && (loading || error === undefined))
    return (
      <>
        <AttendanceIntro bootstrap={bootstrap} />
        <ContentFrameBody>
          <BoundaryNotice compact />
          <LoadingPanel label="오늘 접수된 출결 연락을 불러오고 있어요." />
        </ContentFrameBody>
      </>
    );
  if (activeView === undefined) {
    return (
      <>
        <AttendanceIntro bootstrap={bootstrap} />
        <ContentFrameBody>
          <BoundaryNotice compact />
          <div
            className="mt-5 rounded-card border border-danger bg-danger-surface p-6 text-center"
            data-attendance-surface="teacher-error"
            role="alert"
          >
            <p className="font-bold text-danger">{error}</p>
            <button
              className="ui-button ui-button-primary mt-5"
              onClick={() => void loadPage({ cursor, status, type }, [])}
              type="button"
            >
              <RefreshCw aria-hidden="true" size={17} /> 다시 시도
            </button>
          </div>
        </ContentFrameBody>
      </>
    );
  }

  return (
    <>
      {/* 날짜·개수·새로고침은 제목 영역 둘째 줄(다른 탭의 필터 줄 자리)에 둔다 — 비어 있던 줄 활용. */}
      <AttendanceIntro bootstrap={bootstrap}>
        <section className="mt-2 min-w-0" data-attendance-surface="teacher-summary">
          {/* 휴대폰은 날짜·새로고침을 첫 줄, 전체 집계를3×2칸으로 보여 준다. 본문 시작선보다 집계 접근성을 우선한다. */}
          <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 md:flex md:gap-3">
            <div className="shrink-0">
              <p className="sr-only">기준 날짜</p>
              <h2 className="text-base font-extrabold text-app-text md:text-xl">
                <time dateTime={activeView.serverToday}>
                  {formatKstCalendarDate(activeView.serverToday)}
                </time>
              </h2>
            </div>
            {/* 태블릿·PC는 기존 한 줄과 수평 스크롤을 유지한다. */}
            <dl className="grid min-w-0 grid-cols-3 gap-1.5 max-md:order-3 max-md:col-span-2 md:flex md:flex-1 md:gap-2 md:overflow-x-auto">
              {COUNT_ITEMS.map(({ key: countKey, label }) => (
                <div
                  className="flex min-w-0 flex-wrap items-center justify-center gap-x-1 gap-y-0.5 rounded-xl bg-app-surface px-2 py-1.5 text-center md:flex-nowrap md:shrink-0 md:justify-start md:gap-1 xl:gap-2 xl:px-3 xl:py-2"
                  key={countKey}
                >
                  <dt className="break-keep text-xs font-bold text-app-muted">{label}</dt>
                  <dd className="min-w-0 break-all text-sm font-extrabold leading-5 text-app-text [overflow-wrap:anywhere] md:break-normal md:leading-normal md:[overflow-wrap:normal] xl:text-base">
                    {activeView.counts[countKey]}
                  </dd>
                </div>
              ))}
            </dl>
            <button
              aria-busy={loading}
              aria-label="새로고침"
              className="ui-button ui-button-secondary ml-auto shrink-0 text-sm max-md:px-3 max-md:min-h-11"
              disabled={loading || loadingMore || acknowledgingId !== undefined}
              onClick={() => void loadPage({ cursor, status, type }, activeView.baseItems)}
              type="button"
            >
              <RefreshCw aria-hidden="true" className={loading ? "animate-spin" : ""} size={17} />
              <span className="hidden md:inline">새로고침</span>
            </button>
          </div>
        </section>
      </AttendanceIntro>
      <ContentFrameBody>
        <BoundaryNotice compact />

        {error === undefined ? null : (
          <p
            className="mt-4 rounded-2xl border border-danger bg-danger-surface px-4 py-3 text-sm font-bold text-danger"
            role="alert"
          >
            {error}
            <button
              className="ml-2 min-h-11 rounded-xl px-3 underline underline-offset-2"
              onClick={() => void loadPage({ cursor, status, type }, activeView.baseItems)}
              type="button"
            >
              다시 시도
            </button>
          </p>
        )}
        {notice === undefined ? null : (
          <p
            className="mt-4 flex items-center gap-2 rounded-2xl border border-home-supplies-line bg-home-supplies-soft px-4 py-3 text-sm font-bold text-home-supplies"
            role="status"
          >
            <CheckCircle2 aria-hidden="true" size={18} />
            {notice}
          </p>
        )}

        <section
          className="content-split-host mt-4 min-w-0"
          aria-labelledby="attendance-list-heading"
          data-attendance-surface="teacher-list"
        >
          <h2
            className="sr-only focus:not-sr-only focus:mb-3 focus:text-sm focus:font-bold"
            id="attendance-list-heading"
            ref={listHeadingRef}
            tabIndex={-1}
          >
            학생별 접수 현황
          </h2>
          {/* 종류·상태 거르개를 한 줄에(좁으면 줄바꿈) — 소식의 분류 줄처럼 한 줄만 쓴다. */}
          <div className="flex min-w-0 flex-wrap items-center gap-x-4 [&>.content-filter-strip]:mt-0">
            <ContentFilters label="출결 연락 종류">
              {(["all", ...TYPE_ORDER] as const).map((value) => (
                <button
                  aria-pressed={type === value}
                  className="content-filter"
                  disabled={acknowledgingId !== undefined || loadingMore}
                  key={value}
                  onClick={() => changeFilters(value, status)}
                  type="button"
                >
                  {value === "all" ? "전체 종류" : TYPE_LABEL[value]}
                </button>
              ))}
            </ContentFilters>
            <ContentFilters label="출결 연락 확인 상태">
              {(["all", "pending", "acknowledged"] as const).map((value) => (
                <button
                  aria-pressed={status === value}
                  className="content-filter"
                  disabled={acknowledgingId !== undefined || loadingMore}
                  key={value}
                  onClick={() => changeFilters(type, value)}
                  type="button"
                >
                  {value === "all" ? "전체 상태" : value === "pending" ? "확인 대기" : "확인 완료"}
                </button>
              ))}
            </ContentFilters>
          </div>
          {loading && !loadingMore ? (
            <p
              className="mt-5 flex items-center gap-2 text-sm font-bold text-app-muted"
              role="status"
            >
              <LoaderCircle aria-hidden="true" className="animate-spin" size={18} />
              목록을 새로고치는 중입니다.
            </p>
          ) : null}
          {activeView.items.length === 0 ? (
            <div
              className="mt-6 rounded-card border border-role-border bg-role-soft px-5 py-10 text-center"
              data-attendance-surface="teacher-empty"
            >
              <UserCheck aria-hidden="true" className="mx-auto text-role-primary" size={32} />
              <p className="mt-3 font-extrabold text-app-text">
                {activeView.counts.total === 0
                  ? "오늘 접수된 출결 연락이 없어요."
                  : status === "pending" && type === "all"
                    ? "확인 대기인 출결 연락이 없어요."
                    : "선택한 조건의 출결 연락이 없어요."}
              </p>
              <p className="mt-2 break-keep text-sm leading-6 text-app-muted">
                {activeView.counts.total === 0
                  ? "학생이 연락을 보내면 여기에 보여요."
                  : "종류나 확인 상태를 바꾸면 다른 연락을 볼 수 있어요."}
              </p>
            </div>
          ) : (
            <ContentSplit
              className="mt-3"
              asideLabel="선택한 출결 연락"
              aside={
                !desktop ? undefined : (
                  <TeacherItemCard
                    item={
                      activeView.items.find((item) => item.id === selectedId) ??
                      activeView.items[0]!
                    }
                    busy={
                      acknowledgingId ===
                      (
                        activeView.items.find((item) => item.id === selectedId) ??
                        activeView.items[0]!
                      ).id
                    }
                    disabled={acknowledgingId !== undefined}
                    onAcknowledge={(candidate, button) => {
                      setConfirmItem(candidate);
                      setConfirmReturnFocus(button);
                    }}
                  />
                )
              }
            >
              <h3 className="mb-2 text-[13px] font-bold text-app-muted xl:hidden">
                오늘 <span className="ml-1">{activeView.items.length}</span>
              </h3>
              <ul className="grid min-w-0 content-start gap-2">
                {activeView.items.map((item) => (
                  <li className="min-w-0" key={item.id}>
                    {desktop ? (
                      <button
                        aria-pressed={
                          (
                            activeView.items.find((candidate) => candidate.id === selectedId) ??
                            activeView.items[0]
                          )?.id === item.id
                        }
                        className={
                          "content-card block w-full p-4 text-left " +
                          ((
                            activeView.items.find((candidate) => candidate.id === selectedId) ??
                            activeView.items[0]
                          )?.id === item.id
                            ? "ring-2 ring-role-primary"
                            : "")
                        }
                        onClick={() => setSelectedId(item.id)}
                        type="button"
                      >
                        <span className="text-xs font-bold text-app-muted">
                          {item.student_number === null ? "번호 없음" : item.student_number + "번"}{" "}
                          · {TYPE_LABEL[item.notification_type]}
                        </span>
                        <span className="mt-2 block text-[17px] font-extrabold text-app-text">
                          {item.display_name}
                        </span>
                        <span className="mt-2 block text-sm text-app-muted">
                          {expectedTimeLabel(item)}
                        </span>
                        <span className="mt-3 block border-t border-app-border pt-3 text-sm font-bold text-role-primary">
                          {item.status === "pending" ? "확인 대기" : "확인 완료"} ›
                        </span>
                      </button>
                    ) : (
                      <TeacherItemCard
                        busy={acknowledgingId === item.id}
                        item={item}
                        disabled={acknowledgingId !== undefined}
                        onAcknowledge={(candidate, button) => {
                          setConfirmItem(candidate);
                          setConfirmReturnFocus(button);
                        }}
                      />
                    )}
                  </li>
                ))}
              </ul>
            </ContentSplit>
          )}
          {activeView.nextCursor === null ? null : (
            <button
              aria-busy={loadingMore}
              className="ui-button ui-button-secondary mt-6 w-full"
              disabled={loading || loadingMore || acknowledgingId !== undefined}
              onClick={() => {
                const nextKey = teacherKey(type, status, activeView.nextCursor ?? undefined);
                pendingBaseRef.current.set(nextKey, activeView.items);
                const next = new URLSearchParams(searchParams);
                setCurrent({ key: nextKey, view: activeView });
                setLoadingMore(true);
                next.set("cursor", activeView.nextCursor!);
                setSearchParams(next);
              }}
              type="button"
            >
              {loadingMore ? (
                <LoaderCircle aria-hidden="true" className="animate-spin" size={18} />
              ) : null}
              {loadingMore ? "불러오는 중" : "다음 20명 더 보기"}
            </button>
          )}
        </section>
        <ConfirmDialog
          confirmLabel="읽음으로 확인"
          fallbackFocusTo={listHeadingRef.current}
          description="이 처리는 공식 출결을 확정하는 것이 아니라 연락을 읽었다는 표시입니다. 한 번 확인하면 되돌릴 수 없습니다."
          onCancel={() => setConfirmItem(undefined)}
          onConfirm={() => void acknowledge()}
          open={confirmItem !== undefined}
          returnFocusTo={confirmReturnFocus}
          title={`${confirmItem?.display_name ?? "학생"} 학생 연락을 확인할까요?`}
        />
      </ContentFrameBody>
    </>
  );
}

export function AttendancePage(): React.JSX.Element {
  const navigate = useNavigate();
  const captureRequest = useAttendanceRequestLifetime("bootstrap");
  const bootstrapGeneration = useRef(0);
  const [bootstrap, setBootstrap] = useState<BootstrapResponse>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  const loadBootstrap = useCallback(async (): Promise<void> => {
    const isCurrent = captureRequest();
    if (!isCurrent()) return;
    const generation = ++bootstrapGeneration.current;
    const current = () => isCurrent() && generation === bootstrapGeneration.current;
    let redirecting = false;
    setLoading(true);
    setError(undefined);
    try {
      const result = await getBootstrap();
      if (!current()) return;
      if (
        result.destination !== "HOME" ||
        result.current_membership === null ||
        !result.allowed_actions.includes("VIEW_CLASS")
      ) {
        redirecting = true;
        void navigate("/bootstrap", { replace: true });
        return;
      }
      const attendanceAllowed =
        result.allowed_actions.includes("MANAGE_ATTENDANCE_NOTIFICATIONS") ||
        result.allowed_actions.includes("MANAGE_OWN_ATTENDANCE_NOTIFICATION");
      if (!attendanceAllowed) {
        redirecting = true;
        void navigate("/home", { replace: true });
        return;
      }
      setBootstrap(result);
    } catch (requestError) {
      if (!current()) return;
      if (isAuthenticationError(requestError)) {
        redirecting = true;
        void navigate("/login", { replace: true });
      } else setError(errorCopy(requestError, "출결 연락 화면을 준비하지 못했습니다."));
    } finally {
      if (current() && !redirecting) setLoading(false);
    }
  }, [captureRequest, navigate]);

  useEffect(() => {
    void loadBootstrap();
  }, [loadBootstrap]);

  if (bootstrap === undefined) {
    return (
      <AppShell alignedFrame contentFrame width="wide">
        <ContentFrameHeader title="출결 연락" />
        <ContentFrameBody>
          <div
            aria-live={loading ? "polite" : "assertive"}
            className="text-center"
            role={loading ? "status" : "alert"}
          >
            {loading ? (
              <LoaderCircle
                aria-hidden="true"
                className="mx-auto animate-spin text-role-primary"
                size={32}
              />
            ) : (
              <AlertCircle aria-hidden="true" className="mx-auto text-danger" size={32} />
            )}
            <p className="mt-4 font-bold">
              {loading ? "출결 연락 화면을 준비하고 있어요." : error}
            </p>
            {loading ? null : (
              <button
                className="ui-button ui-button-primary mt-5"
                onClick={() => void loadBootstrap()}
                type="button"
              >
                <RefreshCw aria-hidden="true" size={17} /> 다시 시도
              </button>
            )}
          </div>
        </ContentFrameBody>
      </AppShell>
    );
  }

  const teacher = bootstrap.current_membership?.role === "teacher";
  return (
    <AppShell
      alignedFrame
      contentFrame
      navigationRole={teacher ? "teacher" : "student"}
      width="wide"
    >
      {teacher ? (
        // 교사도 날짜·개수 줄을 제목 영역 둘째 줄에 두므로 제목·본문을 함께 그린다.
        <TeacherAttendance bootstrap={bootstrap} />
      ) : bootstrap.current_membership === null ? (
        <>
          <AttendanceIntro bootstrap={bootstrap} />
          <ContentFrameBody />
        </>
      ) : (
        // 학생은 기준 날짜 줄을 제목 영역 둘째 줄에 두므로 제목·본문을 함께 그린다.
        <StudentAttendance bootstrap={bootstrap} membershipId={bootstrap.current_membership.id} />
      )}
    </AppShell>
  );
}

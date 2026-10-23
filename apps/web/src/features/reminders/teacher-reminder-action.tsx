import { BellRing, CheckCircle2, LoaderCircle, RotateCcw } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";

import { ApiRequestError } from "../../api/auth";
import {
  reminderContentRevision,
  type InAppReminderCreateResponse,
} from "../../api/in-app-reminders";
import { formatKstDateTime } from "../../lib/kst-format";
import {
  changedMutationResultMessage,
  clearIdempotentCreateAttempt,
  expiredMutationResultMessage,
  idempotentCreateStorageKey,
  isMutationOutcomeUnknown,
  persistIdempotentCreateAttempt,
  prepareIdempotentCreateAttempt,
  readIdempotentCreateAttempt,
  unavailableMutationStorageMessage,
  unknownMutationResultMessage,
  type IdempotentCreateAttempt,
} from "../../lib/idempotent-create";
import { ConfirmDialog } from "../layout/confirm-dialog";

interface ReminderRequest {
  content_revision: number;
}

interface TeacherReminderActionProps {
  compact?: boolean;
  contentRevision: string;
  lastRequestedAt: string | null;
  membershipId: string;
  onCreate: (
    contentRevision: string,
    idempotencyKey: string,
  ) => Promise<InAppReminderCreateResponse>;
  onRegistered: (result: InAppReminderCreateResponse, contentRevision: string) => void;
  resourceId: string;
  resourceLabel: "공지" | "준비물" | "숙제";
  resourceType: "notice" | "supply";
  statusVerified?: boolean;
  title: string;
  unresolvedCount: number;
}

interface RegisteredReminderResult {
  contentRevision: string;
  response: InAppReminderCreateResponse;
}

const UNKNOWN_RESULT_MESSAGE = unknownMutationResultMessage("앱 내 재알림 등록 요청");

function isReminderRequest(value: unknown): value is ReminderRequest {
  if (typeof value !== "object" || value === null) return false;
  const contentRevision = (value as Partial<ReminderRequest>).content_revision;
  return Number.isSafeInteger(contentRevision) && Number(contentRevision) >= 1;
}

export function TeacherReminderAction({
  compact = false,
  contentRevision,
  lastRequestedAt,
  membershipId,
  onCreate,
  onRegistered,
  resourceId,
  resourceLabel,
  resourceType,
  statusVerified = true,
  title,
  unresolvedCount,
}: TeacherReminderActionProps): React.JSX.Element | null {
  const navigate = useNavigate();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [outcomeUnknown, setOutcomeUnknown] = useState(false);
  const [error, setError] = useState<string>();
  const [result, setResult] = useState<RegisteredReminderResult>();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const submittingRef = useRef(false);
  const attemptRef = useRef<IdempotentCreateAttempt<ReminderRequest> | undefined>(undefined);
  const storageKey = idempotentCreateStorageKey(
    `${resourceType}-reminder-${resourceId}`,
    membershipId,
  );
  const actionLabel = statusVerified
    ? `현재 미해결 ${unresolvedCount}명에게 다시 알려주기`
    : "최신 현황을 확인한 뒤 다시 알려주기";
  const pendingContentRevision =
    attemptRef.current === undefined
      ? undefined
      : String(attemptRef.current.request.content_revision);
  const displayedRequestedAt =
    result?.contentRevision === contentRevision ? result.response.created_at : lastRequestedAt;

  // 그려지는 순간 정리한다. useEffect는 그린 뒤에 돌아 그 사이 누른 '다시 알려주기'의 창 열기를 닫아 버렸다(10-21 부하 재현 3/120).
  useLayoutEffect(() => {
    const pending = readIdempotentCreateAttempt(storageKey, isReminderRequest);
    attemptRef.current = pending;
    setResult(undefined);
    setOutcomeUnknown(pending !== undefined);
    setError(pending === undefined ? undefined : UNKNOWN_RESULT_MESSAGE);
    setDialogOpen(false);
  }, [contentRevision, storageKey]);

  async function submit(): Promise<void> {
    const existingAttempt =
      attemptRef.current ?? readIdempotentCreateAttempt(storageKey, isReminderRequest);
    if (
      submittingRef.current ||
      (existingAttempt === undefined && (!statusVerified || unresolvedCount < 1))
    ) {
      return;
    }
    submittingRef.current = true;

    let request: ReminderRequest;
    if (existingAttempt !== undefined) {
      request = existingAttempt.request;
    } else {
      try {
        request = {
          content_revision: reminderContentRevision(contentRevision, resourceLabel),
        };
      } catch (requestError) {
        setError(
          requestError instanceof Error
            ? requestError.message
            : `${resourceLabel} 내용이 바뀌었는지 확인하지 못했어요.`,
        );
        submittingRef.current = false;
        return;
      }
    }

    attemptRef.current = existingAttempt;
    const preparation = prepareIdempotentCreateAttempt(storageKey, request, existingAttempt);
    if (preparation.kind === "mismatch") {
      setError(changedMutationResultMessage());
      submittingRef.current = false;
      return;
    }
    if (preparation.kind === "expired") {
      setError(expiredMutationResultMessage("앱 내 재알림 등록 요청"));
      submittingRef.current = false;
      return;
    }
    if (preparation.kind === "storage-unavailable") {
      setError(unavailableMutationStorageMessage());
      submittingRef.current = false;
      return;
    }

    attemptRef.current = preparation.attempt;
    setSubmitting(true);
    setError(undefined);
    setResult(undefined);
    try {
      const requestContentRevision = String(preparation.attempt.request.content_revision);
      const created = await onCreate(requestContentRevision, preparation.attempt.idempotencyKey);
      clearIdempotentCreateAttempt(storageKey, preparation.attempt.idempotencyKey);
      attemptRef.current = undefined;
      setOutcomeUnknown(false);
      setResult({ contentRevision: requestContentRevision, response: created });
      onRegistered(created, requestContentRevision);
    } catch (requestError) {
      if (requestError instanceof ApiRequestError && requestError.status === 401) {
        void navigate("/login", { replace: true });
        return;
      }
      if (isMutationOutcomeUnknown(requestError)) {
        setOutcomeUnknown(true);
        setError(
          persistIdempotentCreateAttempt(storageKey, preparation.attempt)
            ? UNKNOWN_RESULT_MESSAGE
            : `${UNKNOWN_RESULT_MESSAGE} 이 화면을 닫거나 새로고침하지 마세요. 닫으면 저장됐는지 다시 확인할 수 없어요.`,
        );
      } else {
        clearIdempotentCreateAttempt(storageKey, preparation.attempt.idempotencyKey);
        attemptRef.current = undefined;
        setOutcomeUnknown(false);
        if (
          requestError instanceof ApiRequestError &&
          requestError.code === "REMINDER_COOLDOWN_ACTIVE"
        ) {
          const nextAvailableAt = requestError.details?.next_available_at;
          setError(
            typeof nextAvailableAt === "string"
              ? `학생별 24시간 제한 중이에요. ${formatKstDateTime(nextAvailableAt)}부터 다시 등록할 수 있어요.`
              : displayedRequestedAt === null
                ? "학생별 24시간 제한 중이에요. 마지막 요청에서 24시간이 지난 뒤 다시 등록해 주세요."
                : `학생별 24시간 제한 중이에요. 최근 요청 ${formatKstDateTime(displayedRequestedAt)}에서 24시간이 지난 뒤 다시 등록해 주세요.`,
          );
        } else {
          setError(
            requestError instanceof Error
              ? requestError.message
              : "앱 내 재알림을 등록하지 못했습니다.",
          );
        }
      }
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  if (
    statusVerified &&
    unresolvedCount < 1 &&
    !outcomeUnknown &&
    result === undefined &&
    error === undefined
  ) {
    return null;
  }

  return (
    <section
      className={
        compact ? "min-w-0" : "mt-4 rounded-2xl border border-role-border bg-role-soft p-3 sm:p-4"
      }
      data-reminder-action={resourceType}
    >
      <div
        className={compact ? "min-w-0" : "flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center"}
      >
        <div className={compact ? "sr-only" : "flex min-w-0 items-start gap-3"}>
          <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-app-surface-raised text-role-primary shadow-sm ring-1 ring-role-border">
            <BellRing aria-hidden="true" size={18} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-extrabold text-app-text">
              {statusVerified ? "앱 내 재알림" : "현재 현황을 다시 확인해 주세요"}
            </p>
            <p
              className={`mt-0.5 break-keep text-xs leading-5 ${
                statusVerified ? "font-semibold text-app-muted" : "font-bold text-amber-800"
              }`}
            >
              {statusVerified
                ? displayedRequestedAt === null
                  ? "이메일·문자·푸시 없이 앱 안에서만 알려요 · 아직 요청 없음"
                  : `이메일·문자·푸시 없이 앱 안에서만 알려요 · 최근 요청 ${formatKstDateTime(displayedRequestedAt)}`
                : "최신 내용과 학생 현황을 불러오기 전에는 새 요청을 등록할 수 없어요."}
            </p>
            {outcomeUnknown && pendingContentRevision !== undefined ? (
              <>
                <p className="mt-1 text-xs font-bold text-rose-700">
                  결과를 다시 확인할 요청 · {pendingContentRevision}번째 내용
                </p>
                {pendingContentRevision === contentRevision ? null : (
                  <p className="mt-1 text-xs font-semibold text-app-muted">
                    지금은 {contentRevision}번째 내용
                  </p>
                )}
              </>
            ) : null}
          </div>
        </div>

        {outcomeUnknown ? null : (
          <button
            aria-busy={submitting}
            aria-label={actionLabel}
            className={
              compact
                ? "ui-button ui-button-primary min-h-12 w-full break-keep text-sm"
                : "ui-button ui-button-primary w-full shrink-0 break-keep text-sm sm:ml-auto sm:w-auto"
            }
            disabled={submitting || !statusVerified || unresolvedCount < 1}
            onClick={() => {
              setError(undefined);
              setResult(undefined);
              setDialogOpen(true);
            }}
            ref={triggerRef}
            type="button"
          >
            {submitting ? (
              <LoaderCircle aria-hidden="true" className="animate-spin" size={18} />
            ) : (
              <BellRing aria-hidden="true" size={18} />
            )}
            {compact && statusVerified ? `${unresolvedCount}명에게 다시 알림` : actionLabel}
          </button>
        )}
      </div>

      {error === undefined ? null : (
        <div
          className="mt-3 rounded-xl border border-home-important-line bg-app-surface-raised px-3 py-2.5 text-sm font-bold leading-6 text-home-important"
          role="alert"
        >
          <p>{error}</p>
          {outcomeUnknown ? (
            <button
              aria-busy={submitting}
              className="ui-button ui-button-primary mt-3 w-full text-sm"
              disabled={submitting}
              onClick={() => void submit()}
              type="button"
            >
              {submitting ? (
                <LoaderCircle aria-hidden="true" className="animate-spin" size={17} />
              ) : (
                <RotateCcw aria-hidden="true" size={17} />
              )}
              등록 결과 다시 확인
            </button>
          ) : null}
        </div>
      )}

      <p
        aria-atomic="true"
        aria-live="polite"
        className={
          result === undefined
            ? "sr-only"
            : "mt-3 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 border-t border-role-border pt-3 text-sm leading-5"
        }
        data-reminder-result={resourceType}
        role="status"
      >
        {result === undefined ? null : (
          <>
            <span className="inline-flex shrink-0 items-center gap-1.5 font-extrabold text-home-supplies">
              <CheckCircle2 aria-hidden="true" className="shrink-0" focusable="false" size={18} />앱
              내 재알림 등록
            </span>
            <span className="font-semibold text-app-text">
              미해결 {result.response.current_unresolved_count}명 · 새 등록{" "}
              {result.response.created_count}명 · 제한 제외{" "}
              {result.response.cooldown_suppressed_count}명
            </span>
            {result.contentRevision === contentRevision ? null : (
              <span className="text-xs font-bold text-amber-800">
                등록할 때 {result.contentRevision}번째 내용 · 지금은 {contentRevision}번째 내용
              </span>
            )}
            {result.response.next_available_at === null ? null : (
              <span className="text-xs font-semibold text-app-muted">
                다음 등록 가능 {formatKstDateTime(result.response.next_available_at)}
              </span>
            )}
          </>
        )}
      </p>

      <ConfirmDialog
        confirmLabel="다시 알림"
        confirmTone="primary"
        description={
          <div className="space-y-2">
            <p className="break-words font-bold text-app-text">{title}</p>
            <p className="font-bold text-app-muted">{contentRevision}번째 내용</p>
            <p>
              지금 내용 기준으로 아직 해결하지 않은 학생만 다시 확인해요. 이미 확인하거나 챙긴
              학생에게는 보내지 않으며, 24시간 안에 요청한 학생도 제외해 결과에서 알려 드립니다.
            </p>
            <p className="font-bold text-brand-primary-strong">
              앱 안에서만 다시 알려요. 이메일·문자·푸시는 보내지 않습니다.
            </p>
          </div>
        }
        onCancel={() => setDialogOpen(false)}
        onConfirm={() => {
          setDialogOpen(false);
          void submit();
        }}
        open={dialogOpen}
        returnFocusTo={triggerRef.current}
        title={`현재 미해결 ${unresolvedCount}명에게 다시 알려줄까요?`}
      />
    </section>
  );
}

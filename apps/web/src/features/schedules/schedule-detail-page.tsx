import { clearAuthenticatedClientState } from "../../lib/authenticated-client-state";
import {
  CheckCircle2,
  GitCompareArrows,
  LoaderCircle,
  Pencil,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router";

import { ApiRequestError, getBootstrap, type BootstrapResponse } from "../../api/auth";
import {
  deleteSchedule,
  getSchedule,
  updateSchedule,
  type ScheduleEntityResponse,
  type ScheduleWriteRequest,
} from "../../api/schedules";
import { codePointLength } from "../../lib/text";
import {
  ContentDetailFrame,
  focusDetailTool,
  DetailHeading,
  type EmbeddedDetailProps,
} from "../details/content-detail-frame";
import { AsyncStatePanel } from "../layout/async-state";
import { ConfirmDialog } from "../layout/confirm-dialog";
import { itemListEntryKey } from "../layout/item-list-history";
import { formatScheduleDate, scheduleTypeLabel } from "./schedule-format";
import { ScheduleForm } from "./schedule-form";
import { ScheduleLinksSection } from "./schedule-links-section";

interface ScheduleDetailLocationState {
  notice?: string;
}

function locationNotice(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const notice = (value as ScheduleDetailLocationState).notice;
  return typeof notice === "string" ? notice : undefined;
}

function scheduleListPath(daysUntil: number): string {
  return daysUntil < 0 ? "/schedules?scope=past" : "/schedules";
}

export function ScheduleDetailPage(props: EmbeddedDetailProps = {}): React.JSX.Element {
  const { scheduleId } = useParams<{ scheduleId: string }>();
  return <ScheduleDetailPageContent key={props.embeddedId ?? scheduleId} {...props} />;
}
function ScheduleDetailPageContent({
  embeddedId,
  onClose,
}: EmbeddedDetailProps = {}): React.JSX.Element {
  const embedded = embeddedId !== undefined;
  const navigate = useNavigate();
  const location = useLocation();
  const { scheduleId: routeId } = useParams<{ scheduleId: string }>();
  const scheduleId = embeddedId ?? routeId;
  const originListEntryKey = itemListEntryKey(location.state, "schedules", scheduleId);
  const [bootstrap, setBootstrap] = useState<BootstrapResponse>();
  const [entity, setEntity] = useState<ScheduleEntityResponse>();
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(
    () => !embedded && new URLSearchParams(location.search).get("edit") === "1",
  );
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteReason, setDeleteReason] = useState("");
  const [deleteError, setDeleteError] = useState<string>();
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deletePanelOpen, setDeletePanelOpen] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string | undefined>(() => locationNotice(location.state));
  const pageActiveRef = useRef(true);
  const mutationRef = useRef(false);
  useEffect(() => {
    pageActiveRef.current = true;
    return () => {
      pageActiveRef.current = false;
    };
  }, []);
  const editButtonRef = useRef<HTMLButtonElement>(null);
  const deleteButtonRef = useRef<HTMLButtonElement>(null);
  const deleteReasonErrorId = useId();
  const deleteReasonCountId = useId();

  useEffect(() => {
    if (!deletePanelOpen) return;
    const field = document.getElementById("schedule-delete-reason");
    field?.scrollIntoView?.({ block: "center" });
    field?.focus({ preventScroll: true });
  }, [deletePanelOpen]);

  function returnToScheduleList(listPath: string): void {
    if (embedded && onClose) {
      onClose();
      return;
    }
    if (originListEntryKey !== undefined) {
      void navigate(-1);
      return;
    }
    void navigate(listPath);
  }

  async function refreshSchedule(): Promise<ScheduleEntityResponse | undefined> {
    if (scheduleId === undefined) return undefined;
    const latest = await getSchedule(scheduleId);
    if (!pageActiveRef.current) return undefined;
    setEntity(latest);
    return latest;
  }

  async function retryInitialLoad(): Promise<void> {
    if (scheduleId === undefined) return;
    setLoading(true);
    setError(undefined);
    try {
      let result = bootstrap;
      if (result === undefined) {
        result = await getBootstrap();
        if (!pageActiveRef.current) return;
        if (
          result.destination !== "HOME" ||
          result.current_membership === null ||
          !result.allowed_actions.includes("VIEW_CLASS")
        ) {
          void navigate("/bootstrap", { replace: true });
          return;
        }
        if (!pageActiveRef.current) return;
        setBootstrap(result);
      }
      const latest = await getSchedule(scheduleId);
      if (!pageActiveRef.current) return;
      setEntity(latest);
    } catch (requestError) {
      if (!pageActiveRef.current) return;
      if (requestError instanceof ApiRequestError && requestError.status === 401) {
        clearAuthenticatedClientState();
        void navigate("/login", { replace: true });
        return;
      }
      setError(
        requestError instanceof Error ? requestError.message : "일정을 불러오지 못했습니다.",
      );
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (scheduleId === undefined) {
      void navigate("/schedules", { replace: true });
      return;
    }
    let active = true;
    void getBootstrap()
      .then(async (result) => {
        if (!active) return;
        if (
          result.destination !== "HOME" ||
          result.current_membership === null ||
          !result.allowed_actions.includes("VIEW_CLASS")
        ) {
          void navigate("/bootstrap", { replace: true });
          return;
        }
        setBootstrap(result);
        const nextEntity = await getSchedule(scheduleId);
        if (!active) return;
        setEntity(nextEntity);
      })
      .catch((requestError: unknown) => {
        if (!active) return;
        if (requestError instanceof ApiRequestError && requestError.status === 401) {
          clearAuthenticatedClientState();
          void navigate("/login", { replace: true });
          return;
        }
        setError(
          requestError instanceof Error ? requestError.message : "일정을 불러오지 못했습니다.",
        );
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [navigate, scheduleId]);

  const navigationRole = bootstrap?.current_membership?.role;

  async function submitUpdate(request: ScheduleWriteRequest): Promise<void> {
    if (
      !pageActiveRef.current ||
      mutationRef.current ||
      scheduleId === undefined ||
      entity === undefined ||
      entity.item.id !== scheduleId
    )
      return;
    mutationRef.current = true;
    setSaving(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const updated = await updateSchedule(scheduleId, request, entity.etag);
      if (!pageActiveRef.current) return;
      const changed = updated.item.row_version !== entity.item.row_version;
      setEntity(updated);
      setEditing(false);
      setNotice(
        changed
          ? "일정을 수정했습니다. 날짜를 바꾸면 홈의 노출 순서도 함께 달라집니다."
          : "변경된 내용이 없어 기존 일정을 그대로 유지했습니다.",
      );
      window.setTimeout(() => {
        if (pageActiveRef.current) focusDetailTool(editButtonRef.current);
      }, 0);
    } catch (requestError) {
      if (!pageActiveRef.current) return;
      if (
        requestError instanceof ApiRequestError &&
        requestError.code === "RESOURCE_VERSION_CHANGED"
      ) {
        let refreshed = false;
        try {
          await refreshSchedule();
          if (!pageActiveRef.current) return;
          refreshed = true;
          setEditing(false);
        } catch (refreshError) {
          if (!pageActiveRef.current) return;
          if (refreshError instanceof ApiRequestError && refreshError.status === 401) {
            clearAuthenticatedClientState();
            void navigate("/login", { replace: true });
            return;
          }
        }
        if (!pageActiveRef.current) return;
        if (refreshed)
          window.setTimeout(() => {
            if (pageActiveRef.current) focusDetailTool(editButtonRef.current);
          }, 0);
        setError(
          refreshed
            ? "다른 곳에서 먼저 수정되어 최신 일정을 불러왔어요. 다시 확인해 주세요."
            : "다른 곳에서 먼저 수정되었지만 최신 일정을 불러오지 못했어요. 목록에서 다시 열어 주세요.",
        );
      } else if (requestError instanceof ApiRequestError && requestError.status === 401) {
        clearAuthenticatedClientState();
        void navigate("/login", { replace: true });
      } else {
        setError(
          requestError instanceof Error ? requestError.message : "일정을 수정하지 못했습니다.",
        );
      }
    } finally {
      mutationRef.current = false;
      if (pageActiveRef.current) setSaving(false);
    }
  }

  function requestDelete(): void {
    const reason = deleteReason.trim();
    if (codePointLength(reason) > 300) {
      setNotice(undefined);
      setDeleteError("삭제 사유는 300자 이하로 입력해 주세요.");
      return;
    }
    setError(undefined);
    setDeleteError(undefined);
    setNotice(undefined);
    setDeleteDialogOpen(true);
  }

  async function submitDelete(): Promise<void> {
    if (
      !pageActiveRef.current ||
      mutationRef.current ||
      scheduleId === undefined ||
      entity === undefined ||
      entity.item.id !== scheduleId
    )
      return;
    mutationRef.current = true;
    setDeleting(true);
    setError(undefined);
    setDeleteError(undefined);
    try {
      const reason = deleteReason.trim();
      const destination = scheduleListPath(entity.item.days_until);
      await deleteSchedule(scheduleId, reason === "" ? null : reason, entity.etag);
      if (!pageActiveRef.current) return;
      if (embedded && onClose) {
        onClose();
        return;
      }
      void navigate(destination, {
        replace: true,
        state: { notice: "일정을 삭제했습니다." },
      });
    } catch (requestError) {
      if (!pageActiveRef.current) return;
      if (
        requestError instanceof ApiRequestError &&
        requestError.code === "RESOURCE_VERSION_CHANGED"
      ) {
        let refreshed = false;
        try {
          await refreshSchedule();
          if (!pageActiveRef.current) return;
          refreshed = true;
        } catch (refreshError) {
          if (!pageActiveRef.current) return;
          if (refreshError instanceof ApiRequestError && refreshError.status === 401) {
            clearAuthenticatedClientState();
            void navigate("/login", { replace: true });
            return;
          }
        }
        if (!pageActiveRef.current) return;
        setDeleteError(
          refreshed
            ? "다른 곳에서 먼저 수정되어 삭제하지 않았어요. 최신 내용을 확인해 주세요."
            : "다른 곳에서 먼저 수정되어 삭제하지 않았고 최신 내용도 불러오지 못했어요. 목록에서 다시 열어 주세요.",
        );
      } else if (requestError instanceof ApiRequestError && requestError.status === 401) {
        clearAuthenticatedClientState();
        void navigate("/login", { replace: true });
      } else {
        setDeleteError(
          requestError instanceof Error ? requestError.message : "일정을 삭제하지 못했습니다.",
        );
      }
      mutationRef.current = false;
      if (pageActiveRef.current) setDeleting(false);
      window.setTimeout(() => {
        if (pageActiveRef.current) deleteButtonRef.current?.focus();
      }, 0);
    }
  }

  if (bootstrap === undefined || entity === undefined) {
    return (
      <ContentDetailFrame
        embedded={embedded}
        {...(navigationRole === undefined ? {} : { navigationRole })}
        backTo="/schedules"
        backLabel="일정"
        {...(embedded || originListEntryKey !== undefined
          ? { onBack: () => returnToScheduleList("/schedules") }
          : {})}
      >
        {" "}
        {embedded ? (
          <h2 className="content-detail-title">일정</h2>
        ) : (
          <h1 className="content-detail-title">일정</h1>
        )}
        <AsyncStatePanel
          {...(loading
            ? {}
            : {
                action: (
                  <div className="flex flex-wrap justify-center gap-3">
                    <button
                      className="ui-button ui-button-primary text-sm"
                      onClick={() => void retryInitialLoad()}
                      type="button"
                    >
                      <RefreshCw aria-hidden="true" size={17} /> 다시 불러오기
                    </button>
                    <button
                      className="ui-button ui-button-secondary text-sm"
                      onClick={() => void navigate("/schedules")}
                      type="button"
                    >
                      일정 목록으로
                    </button>
                  </div>
                ),
                description: "이 화면에서 다시 불러오거나 일정 목록에서 다른 내용을 확인해 주세요.",
              })}
          kind={loading ? "loading" : "error"}
          title={loading ? "일정을 불러오고 있어요." : "일정을 불러오지 못했어요."}
          tone="schedule"
        />
      </ContentDetailFrame>
    );
  }
  const { item } = entity;
  const teacher = bootstrap.current_membership?.role === "teacher";
  const mutationBusy = saving || deleting;
  const deleteReasonLength = codePointLength(deleteReason.trim());
  const listPath = scheduleListPath(item.days_until);
  return (
    <ContentDetailFrame
      embedded={embedded}
      navigationRole={teacher ? "teacher" : "student"}
      backTo={listPath}
      backLabel="일정"
      {...(embedded || originListEntryKey !== undefined
        ? { onBack: () => returnToScheduleList(listPath) }
        : {})}
      tools={
        teacher ? (
          <>
            <button
              className="ui-button ui-button-secondary text-sm"
              disabled={mutationBusy || editing}
              onClick={() => void navigate(`/schedules/${item.id}/change-review`)}
              type="button"
            >
              <GitCompareArrows aria-hidden="true" size={17} />
              관련 안내 변경 검토
            </button>
            <button
              aria-controls="schedule-edit-panel"
              aria-expanded={editing}
              className="ui-button ui-button-secondary text-sm"
              disabled={mutationBusy}
              onClick={() => {
                if (embedded) {
                  void navigate(`/schedules/${item.id}?edit=1`);
                  return;
                }
                setEditing(!editing);
                setError(undefined);
                setNotice(undefined);
              }}
              ref={editButtonRef}
              type="button"
            >
              <Pencil aria-hidden="true" size={17} />
              일정 수정
            </button>
            <button
              aria-expanded={deletePanelOpen}
              aria-label="일정 삭제 옵션"
              className="ui-button ui-button-danger text-sm"
              disabled={mutationBusy}
              onClick={() => setDeletePanelOpen(!deletePanelOpen)}
              type="button"
            >
              <Trash2 aria-hidden="true" size={17} />
              삭제
            </button>
          </>
        ) : undefined
      }
      aside={
        editing ? undefined : (
          <ScheduleLinksSection scheduleId={item.id} version={item.row_version} />
        )
      }
    >
      <article className="h-full min-w-0 rounded-[1.25rem] border border-app-border bg-app-surface p-[18px] shadow-card lg:px-8 lg:py-7">
        <DetailHeading
          title={item.title}
          kind={scheduleTypeLabel[item.schedule_type]}
          meta={item.subject ?? undefined}
        />
        <section aria-labelledby="schedule-description-heading" className="mt-4">
          <h2 className="sr-only" id="schedule-description-heading">
            일정 설명
          </h2>
          <p className="whitespace-pre-wrap break-words text-[15.5px] leading-[1.75] text-app-text">
            {item.description ?? "별도로 등록된 설명이 없어요."}
          </p>
        </section>
        <dl className="mt-5 divide-y divide-app-border border-t border-app-border text-sm">
          <div className="flex justify-between gap-3 py-3">
            <dt className="text-app-muted">날짜</dt>
            <dd className="font-bold text-app-text">
              <time dateTime={item.due_date}>{formatScheduleDate(item.due_date)}</time>
              {item.d_day_label === null ? null : (
                <span className="ml-2 text-role-primary">{item.d_day_label}</span>
              )}
            </dd>
          </div>
          {item.subject === null ? null : (
            <div className="flex justify-between gap-3 py-3">
              <dt className="text-app-muted">과목</dt>
              <dd className="font-bold text-app-text">{item.subject}</dd>
            </div>
          )}
        </dl>
        {teacher && editing ? (
          <section
            className="mt-6 rounded-card border border-role-border bg-app-surface-muted p-5 sm:p-6"
            id="schedule-edit-panel"
          >
            <h2 className="break-keep text-xl font-extrabold text-app-text">일정 수정</h2>
            <p className="mt-2 break-keep text-sm leading-6 text-app-muted">
              날짜를 오늘 이후로 바꾸면 홈의 가까운 일정에 다시 표시돼요.
            </p>
            <div className="mt-5">
              <ScheduleForm
                busy={mutationBusy}
                initialValue={{
                  description: item.description,
                  due_date: item.due_date,
                  schedule_type: item.schedule_type,
                  subject: item.subject,
                  title: item.title,
                }}
                onCancel={() => {
                  setEditing(false);
                  focusDetailTool(editButtonRef.current);
                }}
                onSubmit={(request) => void submitUpdate(request)}
                submitLabel="수정 저장"
              />
            </div>
          </section>
        ) : null}

        {error === undefined ? null : (
          <p
            className="mt-6 rounded-2xl border border-danger bg-app-surface px-4 py-3 text-sm font-bold text-app-text"
            role="alert"
          >
            {error}
          </p>
        )}
        {notice === undefined ? null : (
          <p
            aria-live="polite"
            className="mt-6 flex items-start gap-2 rounded-2xl border border-role-border bg-role-soft px-4 py-3 text-sm font-bold text-role-primary"
            role="status"
          >
            <CheckCircle2 aria-hidden="true" className="mt-0.5 shrink-0" size={18} />
            {notice}
          </p>
        )}

        {teacher && deletePanelOpen ? (
          <section className="mt-6 rounded-card border border-danger bg-app-surface-raised p-5 shadow-sm sm:p-7">
            <p className="text-sm font-bold text-danger">위험 작업</p>
            <h2 className="mt-1 break-keep text-xl font-extrabold text-app-text">일정 삭제</h2>
            <p className="mt-2 break-keep text-sm leading-6 text-app-muted">
              삭제하면 홈과 일정 목록에서 즉시 숨겨지며 화면에서 되돌릴 수 없어요.
            </p>
            <label className="auth-label mt-5" htmlFor="schedule-delete-reason">
              삭제 사유 <span className="font-medium text-app-muted">(선택)</span>
            </label>
            <textarea
              aria-describedby={`${deleteReasonCountId}${deleteError === undefined ? "" : ` ${deleteReasonErrorId}`}`}
              aria-invalid={deleteReasonLength > 300 || undefined}
              className="ui-input min-h-24 resize-y py-3 leading-6"
              disabled={mutationBusy}
              id="schedule-delete-reason"
              onChange={(event) => {
                setDeleteReason(event.target.value);
                setDeleteError(undefined);
              }}
              placeholder="삭제 이유를 기록할 수 있어요."
              rows={3}
              value={deleteReason}
            />
            <p
              className="mt-2 text-right text-xs font-medium text-app-muted"
              id={deleteReasonCountId}
            >
              {deleteReasonLength} / 300자
            </p>
            {deleteError === undefined ? null : (
              <p
                className="mt-3 rounded-2xl border border-danger bg-app-surface px-4 py-3 text-sm font-bold text-app-text"
                id={deleteReasonErrorId}
                role="alert"
              >
                {deleteError}
              </p>
            )}
            <button
              aria-busy={deleting}
              className="ui-button ui-button-danger-solid mt-4 text-sm"
              disabled={mutationBusy}
              onClick={requestDelete}
              ref={deleteButtonRef}
              type="button"
            >
              {deleting ? (
                <LoaderCircle aria-hidden="true" className="animate-spin" size={17} />
              ) : (
                <Trash2 aria-hidden="true" size={17} />
              )}
              일정 삭제
            </button>
          </section>
        ) : null}
      </article>
      <ConfirmDialog
        confirmLabel="일정 삭제"
        description={
          deleteReason.trim() === ""
            ? "홈과 일정 목록에서 즉시 숨겨집니다. 이 작업은 화면에서 되돌릴 수 없어요."
            : "홈과 일정 목록에서 즉시 숨겨지며, 입력한 삭제 사유도 함께 기록됩니다."
        }
        onCancel={() => setDeleteDialogOpen(false)}
        onConfirm={() => {
          setDeleteDialogOpen(false);
          window.setTimeout(() => {
            if (pageActiveRef.current) void submitDelete();
          }, 0);
        }}
        open={deleteDialogOpen}
        returnFocusTo={deleteButtonRef.current}
        title={`“${item.title}” 일정을 삭제할까요?`}
      />
    </ContentDetailFrame>
  );
}

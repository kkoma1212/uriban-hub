import { CheckCircle2, Copy, LoaderCircle, Pencil, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router";

import { ApiRequestError, getBootstrap, type BootstrapResponse } from "../../api/auth";
import {
  confirmNotice,
  deleteNotice,
  getNotice,
  updateNotice,
  type NoticeEntityResponse,
  type NoticeWriteRequest,
} from "../../api/notices";
import { codePointLength } from "../../lib/text";
import {
  ContentDetailFrame,
  focusDetailTool,
  DetailHeading,
  StudentDetailActions,
  type EmbeddedDetailProps,
} from "../details/content-detail-frame";
import { AsyncStatePanel } from "../layout/async-state";
import { ConfirmDialog } from "../layout/confirm-dialog";
import { itemListEntryKey } from "../layout/item-list-history";
import { noticeListEntryKey } from "./notice-list-history";
import { NoticeConfirmationsPanel } from "./notice-confirmations-panel";
import { NoticeForm } from "./notice-form";
import { formatNoticeDateTime } from "./notice-format";
import { StudentNoticeConfirmation } from "./student-notice-confirmation";

interface NoticeDetailLocationState {
  notice?: string;
}

function locationNotice(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const notice = (value as NoticeDetailLocationState).notice;
  return typeof notice === "string" ? notice : undefined;
}

function noticeListPath(): string {
  return "/notices";
}

export function NoticeDetailPage({
  embeddedId,
  onClose,
}: EmbeddedDetailProps = {}): React.JSX.Element {
  const embedded = embeddedId !== undefined;
  const navigate = useNavigate();
  const location = useLocation();
  const { noticeId: routeId } = useParams<{ noticeId: string }>();
  const noticeId = embeddedId ?? routeId;
  const updatesOrigin = itemListEntryKey(location.state, "updates", `notice:${noticeId}`);
  const originListEntryKey = updatesOrigin ?? noticeListEntryKey(location.state, noticeId);
  const [bootstrap, setBootstrap] = useState<BootstrapResponse>();
  const [entity, setEntity] = useState<NoticeEntityResponse>();
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteExpanded, setDeleteExpanded] = useState(false);
  const [deleteReason, setDeleteReason] = useState("");
  const [deleteError, setDeleteError] = useState<string>();
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string | undefined>(() => locationNotice(location.state));
  const editButtonRef = useRef<HTMLButtonElement>(null);
  const deleteButtonRef = useRef<HTMLButtonElement>(null);
  const followupFocusEntryRef = useRef<string | undefined>(undefined);
  const restoreEditFocusRef = useRef(false);
  const deleteControlsId = useId();
  const deleteReasonErrorId = useId();
  const deleteReasonCountId = useId();
  const requestContextRef = useRef({ noticeId, generation: 0, mounted: true });
  requestContextRef.current.noticeId = noticeId;
  const renderedRequestGeneration = requestContextRef.current.generation;
  const navigationRole = bootstrap?.current_membership?.role;
  const teacher = navigationRole === "teacher";

  useEffect(() => {
    if (!deleteExpanded) return;
    const field = document.getElementById("notice-delete-reason");
    field?.scrollIntoView?.({ block: "center" });
    field?.focus({ preventScroll: true });
  }, [deleteExpanded]);

  function returnToNoticeList(): void {
    if (embedded && onClose) {
      onClose();
      return;
    }
    if (originListEntryKey !== undefined) {
      void navigate(-1);
      return;
    }
    void navigate(noticeListPath());
  }

  async function refreshNotice(): Promise<NoticeEntityResponse | undefined> {
    if (noticeId === undefined || !isCurrentRequest(noticeId, renderedRequestGeneration))
      return undefined;
    const generation = renderedRequestGeneration;
    const latest = await getNotice(noticeId);
    if (!isCurrentRequest(noticeId, generation)) return undefined;
    setEntity(latest);
    return latest;
  }

  function isCurrentRequest(id: string, generation: number): boolean {
    const current = requestContextRef.current;
    return current.mounted && current.noticeId === id && current.generation === generation;
  }

  async function retryInitialLoad(): Promise<void> {
    if (noticeId === undefined || !isCurrentRequest(noticeId, renderedRequestGeneration)) return;
    const generation = ++requestContextRef.current.generation;
    setLoading(true);
    setError(undefined);
    try {
      let result = bootstrap;
      if (result === undefined) {
        result = await getBootstrap();
        if (!isCurrentRequest(noticeId, generation)) return;
        if (
          result.destination !== "HOME" ||
          result.current_membership === null ||
          !result.allowed_actions.includes("VIEW_CLASS")
        ) {
          void navigate("/bootstrap", { replace: true });
          return;
        }
        setBootstrap(result);
      }
      const latest = await getNotice(noticeId);
      if (!isCurrentRequest(noticeId, generation)) return;
      setEntity(latest);
    } catch (requestError) {
      if (!isCurrentRequest(noticeId, generation)) return;
      if (requestError instanceof ApiRequestError && requestError.status === 401) {
        void navigate("/login", { replace: true });
        return;
      }
      setError(
        requestError instanceof Error ? requestError.message : "공지를 불러오지 못했습니다.",
      );
    } finally {
      if (isCurrentRequest(noticeId, generation)) setLoading(false);
    }
  }

  useEffect(() => {
    requestContextRef.current.mounted = true;
    const generation = ++requestContextRef.current.generation;
    setLoading(true);
    setEntity(undefined);
    setError(undefined);
    setEditing(false);
    setSaving(false);
    setConfirming(false);
    setDeleting(false);
    setDeleteExpanded(false);
    setDeleteReason("");
    setDeleteError(undefined);
    setDeleteDialogOpen(false);
    setNotice(locationNotice(location.state));
    restoreEditFocusRef.current = false;
    if (noticeId === undefined) {
      void navigate("/notices", { replace: true });
      return;
    }
    let active = true;
    void getBootstrap()
      .then(async (result) => {
        if (!active || !isCurrentRequest(noticeId, generation)) return;
        if (
          result.destination !== "HOME" ||
          result.current_membership === null ||
          !result.allowed_actions.includes("VIEW_CLASS")
        ) {
          void navigate("/bootstrap", { replace: true });
          return;
        }
        setBootstrap(result);
        const nextEntity = await getNotice(noticeId);
        if (!active || !isCurrentRequest(noticeId, generation)) return;
        setEntity(nextEntity);
      })
      .catch((requestError: unknown) => {
        if (!active || !isCurrentRequest(noticeId, generation)) return;
        if (requestError instanceof ApiRequestError && requestError.status === 401) {
          void navigate("/login", { replace: true });
          return;
        }
        setError(
          requestError instanceof Error ? requestError.message : "공지를 불러오지 못했습니다.",
        );
      })
      .finally(() => {
        if (active && isCurrentRequest(noticeId, generation)) setLoading(false);
      });
    return () => {
      active = false;
      requestContextRef.current.mounted = false;
    };
  }, [navigate, noticeId]);

  useEffect(() => {
    if (
      !teacher ||
      entity === undefined ||
      noticeId === undefined ||
      location.hash !== "#notice-confirmation-status"
    ) {
      return;
    }
    const entryKey = `${location.key}:${noticeId}`;
    if (followupFocusEntryRef.current === entryKey) return;
    const target = document.getElementById("notice-confirmation-status");
    if (!(target instanceof HTMLElement)) return;
    followupFocusEntryRef.current = entryKey;
    target.scrollIntoView?.({ block: "start" });
    target.focus({ preventScroll: true });
  }, [entity, location.hash, location.key, noticeId, teacher]);

  useEffect(() => {
    if (editing || saving || !restoreEditFocusRef.current) return;
    restoreEditFocusRef.current = false;
    focusDetailTool(editButtonRef.current);
  }, [editing, saving]);

  async function submitUpdate(request: NoticeWriteRequest): Promise<void> {
    if (
      noticeId === undefined ||
      entity?.item.id !== noticeId ||
      !isCurrentRequest(noticeId, renderedRequestGeneration)
    )
      return;
    const generation = renderedRequestGeneration;
    setSaving(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const previous = entity.item;
      const updated = await updateNotice(noticeId, request, entity.etag);
      if (!isCurrentRequest(noticeId, generation)) return;
      setEntity(updated);
      restoreEditFocusRef.current = true;
      setEditing(false);
      if (updated.item.row_version === previous.row_version) {
        setNotice("변경된 내용이 없어 기존 공지를 그대로 유지했습니다.");
      } else if (updated.item.content_revision === previous.content_revision) {
        setNotice("중요 표시를 변경했습니다. 학생들의 기존 확인 기록은 유지됩니다.");
      } else {
        setNotice("공지 내용을 수정했습니다. 학생들은 최신 내용을 다시 확인하게 됩니다.");
      }
    } catch (requestError) {
      if (!isCurrentRequest(noticeId, generation)) return;
      if (
        requestError instanceof ApiRequestError &&
        requestError.code === "RESOURCE_VERSION_CHANGED"
      ) {
        let refreshed = false;
        try {
          const latest = await refreshNotice();
          if (!latest || !isCurrentRequest(noticeId, generation)) return;
          refreshed = true;
          restoreEditFocusRef.current = true;
          setEditing(false);
        } catch {
          if (!isCurrentRequest(noticeId, generation)) return;
          // The message below distinguishes a failed refresh from a refreshed conflict.
        }
        setError(
          refreshed
            ? "다른 곳에서 먼저 수정되어 최신 내용을 불러왔어요. 다시 확인해 주세요."
            : "다른 곳에서 먼저 수정되었지만 최신 내용을 다시 불러오지 못했어요. 목록에서 다시 열어 주세요.",
        );
      } else if (requestError instanceof ApiRequestError && requestError.status === 401) {
        void navigate("/login", { replace: true });
      } else {
        setError(
          requestError instanceof Error ? requestError.message : "공지를 수정하지 못했습니다.",
        );
      }
    } finally {
      if (isCurrentRequest(noticeId, generation)) setSaving(false);
    }
  }

  async function submitConfirmation(): Promise<void> {
    if (
      noticeId === undefined ||
      entity?.item.id !== noticeId ||
      !isCurrentRequest(noticeId, renderedRequestGeneration)
    )
      return;
    const generation = renderedRequestGeneration;
    setConfirming(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const result = await confirmNotice(noticeId, entity.item.content_revision);
      if (!isCurrentRequest(noticeId, generation)) return;
      setEntity((current) =>
        current === undefined
          ? current
          : {
              ...current,
              item: { ...current.item, confirmation_state: result.confirmation_state },
            },
      );
      setNotice("현재 공지를 확인했습니다.");
    } catch (requestError) {
      if (!isCurrentRequest(noticeId, generation)) return;
      if (
        requestError instanceof ApiRequestError &&
        requestError.code === "CONTENT_REVISION_CHANGED"
      ) {
        let refreshed = false;
        try {
          const latest = await refreshNotice();
          if (!latest || !isCurrentRequest(noticeId, generation)) return;
          refreshed = true;
        } catch {
          if (!isCurrentRequest(noticeId, generation)) return;
          // The message below distinguishes a failed refresh from a refreshed conflict.
        }
        setError(
          refreshed
            ? "선생님이 공지 내용을 수정했어요. 최신 내용을 읽고 다시 확인해 주세요."
            : "공지 내용이 수정되었지만 최신 내용을 다시 불러오지 못했어요. 목록에서 다시 열어 주세요.",
        );
      } else if (requestError instanceof ApiRequestError && requestError.status === 401) {
        void navigate("/login", { replace: true });
      } else {
        setError(
          requestError instanceof Error ? requestError.message : "공지 확인을 저장하지 못했습니다.",
        );
      }
    } finally {
      if (isCurrentRequest(noticeId, generation)) setConfirming(false);
    }
  }

  function requestDelete(): void {
    if (
      noticeId === undefined ||
      entity?.item.id !== noticeId ||
      !isCurrentRequest(noticeId, renderedRequestGeneration)
    )
      return;
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
      noticeId === undefined ||
      entity?.item.id !== noticeId ||
      !isCurrentRequest(noticeId, renderedRequestGeneration)
    )
      return;
    const generation = renderedRequestGeneration;
    setDeleting(true);
    setError(undefined);
    setDeleteError(undefined);
    try {
      const reason = deleteReason.trim();
      const destination = noticeListPath();
      await deleteNotice(noticeId, reason === "" ? null : reason, entity.etag);
      if (!isCurrentRequest(noticeId, generation)) return;
      if (embedded && onClose) {
        onClose();
        return;
      }
      void navigate(destination, { replace: true, state: { notice: "공지를 삭제했습니다." } });
    } catch (requestError) {
      if (!isCurrentRequest(noticeId, generation)) return;
      if (
        requestError instanceof ApiRequestError &&
        requestError.code === "RESOURCE_VERSION_CHANGED"
      ) {
        let refreshed = false;
        try {
          const latest = await refreshNotice();
          if (!latest || !isCurrentRequest(noticeId, generation)) return;
          refreshed = true;
        } catch {
          if (!isCurrentRequest(noticeId, generation)) return;
          // The message below distinguishes a failed refresh from a refreshed conflict.
        }
        setDeleteError(
          refreshed
            ? "다른 곳에서 먼저 수정되어 삭제하지 않았어요. 최신 내용을 확인해 주세요."
            : "다른 곳에서 먼저 수정되어 삭제하지 않았고 최신 내용도 불러오지 못했어요. 목록에서 다시 열어 주세요.",
        );
      } else if (requestError instanceof ApiRequestError && requestError.status === 401) {
        void navigate("/login", { replace: true });
      } else {
        setDeleteError(
          requestError instanceof Error ? requestError.message : "공지를 삭제하지 못했습니다.",
        );
      }
      setDeleting(false);
      window.setTimeout(() => {
        if (isCurrentRequest(noticeId, generation)) deleteButtonRef.current?.focus();
      }, 0);
    }
  }

  if (bootstrap === undefined || entity === undefined || entity.item.id !== noticeId) {
    const detailLoading = loading || (entity !== undefined && entity.item.id !== noticeId);
    return (
      <ContentDetailFrame
        embedded={embedded}
        {...(navigationRole === undefined ? {} : { navigationRole })}
        backTo="/notices"
        backLabel="소식"
        {...(embedded || originListEntryKey !== undefined ? { onBack: returnToNoticeList } : {})}
      >
        {" "}
        {embedded ? (
          <h2 className="content-detail-title">공지</h2>
        ) : (
          <h1 className="content-detail-title">공지</h1>
        )}
        <AsyncStatePanel
          {...(detailLoading
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
                      onClick={returnToNoticeList}
                      type="button"
                    >
                      목록으로 돌아가기
                    </button>
                  </div>
                ),
                description: "이 화면에서 다시 불러오거나 공지 목록에서 다른 내용을 확인해 주세요.",
              })}
          kind={detailLoading ? "loading" : "error"}
          title={detailLoading ? "공지 내용을 불러오고 있어요." : "공지 내용을 불러오지 못했어요."}
          tone="important"
        />
      </ContentDetailFrame>
    );
  }
  const { item } = entity;
  const studentState = item.confirmation_state ?? "unread";
  const mutationBusy = saving || deleting;
  const deleteReasonLength = codePointLength(deleteReason.trim());
  return (
    <ContentDetailFrame
      embedded={embedded}
      navigationRole={teacher ? "teacher" : "student"}
      backTo={noticeListPath()}
      backLabel="소식"
      {...(embedded || originListEntryKey !== undefined ? { onBack: returnToNoticeList } : {})}
      hasActionBar
      tools={
        teacher ? (
          <>
            <button
              className="ui-button ui-button-secondary text-sm"
              disabled={mutationBusy || editing}
              onClick={() => void navigate(`/updates/reuse/notice/${item.id}`)}
              type="button"
            >
              <Copy aria-hidden="true" size={17} />새 공지로 재사용
            </button>
            <button
              aria-controls="notice-edit-panel"
              aria-expanded={editing}
              className="ui-button ui-button-secondary text-sm"
              disabled={mutationBusy}
              onClick={() => {
                setEditing(!editing);
                setError(undefined);
                setNotice(undefined);
              }}
              ref={editButtonRef}
              type="button"
            >
              <Pencil aria-hidden="true" size={17} />
              내용 수정
            </button>
            <button
              className="ui-button ui-button-secondary text-sm"
              onClick={() => {
                const target = document.getElementById("notice-confirmation-status");
                target?.scrollIntoView?.({ block: "start" });
                target?.focus();
              }}
              type="button"
            >
              받는 사람 보기
            </button>
            <button
              aria-controls={deleteControlsId}
              aria-expanded={deleteExpanded}
              aria-label="공지 삭제 옵션"
              className="ui-button ui-button-danger text-sm"
              disabled={mutationBusy}
              onClick={() => setDeleteExpanded(!deleteExpanded)}
              type="button"
            >
              <Trash2 aria-hidden="true" size={17} />
              삭제
            </button>
          </>
        ) : undefined
      }
      aside={
        teacher ? (
          <NoticeConfirmationsPanel
            contentRevision={item.content_revision}
            membershipId={bootstrap.current_membership?.id ?? ""}
            noticeId={item.id}
            onReloadContent={async () => {
              await refreshNotice();
            }}
            tone={item.is_important ? "important" : "latest"}
            title={item.title}
          />
        ) : (
          <StudentDetailActions
            target={{ id: item.id, kind: "notice" }}
            hint={
              studentState === "confirmed"
                ? "선생님께 확인 완료로 표시됐어요."
                : studentState === "modified_unconfirmed"
                  ? "선생님이 글을 고쳤어요. 다시 읽고 확인해 주세요."
                  : "내용을 읽은 뒤 확인해 주세요. 확인 기록은 되돌릴 수 없어요."
            }
          >
            <StudentNoticeConfirmation
              compact
              busy={confirming}
              onConfirm={() => void submitConfirmation()}
              state={studentState}
              tone={item.is_important ? "important" : "latest"}
            />
          </StudentDetailActions>
        )
      }
    >
      <article
        className="h-full min-w-0 rounded-[1.25rem] border border-app-border bg-app-surface p-[18px] shadow-card lg:px-8 lg:py-7"
        data-notice-surface="detail"
      >
        <DetailHeading
          title={item.title}
          kind={item.category === "performance" ? "수행평가" : "공지"}
          changed={item.content_revision !== "1"}
          meta={<time dateTime={item.published_at}>{formatNoticeDateTime(item.published_at)}</time>}
        >
          {item.is_important ? (
            <span className="rounded-lg bg-role-soft px-2 py-1 text-role-primary">중요</span>
          ) : null}
        </DetailHeading>
        <section aria-labelledby="notice-content-heading" className="mt-4">
          <h2 className="sr-only" id="notice-content-heading">
            공지 내용
          </h2>
          <p className="whitespace-pre-wrap break-words text-[15.5px] leading-[1.75] text-app-text">
            {item.content}
          </p>
        </section>
        {teacher ? (
          <dl className="mt-5 divide-y divide-app-border border-t border-app-border text-sm">
            <div className="flex justify-between gap-3 py-3">
              <dt className="text-app-muted">받는 사람</dt>
              <dd className="font-bold text-app-text">
                {item.audience_mode === "selected_snapshot" ? "선택한 학생" : "올린 때의 반 전체"}
              </dd>
            </div>
          </dl>
        ) : null}
        {teacher && editing ? (
          <section
            className={`mt-6 rounded-card border border-t-4 p-5 sm:p-6 ${
              item.is_important
                ? "border-home-important-line border-t-home-important bg-home-important-soft"
                : "border-role-border border-t-role-primary bg-role-soft"
            }`}
            id="notice-edit-panel"
          >
            <h2 className="break-keep text-xl font-extrabold text-app-text">공지 내용 수정</h2>
            <p className="mt-2 break-keep text-sm leading-6 text-app-muted">
              제목·본문을 바꾸면 재확인이 필요하고, 중요 표시만 바꾸면 기존 확인은 유지돼요.
            </p>
            <div className="mt-5">
              <NoticeForm
                busy={mutationBusy}
                initialValue={{
                  category: item.category,
                  content: item.content,
                  is_important: item.is_important,
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
            className="mt-6 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-bold text-rose-700"
            role="alert"
          >
            {error}
          </p>
        )}
        {notice === undefined ? null : (
          <p
            aria-live="polite"
            className="mt-6 flex items-start gap-2 rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-bold text-emerald-700"
            role="status"
          >
            <CheckCircle2 aria-hidden="true" className="mt-0.5 shrink-0" size={18} /> {notice}
          </p>
        )}

        {teacher ? (
          <section hidden={!deleteExpanded} className="mt-6 border-t border-app-border pt-5">
            <h2 className="text-lg font-extrabold text-app-text">공지 삭제</h2>
            <div hidden={!deleteExpanded} id={deleteControlsId}>
              <p className="mt-2 break-keep text-sm leading-6 text-app-muted">
                삭제하면 홈과 목록에서 즉시 숨겨집니다. 학생들의 기존 확인 기록은 보존됩니다.
              </p>
              <label className="auth-label mt-5" htmlFor="notice-delete-reason">
                삭제 사유 <span className="font-medium text-app-muted">(선택)</span>
              </label>
              <textarea
                aria-describedby={`${deleteReasonCountId}${deleteError === undefined ? "" : ` ${deleteReasonErrorId}`}`}
                aria-invalid={deleteReasonLength > 300 || undefined}
                className="ui-input min-h-24 resize-y py-3 leading-6"
                disabled={mutationBusy}
                id="notice-delete-reason"
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
                  className="mt-3 rounded-2xl border border-rose-200 bg-app-surface-raised px-4 py-3 text-sm font-bold text-rose-700"
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
                )}{" "}
                공지 삭제
              </button>
            </div>
          </section>
        ) : null}
      </article>
      <ConfirmDialog
        confirmLabel="공지 삭제"
        description={
          deleteReason.trim() === ""
            ? "홈과 공지 목록에서 즉시 숨겨집니다. 이 작업은 화면에서 되돌릴 수 없어요."
            : "홈과 목록에서 즉시 숨겨지며, 입력한 삭제 사유도 함께 기록됩니다."
        }
        onCancel={() => setDeleteDialogOpen(false)}
        onConfirm={() => {
          if (noticeId === undefined || !isCurrentRequest(noticeId, renderedRequestGeneration))
            return;
          const confirmedNoticeId = noticeId;
          const generation = renderedRequestGeneration;
          setDeleteDialogOpen(false);
          window.setTimeout(() => {
            if (isCurrentRequest(confirmedNoticeId, generation)) void submitDelete();
          }, 0);
        }}
        open={deleteDialogOpen}
        returnFocusTo={deleteButtonRef.current}
        title={`“${item.title}” 공지를 삭제할까요?`}
      />
    </ContentDetailFrame>
  );
}

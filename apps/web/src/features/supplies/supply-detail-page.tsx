import { CheckCircle2, Copy, LoaderCircle, Pencil, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router";

import {
  deleteSupply,
  getSupply,
  setSupplyCheck,
  updateSupply,
  type SupplyEntityResponse,
  type SupplyWriteRequest,
} from "../../api/supplies";
import { ApiRequestError, getBootstrap, type BootstrapResponse } from "../../api/auth";
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
import { StudentSupplyCheck } from "./student-supply-check";
import { SupplyChecksPanel } from "./supply-checks-panel";
import { formatSupplyDate } from "./supply-format";
import { SupplyForm } from "./supply-form";

interface SupplyDetailLocationState {
  notice?: string;
}

function locationNotice(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const notice = (value as SupplyDetailLocationState).notice;
  return typeof notice === "string" ? notice : undefined;
}

function supplyListPath(neededOn: string, serverToday: string): string {
  return neededOn < serverToday ? "/supplies?scope=past" : "/supplies";
}

const DAY_IN_MILLISECONDS = 24 * 60 * 60 * 1_000;

function isSupplyReminderEligible(neededOn: string, serverToday: string): boolean {
  const neededOnTimestamp = Date.parse(`${neededOn}T00:00:00Z`);
  const serverTodayTimestamp = Date.parse(`${serverToday}T00:00:00Z`);
  if (Number.isNaN(neededOnTimestamp) || Number.isNaN(serverTodayTimestamp)) return false;
  return neededOnTimestamp >= serverTodayTimestamp - 90 * DAY_IN_MILLISECONDS;
}

export function SupplyDetailPage({
  embeddedId,
  onClose,
}: EmbeddedDetailProps = {}): React.JSX.Element {
  const embedded = embeddedId !== undefined;
  const navigate = useNavigate();
  const location = useLocation();
  const { supplyId: routeId } = useParams<{ supplyId: string }>();
  const supplyId = embeddedId ?? routeId;
  const updatesOrigin = itemListEntryKey(location.state, "updates", `supply:${supplyId}`);
  const originListEntryKey =
    updatesOrigin ?? itemListEntryKey(location.state, "supplies", supplyId);
  const [bootstrap, setBootstrap] = useState<BootstrapResponse>();
  const [entity, setEntity] = useState<SupplyEntityResponse>();
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [checkingDesired, setCheckingDesired] = useState<boolean>();
  const [deleting, setDeleting] = useState(false);
  const [deleteReason, setDeleteReason] = useState("");
  const [deleteError, setDeleteError] = useState<string>();
  const [deletePanelOpen, setDeletePanelOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string | undefined>(() => locationNotice(location.state));
  const editButtonRef = useRef<HTMLButtonElement>(null);
  const deleteButtonRef = useRef<HTMLButtonElement>(null);
  const restoreEditFocusRef = useRef(false);
  const deletePanelId = useId();
  const deleteReasonErrorId = useId();
  const deleteReasonCountId = useId();

  useEffect(() => {
    if (!deletePanelOpen) return;
    const field = document.getElementById("supply-delete-reason");
    field?.scrollIntoView?.({ block: "center" });
    field?.focus({ preventScroll: true });
  }, [deletePanelOpen]);

  function returnToSupplyList(listPath: string): void {
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

  async function refreshSupply(): Promise<SupplyEntityResponse | undefined> {
    if (supplyId === undefined) return undefined;
    const latest = await getSupply(supplyId);
    setEntity(latest);
    return latest;
  }

  async function retryInitialLoad(): Promise<void> {
    if (supplyId === undefined) return;
    setLoading(true);
    setError(undefined);
    try {
      let result = bootstrap;
      if (result === undefined) {
        result = await getBootstrap();
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
      setEntity(await getSupply(supplyId));
    } catch (requestError) {
      if (requestError instanceof ApiRequestError && requestError.status === 401) {
        void navigate("/login", { replace: true });
        return;
      }
      setError(
        requestError instanceof Error ? requestError.message : "안내를 불러오지 못했습니다.",
      );
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (supplyId === undefined) {
      void navigate("/supplies", { replace: true });
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
        const nextEntity = await getSupply(supplyId);
        if (!active) return;
        setEntity(nextEntity);
      })
      .catch((requestError: unknown) => {
        if (!active) return;
        if (requestError instanceof ApiRequestError && requestError.status === 401) {
          void navigate("/login", { replace: true });
          return;
        }
        setError(
          requestError instanceof Error ? requestError.message : "안내를 불러오지 못했습니다.",
        );
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [navigate, supplyId]);

  useEffect(() => {
    if (editing || saving || !restoreEditFocusRef.current) return;
    restoreEditFocusRef.current = false;
    focusDetailTool(editButtonRef.current);
  }, [editing, saving]);

  const navigationRole = bootstrap?.current_membership?.role;

  async function submitUpdate(request: SupplyWriteRequest): Promise<void> {
    if (supplyId === undefined || entity === undefined) return;
    setSaving(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const updated = await updateSupply(supplyId, request, entity.etag);
      setEntity(updated);
      restoreEditFocusRef.current = true;
      setEditing(false);
      setNotice(
        updated.item.content_revision === entity.item.content_revision
          ? `변경된 내용이 없어 기존 ${kindName} 내용을 그대로 유지했습니다.`
          : `${kindName} 내용을 수정했습니다. 학생들은 최신 내용을 다시 확인하게 됩니다.`,
      );
    } catch (requestError) {
      if (
        requestError instanceof ApiRequestError &&
        requestError.code === "RESOURCE_VERSION_CHANGED"
      ) {
        let refreshed = false;
        try {
          await refreshSupply();
          refreshed = true;
          restoreEditFocusRef.current = true;
          setEditing(false);
        } catch {
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
          requestError instanceof Error
            ? requestError.message
            : `${kindName} 내용을 수정하지 못했습니다.`,
        );
      }
    } finally {
      setSaving(false);
    }
  }

  async function submitCheck(isChecked: boolean): Promise<void> {
    if (supplyId === undefined || entity === undefined) return;
    setCheckingDesired(isChecked);
    setError(undefined);
    setNotice(undefined);
    try {
      const result = await setSupplyCheck(supplyId, isChecked, entity.item.content_revision);
      setEntity((current) =>
        current === undefined
          ? current
          : { ...current, item: { ...current.item, check_state: result.check_state } },
      );
      setNotice(
        entity.item.category === "homework"
          ? isChecked
            ? "숙제를 완료한 상태로 표시했습니다."
            : "숙제를 아직 완료하지 않은 상태로 표시했습니다."
          : isChecked
            ? "챙긴 준비물로 표시했습니다."
            : "아직 챙기지 않은 상태로 표시했습니다.",
      );
    } catch (requestError) {
      if (
        requestError instanceof ApiRequestError &&
        requestError.code === "CONTENT_REVISION_CHANGED"
      ) {
        let refreshed = false;
        try {
          await refreshSupply();
          refreshed = true;
        } catch {
          // The message below distinguishes a failed refresh from a refreshed conflict.
        }
        setError(
          refreshed
            ? `선생님이 ${kindName} 내용을 수정했어요. 최신 내용을 확인하고 다시 선택해 주세요.`
            : `${kindName} 내용이 수정되었지만 최신 내용을 다시 불러오지 못했어요. 목록에서 다시 열어 주세요.`,
        );
      } else if (requestError instanceof ApiRequestError && requestError.status === 401) {
        void navigate("/login", { replace: true });
      } else {
        setError(
          requestError instanceof Error
            ? requestError.message
            : `${kindName} 상태를 저장하지 못했습니다.`,
        );
      }
    } finally {
      setCheckingDesired(undefined);
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
    if (supplyId === undefined || entity === undefined) return;
    setDeleting(true);
    setError(undefined);
    setDeleteError(undefined);
    try {
      const reason = deleteReason.trim();
      await deleteSupply(supplyId, reason === "" ? null : reason, entity.etag);
      if (embedded && onClose) {
        onClose();
        return;
      }
      const listPath =
        bootstrap === undefined
          ? "/supplies"
          : supplyListPath(entity.item.needed_on, bootstrap.server_today);
      void navigate(listPath, {
        replace: true,
        state: {
          notice: `${entity.item.category === "homework" ? "숙제를" : "준비물을"} 삭제했습니다.`,
        },
      });
    } catch (requestError) {
      if (
        requestError instanceof ApiRequestError &&
        requestError.code === "RESOURCE_VERSION_CHANGED"
      ) {
        let refreshed = false;
        try {
          await refreshSupply();
          refreshed = true;
        } catch {
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
          requestError instanceof Error
            ? requestError.message
            : `${kindName} 삭제를 완료하지 못했습니다.`,
        );
      }
      setDeleting(false);
      window.setTimeout(() => deleteButtonRef.current?.focus(), 0);
    }
  }

  if (bootstrap === undefined || entity === undefined) {
    return (
      <ContentDetailFrame
        embedded={embedded}
        {...(navigationRole === undefined ? {} : { navigationRole })}
        backTo="/supplies"
        backLabel="소식"
        {...(embedded || originListEntryKey !== undefined
          ? { onBack: () => returnToSupplyList("/supplies") }
          : {})}
      >
        {" "}
        {embedded ? (
          <h2 className="content-detail-title">준비물·숙제</h2>
        ) : (
          <h1 className="content-detail-title">준비물·숙제</h1>
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
                      onClick={() => void navigate("/supplies")}
                      type="button"
                    >
                      목록으로 돌아가기
                    </button>
                  </div>
                ),
                description:
                  "이 화면에서 다시 불러오거나 준비물·숙제 목록에서 다른 내용을 확인해 주세요.",
              })}
          kind={loading ? "loading" : "error"}
          title={loading ? "안내 내용을 불러오고 있어요." : "안내 내용을 불러오지 못했어요."}
          tone="supplies"
        />
      </ContentDetailFrame>
    );
  }
  const { item } = entity;
  // 숙제를 지울 때도 '준비물 삭제'로 보였다(총검수 B1-05).
  const kindName = item.category === "homework" ? "숙제" : "준비물";
  const listPath = supplyListPath(item.needed_on, bootstrap.server_today);
  const teacher = bootstrap.current_membership?.role === "teacher";
  const focusChecksOnLoad = teacher && !embedded && location.hash === "#supply-check-status";
  const reminderEligible = isSupplyReminderEligible(item.needed_on, bootstrap.server_today);
  const studentCheckState = item.check_state ?? "unchecked";
  const mutationBusy = saving || deleting;
  const deleteReasonLength = codePointLength(deleteReason.trim());
  return (
    <ContentDetailFrame
      embedded={embedded}
      navigationRole={teacher ? "teacher" : "student"}
      backTo={listPath}
      backLabel="소식"
      {...(embedded || originListEntryKey !== undefined
        ? { onBack: () => returnToSupplyList(listPath) }
        : {})}
      hasActionBar
      tools={
        teacher ? (
          <>
            {item.category === "homework" ? (
              <button
                className="ui-button ui-button-secondary text-sm"
                disabled={mutationBusy || editing}
                onClick={() => void navigate(`/updates/reuse/homework/${item.id}`)}
                type="button"
              >
                <Copy aria-hidden="true" size={17} />새 숙제로 재사용
              </button>
            ) : null}
            <button
              aria-controls="supply-edit-panel"
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
                const target = document.getElementById("supply-check-status");
                target?.scrollIntoView?.({ block: "start" });
                target?.focus();
              }}
              type="button"
            >
              받는 사람 보기
            </button>
            <button
              aria-controls={deletePanelId}
              aria-expanded={deletePanelOpen}
              aria-label={`${kindName} 삭제 옵션`}
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
        teacher ? (
          <SupplyChecksPanel
            category={item.category}
            contentRevision={item.content_revision}
            focusOnLoad={focusChecksOnLoad}
            membershipId={bootstrap.current_membership?.id ?? ""}
            onRefreshContent={async () => (await refreshSupply())?.item.content_revision}
            reminderEligible={reminderEligible}
            supplyId={item.id}
            title={item.title}
          />
        ) : (
          <StudentDetailActions
            target={{ id: item.id, kind: "supply" }}
            hint={
              studentCheckState === "modified_unconfirmed"
                ? "선생님이 글을 고쳤어요. 최신 내용을 읽고 상태를 다시 선택해 주세요."
                : "직접 선택한 상태만 선생님께 표시돼요. 상태는 다시 바꿀 수 있어요."
            }
          >
            <StudentSupplyCheck
              compact
              busy={checkingDesired !== undefined}
              category={item.category}
              onSet={(isChecked) => void submitCheck(isChecked)}
              pendingChecked={checkingDesired}
              state={studentCheckState}
            />
          </StudentDetailActions>
        )
      }
    >
      <article className="h-full min-w-0 rounded-[1.25rem] border border-app-border bg-app-surface p-[18px] shadow-card lg:px-8 lg:py-7">
        <DetailHeading
          title={item.title}
          kind={item.category === "homework" ? "숙제" : "준비물"}
          changed={item.content_revision !== "1"}
        />
        <section aria-labelledby="supply-description-heading" className="mt-4">
          <h2 className="sr-only" id="supply-description-heading">
            상세 설명
          </h2>
          <p className="whitespace-pre-wrap break-words text-[15.5px] leading-[1.75] text-app-text">
            {item.description ?? "별도로 등록된 설명이 없어요. 제목과 날짜를 확인해 주세요."}
          </p>
        </section>
        <dl className="mt-5 divide-y divide-app-border border-t border-app-border text-sm">
          <div className="flex justify-between gap-3 py-3">
            <dt className="text-app-muted">
              {item.category === "homework" ? "해야 하는 날" : "필요한 날"}
            </dt>
            <dd className="font-bold text-app-text">
              <time dateTime={item.needed_on}>{formatSupplyDate(item.needed_on)}</time>
            </dd>
          </div>
          {teacher ? (
            <div className="flex justify-between gap-3 py-3">
              <dt className="text-app-muted">받는 사람</dt>
              <dd className="font-bold text-app-text">
                {item.audience_mode === "selected_snapshot" ? "선택한 학생" : "올린 때의 반 전체"}
              </dd>
            </div>
          ) : null}
        </dl>
        {teacher && editing ? (
          <section
            className="mt-6 rounded-card border border-role-border border-t-4 border-t-role-primary bg-app-surface-muted p-5 sm:p-6"
            id="supply-edit-panel"
          >
            <h2 className="break-keep text-xl font-extrabold text-app-text">
              {kindName} 내용 수정
            </h2>
            <p className="mt-2 break-keep text-sm leading-6 text-app-muted">
              제목·설명·날짜가 실제로 바뀌면 학생에게 재확인이 필요해요.
            </p>
            <div className="mt-5">
              <SupplyForm
                busy={mutationBusy}
                initialValue={{
                  category: item.category,
                  description: item.description,
                  needed_on: item.needed_on,
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
            <CheckCircle2 aria-hidden="true" className="mt-0.5 shrink-0" size={18} />
            {notice}
          </p>
        )}

        {teacher ? (
          <section hidden={!deletePanelOpen} className="mt-6 border-t border-app-border pt-5">
            <h2 className="text-lg font-extrabold text-app-text">{kindName} 삭제</h2>
            <div hidden={!deletePanelOpen} id={deletePanelId}>
              <p className="mt-2 break-keep text-sm leading-6 text-app-muted">
                삭제하면 홈과 목록에서 즉시 숨겨집니다. 학생들의 기존 체크 기록은 보존됩니다.
              </p>
              <label className="auth-label mt-5 text-app-text" htmlFor="supply-delete-reason">
                삭제 사유 <span className="font-medium text-app-muted">(선택)</span>
              </label>
              <textarea
                aria-describedby={`${deleteReasonCountId}${deleteError === undefined ? "" : ` ${deleteReasonErrorId}`}`}
                aria-invalid={deleteReasonLength > 300 || undefined}
                className="ui-input min-h-24 resize-y py-3 leading-6"
                disabled={mutationBusy}
                id="supply-delete-reason"
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
                )}
                {kindName} 삭제
              </button>
            </div>
          </section>
        ) : null}
      </article>
      <ConfirmDialog
        confirmLabel={`${kindName} 삭제`}
        description={
          deleteReason.trim() === ""
            ? "홈과 준비물·숙제 목록에서 즉시 숨겨집니다. 이 작업은 화면에서 되돌릴 수 없어요."
            : "홈과 목록에서 즉시 숨겨지며, 입력한 삭제 사유도 함께 기록됩니다."
        }
        onCancel={() => setDeleteDialogOpen(false)}
        onConfirm={() => {
          setDeleteDialogOpen(false);
          window.setTimeout(() => void submitDelete(), 0);
        }}
        open={deleteDialogOpen}
        returnFocusTo={deleteButtonRef.current}
        title={`“${item.title}” ${kindName === "숙제" ? "숙제를" : "준비물을"} 삭제할까요?`}
      />
    </ContentDetailFrame>
  );
}

import { ClipboardList, LoaderCircle, MessageSquareText, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type * as React from "react";

import {
  listAdminInquiries,
  updateAdminInquiry,
  type AdminInquiry,
  type AdminInquiryStatus,
} from "../../api/admin-management";
import { adminErrorMessage, formatDateTime, LoadState, PanelFrame } from "./admin-console-shared";

export interface InquiryWorkState {
  dirtyIds: string[];
  pendingIds: string[];
}

const INQUIRY_STATUS_LABELS: Record<AdminInquiryStatus, string> = {
  closed: "종료",
  in_progress: "처리 중",
  open: "접수",
  resolved: "답변 완료",
};
function InquiryEditor({
  inquiry,
  onUpdated,
  onWorkState,
}: {
  inquiry: AdminInquiry;
  onUpdated: (inquiry: AdminInquiry) => void;
  onWorkState: (id: string, dirty: boolean, pending: boolean) => void;
}): React.JSX.Element {
  const [status, setStatus] = useState(inquiry.status);
  const [assignee, setAssignee] = useState(inquiry.assigned_admin_account_id ?? "");
  const [note, setNote] = useState(inquiry.internal_note ?? "");
  const [response, setResponse] = useState(inquiry.response ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);
  const [dirty, setDirty] = useState(false);
  const revision = useRef(0);
  const mountedRef = useRef(true);
  useLayoutEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const dirtyRef = useRef(false);
  const pendingRef = useRef(false);
  const draftRef = useRef({ status, assignee, note, response });
  const publishWork = (): void => {
    if (mountedRef.current) onWorkState(inquiry.id, dirtyRef.current, pendingRef.current);
  };
  useEffect(() => {
    onWorkState(inquiry.id, dirtyRef.current, pendingRef.current);
  }, [inquiry.id, dirty, busy, onWorkState]);
  useLayoutEffect(() => {
    if (dirtyRef.current || pendingRef.current) return;
    draftRef.current = {
      status: inquiry.status,
      assignee: inquiry.assigned_admin_account_id ?? "",
      note: inquiry.internal_note ?? "",
      response: inquiry.response ?? "",
    };
    setStatus(inquiry.status);
    setAssignee(inquiry.assigned_admin_account_id ?? "");
    setNote(inquiry.internal_note ?? "");
    setResponse(inquiry.response ?? "");
  }, [inquiry, dirty, busy]);
  function edited(change: Partial<typeof draftRef.current>): void {
    draftRef.current = { ...draftRef.current, ...change };
    dirtyRef.current = true;
    publishWork();
    revision.current += 1;
    setDirty(true);
    setSaved(false);
  }

  async function save(): Promise<void> {
    if (pendingRef.current) return;
    pendingRef.current = true;
    publishWork();
    setBusy(true);
    setError(undefined);
    setSaved(false);
    const savingRevision = revision.current;
    const savingDraft = { ...draftRef.current };
    try {
      const normalizedAssignee = savingDraft.assignee.trim();
      const currentAssignee = inquiry.assigned_admin_account_id ?? "";
      const normalizedResponse = savingDraft.response.trim();
      const responseChanged = normalizedResponse !== (inquiry.response ?? "");
      const result = await updateAdminInquiry(inquiry.id, {
        ...(normalizedAssignee === currentAssignee
          ? {}
          : {
              assigned_admin_account_id: normalizedAssignee.length > 0 ? normalizedAssignee : null,
            }),
        ...(savingDraft.note.trim().length > 0 ? { internal_note: savingDraft.note.trim() } : {}),
        ...(responseChanged && normalizedResponse.length > 0
          ? { response: normalizedResponse }
          : {}),
        status: savingDraft.status,
      });
      if (!mountedRef.current) return;
      onUpdated(result.inquiry);
      if (revision.current === savingRevision) {
        dirtyRef.current = false;
        draftRef.current = {
          status: result.inquiry.status,
          assignee: result.inquiry.assigned_admin_account_id ?? "",
          response: result.inquiry.response ?? "",
          note: result.inquiry.internal_note ?? "",
        };
        setStatus(result.inquiry.status);
        setAssignee(result.inquiry.assigned_admin_account_id ?? "");
        setResponse(result.inquiry.response ?? "");
        setNote(result.inquiry.internal_note ?? "");
        setDirty(false);
        setSaved(true);
      }
    } catch (requestError) {
      setError(adminErrorMessage(requestError, "문의 처리 내용을 저장하지 못했습니다."));
    } finally {
      pendingRef.current = false;
      publishWork();
      setBusy(false);
    }
  }

  return (
    <div className="rounded-2xl border border-app-border bg-app-surface-raised p-4 sm:p-5">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h3 className="break-words font-black text-app-text">문의: {inquiry.subject}</h3>
          <p className="mt-1 text-xs font-bold text-app-muted">
            접수 {formatDateTime(inquiry.created_at)}
          </p>
        </div>
        <span className="w-fit shrink-0 rounded-full bg-role-soft px-3 py-1.5 text-xs font-extrabold text-role-primary">
          {INQUIRY_STATUS_LABELS[inquiry.status]}
        </span>
      </div>
      <p className="mt-4 whitespace-pre-wrap break-words rounded-xl bg-app-surface-muted px-4 py-3 text-sm font-semibold leading-6 text-app-text">
        {inquiry.body}
      </p>
      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <div>
          <label className="auth-label" htmlFor={`inquiry-status-${inquiry.id}`}>
            처리 상태
          </label>
          <select
            className="ui-input ui-input-compact"
            id={`inquiry-status-${inquiry.id}`}
            onChange={(event) => {
              edited({ status: event.target.value as AdminInquiryStatus });
              setStatus(event.target.value as AdminInquiryStatus);
            }}
            value={status}
          >
            <option value="open">접수</option>
            <option value="in_progress">처리 중</option>
            <option value="resolved">답변 완료</option>
            <option value="closed">종료</option>
          </select>
        </div>
        <div>
          <label className="auth-label" htmlFor={`inquiry-assignee-${inquiry.id}`}>
            담당 관리자 ID
          </label>
          <input
            className="ui-input ui-input-compact"
            id={`inquiry-assignee-${inquiry.id}`}
            onChange={(event) => {
              edited({ assignee: event.target.value });
              setAssignee(event.target.value);
            }}
            placeholder="비워 두면 미배정"
            value={assignee}
          />
        </div>
        <div className="md:col-span-2">
          <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4">
            <label
              className="auth-label text-emerald-950"
              htmlFor={`inquiry-response-${inquiry.id}`}
            >
              답변 기록 (관리자용)
            </label>
            <textarea
              className="ui-input h-auto min-h-32 py-3"
              id={`inquiry-response-${inquiry.id}`}
              maxLength={10000}
              onChange={(event) => {
                edited({ response: event.target.value });
                setResponse(event.target.value);
              }}
              aria-describedby={`inquiry-response-help-${inquiry.id}`}
              placeholder="기존 연락수단으로 안내할 답변 내용을 기록해 주세요."
              value={response}
            />
            <p
              className="mt-2 text-xs font-bold leading-5 text-emerald-800"
              id={`inquiry-response-help-${inquiry.id}`}
            >
              저장해도 사용자에게 자동 전달되지 않습니다. 기존 연락수단으로 직접 안내해 주세요.
            </p>
            {inquiry.responded_at === null ? (
              <p className="mt-2 text-xs font-bold text-emerald-800">
                아직 저장한 답변 기록이 없습니다.
              </p>
            ) : (
              <p className="mt-2 text-xs font-bold text-emerald-800">
                최근 답변 기록 {formatDateTime(inquiry.responded_at)} · 관리자 ID{" "}
                {inquiry.responded_by_admin_account_id}
              </p>
            )}
          </div>
        </div>
        <div className="md:col-span-2">
          <div className="rounded-2xl border border-app-border bg-app-surface-muted p-4">
            <label className="auth-label" htmlFor={`inquiry-note-${inquiry.id}`}>
              내부 메모 · 사용자에게 보이지 않음
            </label>
            <textarea
              className="ui-input h-auto min-h-28 py-3"
              id={`inquiry-note-${inquiry.id}`}
              maxLength={5000}
              onChange={(event) => {
                edited({ note: event.target.value });
                setNote(event.target.value);
              }}
              placeholder="사용자에게 노출되지 않는 처리 메모"
              value={note}
            />
          </div>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          aria-busy={busy}
          className="ui-button ui-button-primary text-sm"
          disabled={busy}
          onClick={() => void save()}
          type="button"
        >
          {busy ? (
            <LoaderCircle aria-hidden="true" className="animate-spin" size={17} />
          ) : (
            <ClipboardList aria-hidden="true" size={17} />
          )}{" "}
          처리 내용 저장
        </button>
        {saved ? (
          <span className="text-sm font-bold text-emerald-700" role="status">
            저장했습니다.
          </span>
        ) : null}
      </div>
      {error === undefined ? null : (
        <p className="mt-3 text-sm font-bold text-danger-text" role="alert">
          {error}
        </p>
      )}
      {dirty && !saved ? (
        <p className="mt-2 text-xs font-bold text-app-muted" role="status">
          아직 저장하지 않은 내용이 있어요.
        </p>
      ) : null}
    </div>
  );
}

export function InquiriesPanel({
  onWorkState,
}: {
  onWorkState?: (state: InquiryWorkState) => void;
}): React.JSX.Element {
  const work = useRef(new Map<string, { dirty: boolean; pending: boolean }>());
  const reportWork = useCallback(
    (id: string, dirty: boolean, pending: boolean) => {
      work.current.set(id, { dirty, pending });
      onWorkState?.({
        dirtyIds: [...work.current].filter(([, value]) => value.dirty).map(([id]) => id),
        pendingIds: [...work.current].filter(([, value]) => value.pending).map(([id]) => id),
      });
    },
    [onWorkState],
  );
  useEffect(
    () => () => {
      onWorkState?.({ dirtyIds: [], pendingIds: [] });
    },
    [onWorkState],
  );
  const [status, setStatus] = useState<AdminInquiryStatus | "">("");
  const [inquiries, setInquiries] = useState<AdminInquiry[]>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [selectedId, setSelectedId] = useState<string>();
  const [editors, setEditors] = useState<Record<string, AdminInquiry>>({});
  const editorCache = useRef<Record<string, AdminInquiry>>({});
  const loadGeneration = useRef(0);
  const loadedStatus = useRef<AdminInquiryStatus | "" | undefined>(undefined);
  const currentStatus = useRef(status);
  currentStatus.current = status;
  const latestLoad = useRef<(() => Promise<void>) | undefined>(undefined);
  const detailHeading = useRef<HTMLHeadingElement>(null);
  const selectedByUser = useRef(false);

  const load = useCallback(async (): Promise<void> => {
    const generation = ++loadGeneration.current;
    setLoading(true);
    setError(undefined);
    try {
      const result = await listAdminInquiries(status === "" ? undefined : status);
      if (generation !== loadGeneration.current) return;
      const next = { ...editorCache.current };
      for (const inquiry of result.inquiries) next[inquiry.id] = inquiry;
      // Keep drafts for every seen ID, without allowing an indefinitely growing
      // panel. Five status views of the server's 100-row page fit this ceiling.
      if (Object.keys(next).length > 500)
        throw Error("문의 화면을 다시 열어 주세요. 작성 중인 내용은 먼저 저장해 주세요.");
      editorCache.current = next;
      setEditors(next);
      setInquiries(result.inquiries);
      loadedStatus.current = status;
      setSelectedId((current) =>
        result.inquiries.some((item) => item.id === current) ? current : result.inquiries[0]?.id,
      );
    } catch (requestError) {
      if (generation !== loadGeneration.current) return;
      setError(adminErrorMessage(requestError, "문의 목록을 불러오지 못했습니다."));
    } finally {
      if (generation === loadGeneration.current) setLoading(false);
    }
  }, [status]);
  latestLoad.current = load;

  useEffect(() => {
    void load();
    return () => {
      loadGeneration.current += 1;
    };
  }, [load]);
  useEffect(() => {
    if (selectedId === undefined || !selectedByUser.current) return;
    selectedByUser.current = false;
    detailHeading.current?.focus({ preventScroll: true });
    if (window.matchMedia?.("(max-width: 1023px)").matches)
      detailHeading.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [selectedId]);

  return (
    <PanelFrame
      description="문의의 답변 기록과 처리 상태를 관리합니다. 답변 기록은 자동 전달되지 않으며, 내부 메모와 따로 저장됩니다."
      icon={MessageSquareText}
      title="문의 관리"
    >
      <div className="mt-5 flex flex-wrap items-end gap-3">
        <div className="w-full max-w-56">
          <label className="auth-label" htmlFor="inquiry-status-filter">
            처리 상태
          </label>
          <select
            className="ui-input"
            id="inquiry-status-filter"
            onChange={(event) => setStatus(event.target.value as AdminInquiryStatus | "")}
            value={status}
          >
            <option value="">전체</option>
            <option value="open">접수</option>
            <option value="in_progress">처리 중</option>
            <option value="resolved">답변 완료</option>
            <option value="closed">종료</option>
          </select>
        </div>
        <button
          type="button"
          className="ui-button ui-button-secondary min-h-11 text-sm"
          disabled={loading}
          onClick={() => void load()}
        >
          <RefreshCw aria-hidden="true" size={17} /> 목록 새로고침
        </button>
      </div>
      <LoadState error={error} loading={loading} onRetry={() => void load()} />
      {inquiries?.length === 0 ? (
        <p className="mt-5 rounded-2xl bg-app-surface-muted px-4 py-8 text-center text-sm font-semibold text-app-muted">
          조건에 맞는 문의가 없습니다.
        </p>
      ) : null}
      {inquiries === undefined ? null : (
        <div className="mt-5 grid items-start gap-5 lg:grid-cols-[minmax(16rem,0.8fr)_minmax(0,1.6fr)]">
          <section aria-labelledby="inquiry-list-title" className="min-w-0">
            <h3 id="inquiry-list-title" className="mb-2 text-sm font-extrabold text-app-text">
              문의 목록
            </h3>
            <ul className="grid gap-2">
              {inquiries.map((inquiry) => (
                <li key={inquiry.id}>
                  <button
                    type="button"
                    aria-pressed={selectedId === inquiry.id}
                    aria-controls="inquiry-selected-detail"
                    className={`flex min-h-11 w-full flex-col gap-1 rounded-xl border p-3 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-role-primary ${selectedId === inquiry.id ? "border-role-border bg-role-soft" : "border-app-border bg-app-surface-raised"}`}
                    onClick={() => {
                      if (selectedId === inquiry.id) return;
                      selectedByUser.current = true;
                      setSelectedId(inquiry.id);
                    }}
                  >
                    <strong className="break-words text-sm text-app-text">{inquiry.subject}</strong>
                    <span className="text-xs text-app-muted">
                      {INQUIRY_STATUS_LABELS[inquiry.status]} · {formatDateTime(inquiry.created_at)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
          <section
            id="inquiry-selected-detail"
            aria-labelledby="inquiry-detail-title"
            className="min-w-0"
          >
            <h3
              id="inquiry-detail-title"
              className="mb-2 scroll-mt-24 text-sm font-extrabold text-app-text lg:scroll-mt-4"
              ref={detailHeading}
              tabIndex={-1}
            >
              선택한 문의
            </h3>
            <ul>
              {Object.values(editors).map((inquiry) => (
                <li
                  key={inquiry.id}
                  hidden={inquiry.id !== selectedId}
                  data-selected-inquiry={inquiry.id === selectedId ? inquiry.id : undefined}
                >
                  <InquiryEditor
                    inquiry={inquiry}
                    onWorkState={reportWork}
                    key={inquiry.id}
                    onUpdated={(updated) => {
                      // Reads started before this write must not replace its committed result.
                      loadGeneration.current += 1;
                      setLoading(false);
                      // A filter changed during the save still needs a fresh matching list.
                      if (loadedStatus.current !== currentStatus.current)
                        void latestLoad.current?.();
                      const next = { ...editorCache.current, [updated.id]: updated };
                      editorCache.current = next;
                      setEditors(next);
                      setInquiries((current) =>
                        current?.map((item) => (item.id === updated.id ? updated : item)),
                      );
                    }}
                  />
                </li>
              ))}
            </ul>
          </section>
        </div>
      )}
    </PanelFrame>
  );
}

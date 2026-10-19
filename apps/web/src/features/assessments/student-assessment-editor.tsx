import { Check, Cloud, CloudOff, LoaderCircle, RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";

import { useBlocker, UNSAFE_DataRouterContext, type BlockerFunction } from "react-router";

import { ApiRequestError } from "../../api/auth";
import {
  completeStudentAssessment,
  createStudentAssessment,
  deleteStudentAssessment,
  getStudentAssessment,
  getStudentAssessmentCreationContext,
  type StudentAssessmentConnectionScope,
  type StudentAssessmentCreationContext,
  type StudentAssessmentCreateRequest,
  type StudentAssessmentItem,
  type StudentAssessmentType,
  type StudentAssessmentWriteRequest,
  updateStudentAssessment,
} from "../../api/student-assessments";
import { ConfirmDialog } from "../layout/confirm-dialog";

const AUTOSAVE_DELAY_MS = 800;
const inputClassName =
  "mt-2 min-h-12 w-full rounded-2xl border border-app-border bg-app-surface-raised px-4 text-base font-bold text-app-text outline-none transition placeholder:text-app-muted/70 focus:border-role-primary focus:ring-2 focus:ring-role-primary/20 disabled:opacity-60";
const labelClassName = "block text-sm font-extrabold text-app-text";

interface AssessmentEditorFields {
  academicYear: string;
  assessmentDate: string;
  assessmentType: StudentAssessmentType;
  maxScore: string;
  memo: string;
  score: string;
  semester: "1" | "2";
  subject: string;
  title: string;
  weight: string;
}

type SaveStatus = "conflict" | "error" | "idle" | "saved" | "saving" | "waiting";

type AssessmentLeaveRequest = (action: () => void, cancel?: () => void) => Promise<void>;

function AssessmentRouteGuard({
  shouldBlock,
  requestLeave,
}: {
  shouldBlock: BlockerFunction;
  requestLeave: AssessmentLeaveRequest;
}): null {
  const blocker = useBlocker(shouldBlock);
  const requested = useRef(false);
  useEffect(() => {
    if (blocker.state !== "blocked") {
      requested.current = false;
      return;
    }
    if (requested.current) return;
    requested.current = true;
    void requestLeave(
      () => blocker.proceed(),
      () => blocker.reset(),
    );
  }, [blocker, requestLeave]);
  return null;
}

interface StudentAssessmentEditorProps {
  initialItem?: StudentAssessmentItem;
  onClose: () => void;
  onDeleted: (assessmentId: string) => void;
  onRecord: (item: StudentAssessmentItem) => void;
  onUnauthorized: () => void;
  isForcedExit?: () => boolean;
  onLeaveRequest?: (request: AssessmentLeaveRequest | undefined) => void;
  serverToday: string;
}

function academicDefaults(serverToday: string): {
  academicYear: string;
  semester: "1" | "2";
} {
  const [yearText, monthText] = serverToday.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  return {
    academicYear: String(month < 3 ? year - 1 : year),
    semester: month < 3 || month >= 9 ? "2" : "1",
  };
}

function decimalText(value: number | null, scale: number): string {
  if (value === null) return "";
  return (value / scale).toFixed(2).replace(/\.?0+$/u, "");
}

function fieldsFromItem(
  item: StudentAssessmentItem | undefined,
  serverToday: string,
): AssessmentEditorFields {
  const defaults = academicDefaults(serverToday);
  return {
    academicYear:
      item?.academic_year === null ? "" : String(item?.academic_year ?? defaults.academicYear),
    assessmentDate: item?.assessment_date ?? "",
    assessmentType: item?.assessment_type ?? "performance",
    maxScore: decimalText(item?.max_score_hundredths ?? null, 100),
    memo: item?.memo ?? "",
    score: decimalText(item?.score_hundredths ?? null, 100),
    semester: item?.semester === 2 ? "2" : item?.semester === 1 ? "1" : defaults.semester,
    subject: item?.subject ?? "",
    title: item?.title ?? "",
    weight: decimalText(item?.weight_basis_points ?? null, 100),
  };
}

function scaledInteger(value: string, scale: number): number | null {
  if (value === "") return null;
  const [whole = "0", fraction = ""] = value.split(".");
  return Number(whole) * scale + Number(fraction.padEnd(2, "0").slice(0, 2));
}

function optionalText(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function requestFromFields(fields: AssessmentEditorFields): StudentAssessmentWriteRequest {
  const academicYear = fields.academicYear === "" ? null : Number(fields.academicYear);
  const score = scaledInteger(fields.score, 100);
  const maximum = scaledInteger(fields.maxScore, 100);
  const weight = scaledInteger(fields.weight, 100);
  if (
    academicYear !== null &&
    (!Number.isSafeInteger(academicYear) || academicYear < 2020 || academicYear > 2100)
  ) {
    throw new Error("학년도는 2020년부터 2100년 사이로 입력해 주세요.");
  }
  if (score !== null && score > 100_000) {
    throw new Error("받은 점수는 1,000점 이하로 입력해 주세요.");
  }
  if (maximum !== null && (maximum < 1 || maximum > 100_000)) {
    throw new Error("만점은 0보다 크고 1,000점 이하여야 해요.");
  }
  if (score !== null && maximum !== null && score > maximum) {
    throw new Error("받은 점수는 만점보다 클 수 없어요.");
  }
  if (weight !== null && (weight < 1 || weight > 10_000)) {
    throw new Error("반영 비율은 0보다 크고 100% 이하여야 해요.");
  }
  return {
    academic_year: academicYear,
    assessment_date: fields.assessmentDate === "" ? null : fields.assessmentDate,
    assessment_type: fields.assessmentType,
    max_score_hundredths: maximum,
    memo: optionalText(fields.memo),
    score_hundredths: score,
    semester: Number(fields.semester),
    subject: optionalText(fields.subject),
    title: optionalText(fields.title),
    weight_basis_points: weight,
  };
}

function decimalInputAllowed(value: string): boolean {
  return /^\d{0,4}(?:\.\d{0,2})?$/u.test(value);
}

function statusContent(status: SaveStatus): {
  icon: typeof Cloud;
  message: string;
  tone: string;
} {
  if (status === "saving") {
    return { icon: LoaderCircle, message: "서버에 저장 중", tone: "text-role-primary" };
  }
  if (status === "waiting") {
    return { icon: Cloud, message: "입력 중 · 곧 자동 저장", tone: "text-app-muted" };
  }
  if (status === "saved") {
    return { icon: Check, message: "서버에 저장됐어요", tone: "text-emerald-700" };
  }
  if (status === "conflict") {
    return { icon: RefreshCw, message: "다른 화면의 저장과 겹쳤어요", tone: "text-amber-700" };
  }
  if (status === "error") {
    return { icon: CloudOff, message: "저장하지 못했어요", tone: "text-danger" };
  }
  return { icon: Cloud, message: "수정하면 서버에 자동 저장돼요", tone: "text-app-muted" };
}

export function StudentAssessmentEditor({
  initialItem,
  onClose,
  onDeleted,
  onRecord,
  onUnauthorized,
  isForcedExit,
  onLeaveRequest,
  serverToday,
}: StudentAssessmentEditorProps): React.JSX.Element {
  const [fields, setFields] = useState(() => fieldsFromItem(initialItem, serverToday));
  const [item, setItem] = useState(initialItem);
  const [status, setStatus] = useState<SaveStatus>("idle");
  const [message, setMessage] = useState<string>();
  const [saveErrorFocusRequest, setSaveErrorFocusRequest] = useState(0);
  const [closing, setClosing] = useState(false);
  const [completing, setCompleting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [creationContext, setCreationContext] = useState<StudentAssessmentCreationContext>();
  const [contextState, setContextState] = useState<
    "loading" | "available" | "unavailable" | "error"
  >("loading");
  const contextGenerationRef = useRef(0);
  const [choiceFocusRequest, setChoiceFocusRequest] = useState(0);
  const storageChoiceRef = useRef<HTMLSelectElement>(null);
  const scopeConfirmedRef = useRef(initialItem !== undefined);
  const [scopeConfirmed, setScopeConfirmed] = useState(initialItem !== undefined);
  const [connectionScope, setConnectionScope] =
    useState<StudentAssessmentConnectionScope>("personal");
  const connectionScopeRef = useRef<StudentAssessmentConnectionScope>("personal");
  const [connectionLocked, setConnectionLocked] = useState(initialItem !== undefined);
  const classContextChangedRef = useRef(false);
  const [classContextChanged, setClassContextChanged] = useState(false);
  const fieldsRef = useRef(fields);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const saveErrorRef = useRef<HTMLDivElement>(null);
  const itemRef = useRef(initialItem);
  const etagRef = useRef(initialItem ? `"${initialItem.row_version}"` : undefined);
  const createKeyRef = useRef(crypto.randomUUID());
  const pendingCreateRef = useRef<
    | {
        request: StudentAssessmentCreateRequest;
        revision: number;
      }
    | undefined
  >(undefined);
  const revisionRef = useRef(0);
  const savedRevisionRef = useRef(0);
  const timerRef = useRef<number | undefined>(undefined);
  const saveTailRef = useRef<Promise<void>>(Promise.resolve());
  const mountedRef = useRef(true);
  const forcedExitRef = useRef(false);
  const forcedExitCheckRef = useRef(isForcedExit);
  forcedExitCheckRef.current = isForcedExit;
  const leavingRef = useRef(false);
  const latestFlushRef = useRef(flushLatest);
  latestFlushRef.current = flushLatest;
  const dataRouter = useContext(UNSAFE_DataRouterContext);
  const handleUnauthorized = useCallback(() => {
    if (!mountedRef.current || forcedExitRef.current || forcedExitCheckRef.current?.()) return;
    forcedExitRef.current = true;
    onUnauthorized();
  }, [onUnauthorized]);
  const shouldBlock = useCallback<BlockerFunction>(
    ({ currentLocation, nextLocation, historyAction }) => {
      if (
        forcedExitRef.current ||
        forcedExitCheckRef.current?.() ||
        revisionRef.current <= savedRevisionRef.current
      )
        return false;
      // 첫 저장의 주소 교체는 같은 편집기와 남은 입력을 유지하므로 허용한다.
      if (
        historyAction === "REPLACE" &&
        currentLocation.pathname === "/assessments" &&
        new URLSearchParams(currentLocation.search).get("new") === "1" &&
        nextLocation.pathname === "/assessments" &&
        itemRef.current !== undefined &&
        nextLocation.search === "?edit=" + encodeURIComponent(itemRef.current.id) &&
        nextLocation.hash === ""
      )
        return false;
      return true;
    },
    [],
  );
  useEffect(() => {
    const unload = (event: BeforeUnloadEvent) => {
      if (
        forcedExitRef.current ||
        forcedExitCheckRef.current?.() ||
        revisionRef.current <= savedRevisionRef.current
      )
        return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", unload);
    return () => window.removeEventListener("beforeunload", unload);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    titleRef.current?.focus();
    return () => {
      mountedRef.current = false;
      if (timerRef.current !== undefined) window.clearTimeout(timerRef.current);
    };
  }, []);

  async function loadCreationContext(): Promise<void> {
    const generation = ++contextGenerationRef.current;
    setContextState("loading");
    try {
      const context = await getStudentAssessmentCreationContext();
      if (!mountedRef.current || generation !== contextGenerationRef.current) return;
      if (
        context?.class_connection_available === true &&
        typeof context.current_class?.id === "string" &&
        context.current_class.id.length > 0 &&
        typeof context.current_class.name === "string" &&
        context.current_class.name.length > 0
      ) {
        setCreationContext(context);
        setContextState("available");
      } else {
        setCreationContext(undefined);
        setContextState("unavailable");
      }
    } catch (error) {
      if (!mountedRef.current || generation !== contextGenerationRef.current) return;
      setCreationContext(undefined);
      setContextState("error");
      if (error instanceof ApiRequestError && error.status === 401) handleUnauthorized();
    }
  }
  useEffect(() => {
    if (initialItem === undefined) void loadCreationContext();
    return () => {
      contextGenerationRef.current += 1;
    };
  }, []);

  function confirmStorageChoice(personal = false): void {
    if (connectionLocked || scopeConfirmedRef.current || contextState === "loading") return;
    if (personal) {
      connectionScopeRef.current = "personal";
      setConnectionScope("personal");
    }
    scopeConfirmedRef.current = true;
    setScopeConfirmed(true);
    setMessage(undefined);
    if (revisionRef.current > savedRevisionRef.current) void enqueueLatest().catch(() => undefined);
  }

  function clearTimer(): void {
    if (timerRef.current === undefined) return;
    window.clearTimeout(timerRef.current);
    timerRef.current = undefined;
  }

  async function persistSnapshot(
    snapshot: AssessmentEditorFields,
    revision: number,
  ): Promise<StudentAssessmentItem> {
    if (itemRef.current === undefined && !scopeConfirmedRef.current)
      throw new Error("보관 방식을 확인하고 저장 시작을 눌러 주세요.");
    if (classContextChangedRef.current) {
      throw new Error("현재 반이 바뀌었어요. 보관 방식을 확인하고 다시 저장해 주세요.");
    }
    if (mountedRef.current) {
      setStatus("saving");
      setMessage(undefined);
    }
    try {
      const request = requestFromFields(snapshot);
      const current = itemRef.current;
      let savedRevision = revision;
      let response;
      if (current === undefined) {
        setConnectionLocked(true);
        pendingCreateRef.current ??= {
          request: {
            ...request,
            ...(connectionScopeRef.current === "current_class"
              ? {
                  connection_scope: "current_class" as const,
                  expected_class_id: creationContext!.current_class!.id,
                }
              : {}),
          },
          revision,
        };
        const pendingCreate = pendingCreateRef.current;
        response = await createStudentAssessment(pendingCreate.request, createKeyRef.current);
        savedRevision = pendingCreate.revision;
        pendingCreateRef.current = undefined;
      } else {
        response = await updateStudentAssessment(
          current.id,
          request,
          etagRef.current ?? `"${current.row_version}"`,
        );
      }
      itemRef.current = response.item;
      etagRef.current = response.etag;
      savedRevisionRef.current = Math.max(savedRevisionRef.current, savedRevision);
      if (mountedRef.current && !forcedExitRef.current && !forcedExitCheckRef.current?.()) {
        setItem(response.item);
        setStatus(revisionRef.current <= savedRevisionRef.current ? "saved" : "waiting");
        onRecord(response.item);
      }
      return response.item;
    } catch (error) {
      if (
        itemRef.current === undefined &&
        error instanceof ApiRequestError &&
        error.status > 0 &&
        error.status < 500
      ) {
        pendingCreateRef.current = undefined;
        createKeyRef.current = crypto.randomUUID();
        setConnectionLocked(false);
      }
      if (
        itemRef.current === undefined &&
        error instanceof ApiRequestError &&
        error.status === 409 &&
        error.code === "ASSESSMENT_CLASS_CONTEXT_CHANGED"
      ) {
        classContextChangedRef.current = true;
        setClassContextChanged(true);
        connectionScopeRef.current = "personal";
        setConnectionScope("personal");
        setCreationContext(undefined);
        void loadCreationContext();
      }
      if (error instanceof ApiRequestError && error.status === 401) handleUnauthorized();
      if (mountedRef.current) {
        setStatus(
          error instanceof ApiRequestError && error.code === "RESOURCE_VERSION_CHANGED"
            ? "conflict"
            : "error",
        );
        setMessage(
          classContextChangedRef.current
            ? "현재 반이 바뀌었어요. 입력은 보존했어요. 보관 방식을 확인하고 다시 저장해 주세요."
            : error instanceof Error
              ? error.message
              : "서버에 저장하지 못했어요.",
        );
      }
      throw error;
    }
  }

  function enqueueLatest(): Promise<StudentAssessmentItem | undefined> {
    clearTimer();
    const revision = revisionRef.current;
    if (revision <= savedRevisionRef.current) return Promise.resolve(itemRef.current);
    const snapshot = fieldsRef.current;
    const task = saveTailRef.current.then(() => persistSnapshot(snapshot, revision));
    saveTailRef.current = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  function scheduleSave(): void {
    clearTimer();
    if (!scopeConfirmedRef.current) return;
    timerRef.current = window.setTimeout(() => {
      timerRef.current = undefined;
      void enqueueLatest().catch(() => undefined);
    }, AUTOSAVE_DELAY_MS);
  }

  function updateField<Key extends keyof AssessmentEditorFields>(
    key: Key,
    value: AssessmentEditorFields[Key],
  ): void {
    const next = { ...fieldsRef.current, [key]: value };
    fieldsRef.current = next;
    setFields(next);
    revisionRef.current += 1;
    if (classContextChangedRef.current) return;
    setStatus("waiting");
    setMessage(undefined);
    scheduleSave();
  }

  async function flushLatest(): Promise<StudentAssessmentItem | undefined> {
    clearTimer();
    await saveTailRef.current;
    if (
      itemRef.current === undefined &&
      !scopeConfirmedRef.current &&
      revisionRef.current > savedRevisionRef.current
    ) {
      setMessage("입력은 그대로 있어요. 보관 방식을 확인하고 저장 시작을 눌러 주세요.");
      setChoiceFocusRequest((value) => value + 1);
      throw new Error("보관 방식을 확인하고 저장 시작을 눌러 주세요.");
    }
    while (revisionRef.current > savedRevisionRef.current) {
      await enqueueLatest();
      await saveTailRef.current;
    }
    return itemRef.current;
  }

  const requestLeave = useCallback<AssessmentLeaveRequest>(async (action, cancel) => {
    if (forcedExitRef.current || forcedExitCheckRef.current?.()) {
      action();
      return;
    }
    if (leavingRef.current) {
      cancel?.();
      return;
    }
    if (classContextChangedRef.current) {
      cancel?.();
      saveErrorRef.current?.focus();
      return;
    }
    leavingRef.current = true;
    setClosing(true);
    setMessage(undefined);
    try {
      await latestFlushRef.current();
      if (!forcedExitRef.current && !forcedExitCheckRef.current?.() && mountedRef.current) action();
    } catch (error) {
      cancel?.();
      if (!forcedExitRef.current && !forcedExitCheckRef.current?.() && mountedRef.current) {
        setStatus(
          error instanceof ApiRequestError && error.code === "RESOURCE_VERSION_CHANGED"
            ? "conflict"
            : "error",
        );
        setMessage(
          error instanceof Error
            ? error.message
            : "입력 내용을 저장하지 못했어요. 입력은 그대로 있어요.",
        );
        if (scopeConfirmedRef.current) setSaveErrorFocusRequest((value) => value + 1);
      }
    } finally {
      leavingRef.current = false;
      if (mountedRef.current) setClosing(false);
    }
  }, []);
  useEffect(() => {
    onLeaveRequest?.(requestLeave);
    return () => onLeaveRequest?.(undefined);
  }, [onLeaveRequest, requestLeave]);

  async function closeWithDraft(): Promise<void> {
    if (classContextChangedRef.current) {
      saveErrorRef.current?.focus();
      return;
    }
    setClosing(true);
    setMessage(undefined);
    try {
      await flushLatest();
      if (mountedRef.current && !forcedExitRef.current && !forcedExitCheckRef.current?.())
        onClose();
    } catch {
      // 보관 방식이 미확정이면 기존 선택 항목 초점을 유지한다.
      if (
        mountedRef.current &&
        !forcedExitRef.current &&
        !forcedExitCheckRef.current?.() &&
        scopeConfirmedRef.current
      ) {
        setSaveErrorFocusRequest((value) => value + 1);
      }
      setClosing(false);
    }
  }

  async function completeRecord(): Promise<void> {
    if (classContextChangedRef.current) {
      saveErrorRef.current?.focus();
      return;
    }
    setCompleting(true);
    setMessage(undefined);
    try {
      const saved = await flushLatest();
      if (saved === undefined) throw new Error("먼저 평가 내용을 입력해 주세요.");
      const response = await completeStudentAssessment(
        saved.id,
        etagRef.current ?? `"${saved.row_version}"`,
      );
      if (!mountedRef.current || forcedExitRef.current || forcedExitCheckRef.current?.()) return;
      itemRef.current = response.item;
      etagRef.current = response.etag;
      setItem(response.item);
      setStatus("saved");
      onRecord(response.item);
    } catch (error) {
      if (error instanceof ApiRequestError && error.status === 401) handleUnauthorized();
      setStatus("error");
      setMessage(error instanceof Error ? error.message : "기록을 완료하지 못했어요.");
      if (
        mountedRef.current &&
        !forcedExitRef.current &&
        !forcedExitCheckRef.current?.() &&
        (scopeConfirmedRef.current || revisionRef.current <= savedRevisionRef.current)
      ) {
        setSaveErrorFocusRequest((value) => value + 1);
      }
    } finally {
      if (mountedRef.current) setCompleting(false);
    }
  }

  async function resolveConflict(): Promise<void> {
    const current = itemRef.current;
    if (current === undefined) {
      void enqueueLatest().catch(() => undefined);
      return;
    }
    setStatus("saving");
    setMessage(undefined);
    try {
      const latest = await getStudentAssessment(current.id);
      itemRef.current = latest.item;
      etagRef.current = latest.etag;
      setItem(latest.item);
      revisionRef.current += 1;
      await enqueueLatest();
    } catch (error) {
      if (error instanceof ApiRequestError && error.status === 401) handleUnauthorized();
      setStatus("error");
      setMessage(error instanceof Error ? error.message : "최신 기록을 확인하지 못했어요.");
    }
  }

  async function confirmDelete(): Promise<void> {
    const current = itemRef.current;
    if (current === undefined) return;
    clearTimer();
    setDeleteDialogOpen(false);
    setDeleting(true);
    setMessage(undefined);
    await saveTailRef.current;
    try {
      await deleteStudentAssessment(current.id, etagRef.current ?? `"${current.row_version}"`);
      if (mountedRef.current && !forcedExitRef.current && !forcedExitCheckRef.current?.())
        onDeleted(current.id);
    } catch (error) {
      if (error instanceof ApiRequestError && error.status === 401) handleUnauthorized();
      setStatus("error");
      setMessage(error instanceof Error ? error.message : "평가 기록을 삭제하지 못했어요.");
      setDeleting(false);
    }
  }

  const busy = closing || completing || deleting;
  useLayoutEffect(() => {
    if (choiceFocusRequest > 0 && !busy) storageChoiceRef.current?.focus();
  }, [choiceFocusRequest, busy]);
  useLayoutEffect(() => {
    // 자동 저장은 입력 초점을 유지하고, 직접 요청한 동작의 실패만 오류로 안내한다.
    if (saveErrorFocusRequest > 0 && !busy && message !== undefined) {
      saveErrorRef.current?.focus();
      setSaveErrorFocusRequest(0);
    }
  }, [saveErrorFocusRequest, busy, message]);
  const saveStatus = statusContent(status);
  const SaveIcon = saveStatus.icon;

  return (
    <section
      aria-labelledby="assessment-editor-title"
      className="min-w-0 rounded-shell border border-app-border bg-app-surface p-5 shadow-card sm:p-7"
      data-assessment-editor={item?.status ?? "new"}
    >
      {dataRouter === null ? null : (
        <AssessmentRouteGuard shouldBlock={shouldBlock} requestLeave={requestLeave} />
      )}
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm font-extrabold text-role-primary">
            {item?.status === "recorded"
              ? "완료한 기록 수정"
              : item === undefined
                ? "새 평가 기록"
                : "작성 중인 초안"}
          </p>
          <h2
            className="mt-1 break-keep text-2xl font-black tracking-[-0.035em] text-app-text"
            id="assessment-editor-title"
            ref={titleRef}
            tabIndex={-1}
          >
            내 점수를 차근차근 기록해요
          </h2>
          <p className="mt-2 break-keep text-sm leading-6 text-app-muted">
            학교 공식 성적표가 아닌 나만의 기록이에요. 반 친구나 선생님에게 공개되지 않아요.
          </p>
        </div>
      </div>

      <div
        className="sticky top-2 z-20 mt-5 rounded-2xl border border-app-border bg-app-surface p-3 shadow-card"
        data-assessment-toolbar="true"
      >
        <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between sm:gap-3">
          <span
            aria-live="polite"
            className={`inline-flex min-h-8 min-w-0 items-center gap-2 self-start rounded-full bg-app-canvas px-3 text-xs font-extrabold sm:min-h-10 sm:text-sm ${saveStatus.tone}`}
            data-assessment-save-status={status}
          >
            <SaveIcon
              aria-hidden="true"
              className={status === "saving" ? "animate-spin" : undefined}
              size={16}
            />
            {item === undefined && !scopeConfirmed
              ? "보관 방식 확인 후 자동 저장"
              : saveStatus.message}
          </span>
          <div
            className={`grid w-full gap-2 ${item?.status === "recorded" ? "grid-cols-1" : "grid-cols-2"} sm:flex sm:w-auto`}
          >
            <button
              aria-label={item?.status === "recorded" ? "닫기 · 기록 유지" : "닫기 · 초안 유지"}
              className="ui-button ui-button-secondary min-h-12 px-3 text-sm"
              disabled={busy}
              onClick={() => void closeWithDraft()}
              type="button"
            >
              {closing ? (
                <LoaderCircle aria-hidden="true" className="animate-spin" size={17} />
              ) : null}
              <span aria-hidden="true" className="sm:hidden">
                닫기
              </span>
              <span aria-hidden="true" className="hidden sm:inline">
                {item?.status === "recorded" ? "닫기 · 기록 유지" : "닫기 · 초안 유지"}
              </span>
            </button>
            {item?.status === "recorded" ? null : (
              <button
                className="ui-button ui-button-primary min-h-12 px-3 text-sm"
                disabled={busy}
                onClick={() => void completeRecord()}
                type="button"
              >
                {completing ? (
                  <LoaderCircle aria-hidden="true" className="animate-spin" size={17} />
                ) : (
                  <Check aria-hidden="true" size={17} />
                )}
                기록 완료
              </button>
            )}
          </div>
        </div>
      </div>
      <p className="mt-2 text-xs leading-5 text-app-muted">
        {item === undefined && !scopeConfirmed
          ? "입력한 내용은 보관 방식을 확인한 뒤 저장할 수 있어요. 내용이 없으면 바로 닫을 수 있어요."
          : "목록으로 돌아갈 때도 입력을 먼저 저장해요. 완료 여부는 서버에서 확인해요."}
      </p>

      {message === undefined ? null : (
        <div
          className="mt-4 rounded-2xl border border-danger-border bg-danger-surface px-4 py-3 text-sm font-bold text-danger-text"
          ref={saveErrorRef}
          role="alert"
          tabIndex={-1}
        >
          <p>{message}</p>
          {status === "conflict" ? (
            <button
              className="mt-3 inline-flex min-h-10 items-center gap-2 rounded-xl border border-amber-300 bg-app-surface-raised px-3 text-sm font-extrabold text-amber-800"
              onClick={() => void resolveConflict()}
              type="button"
            >
              <RefreshCw aria-hidden="true" size={16} />
              최신 버전 위에 내 입력 다시 저장
            </button>
          ) : item === undefined && !scopeConfirmed && !classContextChanged ? null : (
            <button
              className="mt-3 inline-flex min-h-10 items-center gap-2 rounded-xl border border-danger-border bg-app-surface-raised px-3 text-sm font-extrabold text-danger-text"
              disabled={classContextChanged && contextState === "loading"}
              onClick={() => {
                if (classContextChangedRef.current && contextState === "loading") return;
                classContextChangedRef.current = false;
                setClassContextChanged(false);
                void enqueueLatest().catch(() => undefined);
              }}
              type="button"
            >
              <RefreshCw aria-hidden="true" size={16} />
              {classContextChanged ? "선택한 보관 방식으로 다시 저장" : "저장 다시 시도"}
            </button>
          )}
        </div>
      )}

      <fieldset className="mt-6 grid gap-5 sm:grid-cols-2" disabled={busy}>
        <legend className="sr-only">평가 기록 입력</legend>
        <div className="sm:col-span-2">
          <h3 className="text-lg font-black text-app-text">1. 평가 계획</h3>
          <p className="mt-1 text-sm leading-6 text-app-muted">
            보관 방식과 어떤 평가인지 먼저 정해요. 점수는 나중에 입력해도 초안으로 저장할 수 있어요.
          </p>
        </div>
        <div className="min-w-0 sm:col-span-2">
          {item === undefined ? (
            <>
              <label className={labelClassName} htmlFor="assessment-connection-scope">
                기록 보관 방식
              </label>
              <select
                aria-describedby="assessment-connection-help"
                className={inputClassName}
                disabled={connectionLocked}
                ref={storageChoiceRef}
                id="assessment-connection-scope"
                onChange={(event) => {
                  const next =
                    event.target.value === "current_class" ? "current_class" : "personal";
                  if (
                    next === "current_class" &&
                    !(creationContext?.class_connection_available && creationContext.current_class)
                  )
                    return;
                  connectionScopeRef.current = next;
                  setConnectionScope(next);
                  if (!classContextChangedRef.current) {
                    scopeConfirmedRef.current = false;
                    setScopeConfirmed(false);
                    clearTimer();
                  }
                }}
                value={connectionScope}
              >
                <option value="personal">개인 기록</option>
                {creationContext?.class_connection_available && creationContext.current_class ? (
                  <option value="current_class">
                    현재 반에 연결 · {creationContext.current_class.name}
                  </option>
                ) : null}
              </select>
              <p className="mt-2 text-sm leading-6 text-app-muted" id="assessment-connection-help">
                {connectionScope === "current_class"
                  ? "반의 보관기한과 기록의 개별 보관기한 중 먼저 끝나는 기한이 적용돼요. 선생님과 다른 학생에게 공개되지 않아요."
                  : "개인 기록은 기존 개별 보관기한이 적용돼요."}{" "}
                선택만으로 저장되지 않으며, 첫 저장 후에는 보관 방식을 바꿀 수 없어요.
              </p>
              {contextState === "loading" ? (
                <p className="mt-2 text-sm text-app-muted" role="status">
                  보관 방식을 확인하고 있어요. 입력은 할 수 있으며 아직 저장되지 않아요.
                </p>
              ) : contextState === "error" ? (
                <div className="mt-2">
                  <p className="text-sm text-danger" role="alert">
                    반 연결 가능 여부를 확인하지 못했어요. 입력은 그대로 있어요.
                  </p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <button
                      type="button"
                      className="ui-button ui-button-secondary min-h-11 text-sm"
                      disabled={connectionLocked}
                      onClick={() => void loadCreationContext()}
                    >
                      보관 방식 다시 확인
                    </button>
                    {!scopeConfirmed && (
                      <button
                        type="button"
                        className="ui-button ui-button-primary min-h-11 text-sm"
                        onClick={() => confirmStorageChoice(true)}
                      >
                        개인 기록으로 저장 시작
                      </button>
                    )}
                  </div>
                </div>
              ) : (
                <div className="mt-2">
                  {contextState === "unavailable" && (
                    <p className="text-xs leading-5 text-app-muted">
                      현재 반 연결은 사용할 수 없어요. 개인 기록은 저장할 수 있어요.
                    </p>
                  )}
                  {!scopeConfirmed && (
                    <button
                      type="button"
                      className="ui-button ui-button-primary mt-2 min-h-11 text-sm"
                      onClick={() => confirmStorageChoice()}
                    >
                      이 보관 방식으로 저장 시작
                    </button>
                  )}
                </div>
              )}
              {!scopeConfirmed && (
                <p className="mt-2 text-xs leading-5 text-app-muted">
                  저장 시작을 누르면 입력한 내용부터 저장하고 이후 수정은 자동 저장해요.
                </p>
              )}
            </>
          ) : (
            <p className="text-sm font-bold leading-6 text-app-muted">
              {item.connection_scope === "current_class"
                ? `반 연결 기록 · ${item.class_name ?? "연결한 반"}`
                : item.connection_scope === "personal"
                  ? "개인 기록"
                  : "평가 기록"}
              {" · "}보관 방식은 바꿀 수 없어요.
            </p>
          )}
        </div>
        <label className={labelClassName}>
          학년도
          <input
            className={inputClassName}
            inputMode="numeric"
            maxLength={4}
            onChange={(event) => {
              if (/^\d{0,4}$/u.test(event.target.value)) {
                updateField("academicYear", event.target.value);
              }
            }}
            placeholder="2026"
            value={fields.academicYear}
          />
        </label>
        <label className={labelClassName}>
          학기
          <select
            className={inputClassName}
            onChange={(event) => updateField("semester", event.target.value === "2" ? "2" : "1")}
            value={fields.semester}
          >
            <option value="1">1학기</option>
            <option value="2">2학기</option>
          </select>
        </label>
        <label className={labelClassName}>
          평가 구분
          <select
            className={inputClassName}
            onChange={(event) =>
              updateField(
                "assessmentType",
                event.target.value === "written" ? "written" : "performance",
              )
            }
            value={fields.assessmentType}
          >
            <option value="performance">수행평가</option>
            <option value="written">지필평가</option>
          </select>
        </label>
        <label className={labelClassName}>
          평가일
          <input
            className={inputClassName}
            onChange={(event) => updateField("assessmentDate", event.target.value)}
            type="date"
            value={fields.assessmentDate}
          />
        </label>
        <label className={labelClassName}>
          과목
          <input
            className={inputClassName}
            maxLength={30}
            onChange={(event) => updateField("subject", event.target.value)}
            placeholder="예: 수학"
            value={fields.subject}
          />
        </label>
        <label className={labelClassName}>
          평가명
          <input
            className={inputClassName}
            maxLength={100}
            onChange={(event) => updateField("title", event.target.value)}
            placeholder="예: 주제 탐구 발표"
            value={fields.title}
          />
        </label>
        <div className="border-t border-app-border pt-5 sm:col-span-2">
          <h3 className="text-lg font-black text-app-text">2. 결과 기록</h3>
          <p className="mt-1 text-sm leading-6 text-app-muted">
            받은 점수와 만점을 적고, 필요한 경우 반영 비율과 메모를 남겨요.
          </p>
        </div>
        <label className={labelClassName}>
          받은 점수
          <input
            className={inputClassName}
            inputMode="decimal"
            onChange={(event) => {
              if (decimalInputAllowed(event.target.value)) {
                updateField("score", event.target.value);
              }
            }}
            placeholder="예: 92.5"
            value={fields.score}
          />
        </label>
        <label className={labelClassName}>
          만점
          <input
            className={inputClassName}
            inputMode="decimal"
            onChange={(event) => {
              if (decimalInputAllowed(event.target.value)) {
                updateField("maxScore", event.target.value);
              }
            }}
            placeholder="예: 100"
            value={fields.maxScore}
          />
        </label>
        <label className={labelClassName}>
          반영 비율 <span className="font-bold text-app-muted">(선택)</span>
          <span className="relative block">
            <input
              className={`${inputClassName} pr-12`}
              inputMode="decimal"
              onChange={(event) => {
                if (decimalInputAllowed(event.target.value)) {
                  updateField("weight", event.target.value);
                }
              }}
              placeholder="예: 30"
              value={fields.weight}
            />
            <span className="pointer-events-none absolute right-4 top-1/2 mt-1 -translate-y-1/2 font-extrabold text-app-muted">
              %
            </span>
          </span>
        </label>
        <label className={`${labelClassName} sm:col-span-2`}>
          메모 <span className="font-bold text-app-muted">(선택)</span>
          <textarea
            className={`${inputClassName} min-h-28 resize-y py-3 leading-6`}
            maxLength={500}
            onChange={(event) => updateField("memo", event.target.value)}
            placeholder="다음 평가에서 기억하고 싶은 점을 적어 보세요."
            value={fields.memo}
          />
        </label>
      </fieldset>

      <div
        className="mt-5 border-t border-app-border pt-5"
        aria-labelledby="assessment-completion-help"
      >
        <h3 className="text-sm font-black text-app-text" id="assessment-completion-help">
          기록 완료 전에 확인해요
        </h3>
        <p className="mt-2 text-sm leading-6 text-app-muted">
          학년도·학기·평가 구분·과목·평가명·평가일·받은 점수·만점이 필요해요. 날짜는 학년도에 맞고,
          받은 점수는 만점 이하여야 해요. 반영 비율과 메모는 선택이에요.
        </p>
        <p className="mt-2 text-sm font-bold text-app-muted">
          {item?.status === "recorded"
            ? "이미 완료한 기록이에요. 수정한 내용은 자동 저장돼요."
            : "아직 초안이에요. 자동 저장과 기록 완료는 별개예요."}
        </p>
      </div>

      <p className="mt-5 rounded-2xl bg-app-canvas px-4 py-3 text-sm font-bold leading-6 text-app-muted">
        {item === undefined && !scopeConfirmed
          ? "입력이 있으면 보관 방식을 확인한 뒤 닫아 주세요."
          : "닫을 때도 마지막 입력을 먼저 저장해요."}{" "}
        {item?.connection_scope === "current_class" ||
        (item === undefined && connectionScope === "current_class")
          ? "연결한 반의 보관기한과 기록의 개별 보관기한 중 먼저 끝나는 기한이 적용돼요."
          : item === undefined || item.connection_scope === "personal"
            ? "초안은 마지막 저장 후 30일, 완료 기록은 완료한 날부터 1년 동안 보관돼요."
            : "보관 만료일은 서버에서 확인한 날짜를 표시해요."}
        {item
          ? ` 현재 보관 만료: ${new Date(item.expires_at).toLocaleDateString("ko-KR", { timeZone: "Asia/Seoul" })}`
          : ""}
      </p>

      <div className="mt-6 flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          {item === undefined ? null : (
            <button
              className="ui-button ui-button-danger text-sm"
              disabled={busy}
              onClick={() => setDeleteDialogOpen(true)}
              type="button"
            >
              <Trash2 aria-hidden="true" size={17} />
              기록 삭제
            </button>
          )}
        </div>
      </div>

      <ConfirmDialog
        confirmLabel={deleting ? "삭제 중" : "평가 기록 삭제"}
        description="이 기록은 즉시 삭제되며 화면에서 복구할 수 없어요."
        onCancel={() => setDeleteDialogOpen(false)}
        onConfirm={() => void confirmDelete()}
        open={deleteDialogOpen}
        title="이 평가 기록을 삭제할까요?"
      />
    </section>
  );
}

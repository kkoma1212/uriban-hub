import {
  Download,
  FileText,
  LoaderCircle,
  LockKeyhole,
  NotebookPen,
  Plus,
  RefreshCw,
} from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";

import { ApiRequestError, getBootstrap, type BootstrapResponse } from "../../api/auth";
import {
  exportStudentAssessmentsCsv,
  listStudentAssessments,
  type StudentAssessmentItem,
} from "../../api/student-assessments";
import { AppShell } from "../layout/app-shell";
import { saveBlobAsFile } from "../../lib/save-blob";
import { ContentFrameBody, ContentFrameHeader } from "../layout/content-frame";
import { studentOnlyAccessRedirect } from "../layout/access-redirect-notice";
// 편집 화면은 열 때만 받는다. 목록에서는 편집·자동저장 코드를 내려받지 않는다.
const StudentAssessmentEditor = lazy(() =>
  import("./student-assessment-editor").then((module) => ({
    default: module.StudentAssessmentEditor,
  })),
);

type EditorTarget =
  | { kind: "new"; sessionKey: string }
  | { item: StudentAssessmentItem; kind: "item"; sessionKey: string };

const KOREAN_DATE = new Intl.DateTimeFormat("ko-KR", {
  day: "numeric",
  month: "short",
  // 시간대를 고정하지 않으면 KST 밖 기기에서 평가 날짜가 하루 밀려 보인다.
  timeZone: "Asia/Seoul",
  year: "numeric",
});

function dateLabel(value: string | null): string {
  if (value === null) return "날짜 미입력";
  return KOREAN_DATE.format(new Date(`${value}T00:00:00+09:00`));
}

function expiryLabel(value: string): string {
  return KOREAN_DATE.format(new Date(value));
}

function scoreLabel(item: StudentAssessmentItem): string {
  if (item.score_hundredths === null || item.max_score_hundredths === null) {
    return "점수 미입력";
  }
  const score = (item.score_hundredths / 100).toFixed(2).replace(/\.?0+$/u, "");
  const maximum = (item.max_score_hundredths / 100).toFixed(2).replace(/\.?0+$/u, "");
  return `${score} / ${maximum}점`;
}

function assessmentTypeLabel(item: StudentAssessmentItem): string {
  if (item.assessment_type === "performance") return "수행평가";
  if (item.assessment_type === "written") return "지필평가";
  return "구분 미입력";
}

function sortItems(items: StudentAssessmentItem[]): StudentAssessmentItem[] {
  return [...items].sort((left, right) => {
    if (left.status !== right.status) return left.status === "draft" ? -1 : 1;
    return right.updated_at.localeCompare(left.updated_at);
  });
}

function AssessmentCard({
  item,
  onEdit,
}: {
  item: StudentAssessmentItem;
  onEdit: () => void;
}): React.JSX.Element {
  return (
    <article
      className="rounded-card border border-app-border bg-app-surface-raised p-5 shadow-sm"
      data-assessment-card={item.status}
    >
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <span
            className={`inline-flex rounded-full px-2.5 py-1 text-xs font-extrabold ${
              item.status === "draft"
                ? "bg-amber-100 text-amber-800"
                : "bg-emerald-100 text-emerald-800"
            }`}
          >
            {item.status === "draft" ? "작성 중" : "기록 완료"}
          </span>
          <h3 className="mt-3 break-words text-lg font-black tracking-[-0.025em] text-app-text">
            {item.title ?? "제목 없는 평가"}
          </h3>
          <p className="mt-1 text-sm font-bold text-app-muted">
            {item.subject ?? "과목 미입력"} · {assessmentTypeLabel(item)}
          </p>
        </div>
        <button
          className="inline-flex min-h-11 shrink-0 items-center rounded-2xl border border-app-border bg-app-surface px-3 text-sm font-extrabold text-role-primary transition hover:bg-role-soft"
          onClick={onEdit}
          type="button"
        >
          {item.status === "draft" ? "계속 작성" : "확인·수정"}
        </button>
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-3 rounded-2xl bg-app-canvas p-4 text-sm">
        <div className="min-w-0">
          <dt className="font-bold text-app-muted">평가일</dt>
          <dd className="mt-1 font-extrabold text-app-text">
            {item.assessment_date === null ? (
              "날짜 미입력"
            ) : (
              <time
                aria-label={dateLabel(item.assessment_date)}
                className="whitespace-nowrap tabular-nums"
                dateTime={item.assessment_date}
              >
                {item.assessment_date.replaceAll("-", ".")}
              </time>
            )}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="font-bold text-app-muted">내 점수</dt>
          <dd className="mt-1 break-words font-extrabold text-app-text">{scoreLabel(item)}</dd>
        </div>
      </dl>
      <p className="mt-3 text-xs font-bold text-app-muted">
        {item.connection_scope === "current_class"
          ? `반 연결 · ${item.class_name ?? "연결한 반"} · `
          : item.connection_scope === "personal"
            ? "개인 기록 · "
            : ""}
        {item.status === "draft"
          ? `초안 만료 ${expiryLabel(item.expires_at)}`
          : `보관 만료 ${expiryLabel(item.expires_at)}`}
      </p>
    </article>
  );
}

export function StudentAssessmentsPage(): React.JSX.Element {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [bootstrap, setBootstrap] = useState<BootstrapResponse>();
  const [items, setItems] = useState<StudentAssessmentItem[]>();
  const [serverToday, setServerToday] = useState<string>();
  const [editor, setEditor] = useState<EditorTarget>();
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string>();
  const [loadAttempt, setLoadAttempt] = useState(0);
  const leaveRequestRef = useRef<
    ((action: () => void, cancel?: () => void) => Promise<void>) | undefined
  >(undefined);
  const forcedExitRef = useRef(false);
  const isForcedExit = useCallback(() => forcedExitRef.current, []);
  const leaveForLogin = useCallback(() => {
    forcedExitRef.current = true;
    void navigate("/login", { replace: true });
  }, [navigate]);
  const registerLeaveRequest = useCallback((request: typeof leaveRequestRef.current) => {
    leaveRequestRef.current = request;
  }, []);
  function requestEditorNavigation(action: () => void): void {
    if (leaveRequestRef.current) void leaveRequestRef.current(action);
    else action();
  }

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(undefined);
    try {
      const nextBootstrap = await getBootstrap();
      const redirect = studentOnlyAccessRedirect(nextBootstrap);
      if (redirect !== null) {
        void navigate(redirect.path, {
          replace: true,
          ...("state" in redirect ? { state: redirect.state } : {}),
        });
        return;
      }
      // 학생 역할 확인은 목록 요청과 따로 남긴다 — 목록이 실패해도 오류 화면이 학생 메뉴를 잃지 않게(검수 F-02).
      setBootstrap(nextBootstrap);
      const result = await listStudentAssessments();
      setItems(sortItems(result.items));
      setServerToday(result.server_today);
    } catch (requestError) {
      if (requestError instanceof ApiRequestError && requestError.status === 401) {
        leaveForLogin();
        return;
      }
      setError(
        requestError instanceof Error
          ? requestError.message
          : "나의 평가 기록을 불러오지 못했어요.",
      );
    } finally {
      setLoading(false);
    }
  }, [navigate, leaveForLogin]);

  useEffect(() => {
    void load();
  }, [load, loadAttempt]);

  useEffect(() => {
    if (items === undefined) return;
    if (searchParams.get("new") === "1") {
      setEditor((current) =>
        current?.kind === "new" ? current : { kind: "new", sessionKey: crypto.randomUUID() },
      );
      return;
    }
    const editId = searchParams.get("edit");
    if (editId !== null) {
      const matching = items.find((item) => item.id === editId);
      if (matching !== undefined) {
        setEditor((current) =>
          current?.kind === "item" && current.item.id === matching.id
            ? { ...current, item: matching }
            : current?.kind === "new"
              ? { item: matching, kind: "item", sessionKey: current.sessionKey }
              : { item: matching, kind: "item", sessionKey: `item-${matching.id}` },
        );
        return;
      }
    }
    setEditor(undefined);
  }, [items, searchParams]);

  const drafts = useMemo(() => items?.filter((item) => item.status === "draft") ?? [], [items]);
  const recorded = useMemo(
    () => items?.filter((item) => item.status === "recorded") ?? [],
    [items],
  );

  function openNew(): void {
    requestEditorNavigation(() => {
      void navigate("/assessments?new=1");
    });
  }

  function openItem(item: StudentAssessmentItem): void {
    requestEditorNavigation(() => {
      void navigate(`/assessments?edit=${encodeURIComponent(item.id)}`);
    });
  }

  function closeEditor(): void {
    setEditor(undefined);
    void navigate("/assessments", { replace: true });
  }

  function upsertItem(item: StudentAssessmentItem): void {
    setItems((current) =>
      sortItems([...(current ?? []).filter((candidate) => candidate.id !== item.id), item]),
    );
    if (editor?.kind === "new") {
      // 주소 전환이 끝날 때 기존 효과가 같은 편집 세션을 item으로 바꾼다.
      // 여기서 먼저 바꾸면 아직 new=1인 효과가 새 편집기를 만들어 입력을 지운다.
      void navigate(`/assessments?edit=${encodeURIComponent(item.id)}`, { replace: true });
    }
  }

  function removeItem(assessmentId: string): void {
    setItems((current) => current?.filter((item) => item.id !== assessmentId));
    closeEditor();
  }

  async function exportCsv(): Promise<void> {
    setExporting(true);
    setError(undefined);
    try {
      saveBlobAsFile(await exportStudentAssessmentsCsv(), "나의-평가.csv");
    } catch (requestError) {
      if (requestError instanceof ApiRequestError && requestError.status === 401) {
        leaveForLogin();
        return;
      }
      setError(requestError instanceof Error ? requestError.message : "CSV를 내려받지 못했어요.");
    } finally {
      setExporting(false);
    }
  }

  if (bootstrap === undefined || items === undefined || serverToday === undefined) {
    return (
      <AppShell
        alignedFrame
        contentFrame
        {...(bootstrap === undefined ? {} : { navigationRole: "student" as const })}
        width="wide"
      >
        <ContentFrameHeader title="평가 기록" />
        <ContentFrameBody>
          <div className="mt-6 text-center" role={loading ? "status" : "alert"}>
            {loading ? (
              <LoaderCircle
                aria-hidden="true"
                className="mx-auto animate-spin text-role-primary"
                size={34}
              />
            ) : (
              <NotebookPen aria-hidden="true" className="mx-auto text-danger" size={34} />
            )}
            <p className="mt-4 font-extrabold text-app-text">
              {loading ? "나의 평가 기록을 준비하고 있어요." : error}
            </p>
            {loading ? null : (
              <button
                className="ui-button ui-button-primary mt-5 text-sm"
                onClick={() => setLoadAttempt((attempt) => attempt + 1)}
                type="button"
              >
                <RefreshCw aria-hidden="true" size={17} />
                다시 시도
              </button>
            )}
          </div>
        </ContentFrameBody>
      </AppShell>
    );
  }

  return (
    // 다른 탭과 같은 정렬 틀·제목 줄(2026-09-30 사용자 지적: 이 화면만 경로 줄·큰 머리글로 시작선이 달랐다).
    <AppShell alignedFrame contentFrame navigationRole="student" width="wide">
      <ContentFrameHeader
        actions={
          <button className="ui-button ui-button-primary text-sm" onClick={openNew} type="button">
            <Plus aria-hidden="true" size={18} />
            평가 기록 추가
          </button>
        }
        title="평가 기록"
      />
      <ContentFrameBody>
        <p className="mb-4 flex items-start gap-2 text-sm leading-6 text-app-muted">
          <LockKeyhole aria-hidden="true" className="mt-1 shrink-0" size={16} />
          <span>
            <strong className="font-bold text-app-text">학생 본인만 보는 비공개 기록</strong>이에요.
            수행평가와 지필평가 점수를 직접 기록하고 돌아볼 수 있어요. 공식 성적표나 성적 예측
            기능은 아니며, 선생님과 다른 학생에게 공개되지 않아요.
          </span>
        </p>

        {error === undefined ? null : (
          <p
            className="mt-4 rounded-2xl border border-danger-border bg-danger-surface px-4 py-3 text-sm font-bold text-danger-text"
            role="alert"
          >
            {error}
          </p>
        )}

        <div
          className={
            editor === undefined
              ? ""
              : "mt-6 grid min-w-0 items-start gap-6 lg:grid-cols-[minmax(0,1.28fr)_minmax(18rem,0.72fr)]"
          }
          data-assessment-layout={editor === undefined ? "list" : "split"}
        >
          {editor === undefined ? null : (
            <Suspense
              fallback={
                <section
                  aria-busy="true"
                  aria-label="평가 편집 화면"
                  className="min-h-64 min-w-0 rounded-shell border border-app-border bg-app-surface p-5 shadow-card sm:p-7"
                >
                  <p className="flex items-center gap-2 font-bold text-app-text" role="status">
                    <LoaderCircle aria-hidden="true" className="animate-spin" size={18} />
                    평가 편집 화면을 준비하고 있어요.
                  </p>
                  <button
                    className="ui-button ui-button-secondary mt-5 text-sm"
                    onClick={closeEditor}
                    type="button"
                  >
                    목록으로 돌아가기
                  </button>
                </section>
              }
            >
              <StudentAssessmentEditor
                key={editor.sessionKey}
                onClose={closeEditor}
                onLeaveRequest={registerLeaveRequest}
                onDeleted={removeItem}
                onRecord={upsertItem}
                onUnauthorized={leaveForLogin}
                isForcedExit={isForcedExit}
                serverToday={serverToday}
                {...(editor.kind === "item" ? { initialItem: editor.item } : {})}
              />
            </Suspense>
          )}

          <section
            className={`${editor === undefined ? "mt-6" : ""} min-w-0 rounded-shell border border-app-border bg-app-surface p-5 shadow-card sm:p-7`}
            aria-label="내 평가 기록 목록"
            data-assessment-list
          >
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-4">
              <div>
                <p className="text-sm font-extrabold text-role-primary">내 기록</p>
                <h2 className="mt-1 text-2xl font-black tracking-[-0.03em] text-app-text">
                  초안 {drafts.length}개 · 완료 {recorded.length}개
                </h2>
              </div>
              <button
                className="ui-button ui-button-secondary text-sm"
                disabled={exporting || recorded.length === 0}
                onClick={() => void exportCsv()}
                type="button"
              >
                {exporting ? (
                  <LoaderCircle aria-hidden="true" className="animate-spin" size={17} />
                ) : (
                  <Download aria-hidden="true" size={17} />
                )}
                완료 기록 CSV
              </button>
            </div>

            {drafts.length === 0 && recorded.length === 0 ? (
              <div className="mt-6 rounded-card border border-dashed border-app-border bg-app-canvas px-5 py-10 text-center">
                <FileText aria-hidden="true" className="mx-auto text-app-muted" size={32} />
                <p className="mt-3 font-extrabold text-app-text">아직 기록한 평가가 없어요.</p>
                <p className="mt-1 text-sm font-medium text-app-muted">
                  첫 수행평가부터 가볍게 기록해 보세요.
                </p>
              </div>
            ) : (
              <div className={`mt-6 grid gap-6 ${editor === undefined ? "lg:grid-cols-2" : ""}`}>
                <section aria-labelledby="assessment-drafts-title">
                  <h3 className="text-lg font-black text-app-text" id="assessment-drafts-title">
                    작성 중인 초안
                  </h3>
                  {drafts.length === 0 ? (
                    <p className="mt-3 rounded-2xl bg-app-canvas px-4 py-5 text-sm font-bold text-app-muted">
                      작성 중인 초안이 없어요.
                    </p>
                  ) : (
                    <div className="mt-3 grid gap-3">
                      {drafts.map((item) => (
                        <AssessmentCard item={item} key={item.id} onEdit={() => openItem(item)} />
                      ))}
                    </div>
                  )}
                </section>
                <section aria-labelledby="assessment-recorded-title">
                  <h3 className="text-lg font-black text-app-text" id="assessment-recorded-title">
                    완료한 기록
                  </h3>
                  {recorded.length === 0 ? (
                    <p className="mt-3 rounded-2xl bg-app-canvas px-4 py-5 text-sm font-bold text-app-muted">
                      완료한 평가 기록이 없어요.
                    </p>
                  ) : (
                    <div className="mt-3 grid gap-3">
                      {recorded.map((item) => (
                        <AssessmentCard item={item} key={item.id} onEdit={() => openItem(item)} />
                      ))}
                    </div>
                  )}
                </section>
              </div>
            )}
          </section>
        </div>
      </ContentFrameBody>
    </AppShell>
  );
}

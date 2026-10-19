import { ArrowLeft, CheckCheck, Link2, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { ApiRequestError, getBootstrap } from "../../api/auth";
import { getScheduleLinks, replaceScheduleLinks, type ScheduleLinks } from "../../api/schedules";
import { AppShell, AppShellBar } from "../layout/app-shell";
import { AsyncStatePanel } from "../layout/async-state";
import { PageHeader } from "../layout/page-header";
import { getReviewSource } from "./change-review-api";
import {
  makeReviewPlan,
  makeReviewRow,
  readReviewPlan,
  reviewRowKey,
  type ReviewPlan,
} from "./change-review-model";
import { ChangeReviewPicker } from "./change-review-picker";
import { ChangeReviewRow } from "./change-review-row";
import { useChangeReview } from "./use-change-review";
import { teacherOnlyAccessRedirect } from "../layout/access-redirect-notice";

// 검토 화면은 한 번에 안내 8개까지 다룬다(일정 행 포함 9행). 저장 연결이 이보다 많으면 여기서 덮어쓰지 않는다.
const MAX_REVIEW_LINKS = 8;

function linkKeys(links: ScheduleLinks): string[] {
  return [
    ...links.notices.map((notice) => `notice:${notice.id}`),
    ...links.supplies.map((supply) => `supply:${supply.id}`),
  ];
}

function sameKeys(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((key) => right.includes(key));
}

function LinkSaver({
  initialLinks,
  plan,
  disabled,
}: {
  initialLinks: string[] | undefined;
  plan: ReviewPlan;
  disabled: boolean;
}): React.JSX.Element {
  const [saved, setSaved] = useState(initialLinks),
    [saving, setSaving] = useState(false),
    [message, setMessage] = useState<string>();
  const selected = plan.rows.slice(1).map((row) => reviewRowKey(row.source));
  const blocked =
    saved === undefined
      ? "저장된 연결을 불러오지 못해 지금은 연결을 저장할 수 없어요."
      : saved.length > MAX_REVIEW_LINKS
        ? `이 일정에는 안내가 ${saved.length}개 연결돼 있어 이 화면(최대 ${MAX_REVIEW_LINKS}개)에서는 연결을 바꿀 수 없어요.`
        : undefined;
  const changed = saved !== undefined && !sameKeys(saved, selected);
  async function save(): Promise<void> {
    setSaving(true);
    setMessage(undefined);
    try {
      const result = await replaceScheduleLinks(
        plan.scheduleId,
        selected.filter((key) => key.startsWith("notice:")).map((key) => key.slice(7)),
        selected.filter((key) => key.startsWith("supply:")).map((key) => key.slice(7)),
      );
      const keys = linkKeys(result);
      setSaved(keys);
      setMessage(
        keys.length === 0
          ? "일정의 관련 안내 연결을 모두 해제했어요."
          : `일정에 관련 안내 ${keys.length}개를 연결했어요. 일정 화면에서 학생도 볼 수 있어요.`,
      );
    } catch (failure) {
      setMessage(failure instanceof Error ? failure.message : "연결을 저장하지 못했어요.");
    } finally {
      setSaving(false);
    }
  }
  return (
    <section
      aria-label="일정 연결 저장"
      className="rounded-card border border-app-border bg-app-surface-raised p-5"
    >
      <h2 className="text-lg font-extrabold text-app-text">일정에 연결로 남기기</h2>
      <p className="mt-2 break-keep text-sm leading-6 text-app-muted">
        위 목록의 안내를 이 일정의 ‘관련 안내’로 저장하면 다음 검토에도 미리 채워지고, 일정 화면에서
        학생에게도 보여요(학생에게 공개된 안내만). 저장하지 않으면 이번 검토에만 쓰여요.
      </p>
      {blocked === undefined ? null : (
        <p className="mt-3 break-keep text-sm font-bold text-app-text">{blocked}</p>
      )}
      {message === undefined ? null : (
        <p className="mt-3 break-keep text-sm font-bold text-role-primary" role="status">
          {message}
        </p>
      )}
      <button
        aria-busy={saving}
        className="ui-button ui-button-secondary mt-4 min-h-12"
        disabled={disabled || saving || blocked !== undefined || !changed}
        onClick={() => void save()}
        type="button"
      >
        <Link2 aria-hidden="true" size={17} />
        {saving ? "저장 중" : changed ? `연결 ${selected.length}개 저장` : "저장된 연결과 같아요"}
      </button>
    </section>
  );
}

function ReviewEditor({
  initial,
  initialLinks,
}: {
  initial: ReviewPlan;
  initialLinks: string[] | undefined;
}): React.JSX.Element {
  const review = useChangeReview(initial),
    errorRef = useRef<HTMLParagraphElement>(null),
    plan = review.plan,
    root = plan.rows[0];
  useEffect(() => {
    if (review.error !== undefined) {
      errorRef.current?.focus();
      errorRef.current?.scrollIntoView({ block: "center" });
    }
  }, [review.error]);
  const remaining = plan.rows.filter(
    (row) => row.decision === "change" && row.status !== "done",
  ).length;
  const done = plan.rows.filter((row) => row.status === "done").length,
    kept = plan.rows.filter((row) => row.decision === "keep").length;
  return (
    <div className="mt-5 grid min-w-0 gap-5" data-change-review-editor>
      <section className="rounded-card border border-role-border bg-role-soft p-5">
        <h2 className="text-lg font-extrabold text-app-text">
          {review.complete
            ? "검토한 변경을 모두 반영했어요"
            : plan.started
              ? "적용 진행 상태"
              : "변경·유지·학생 영향을 함께 검토해요"}
        </h2>
        <p className="mt-2 break-keep text-sm leading-6 text-app-text">
          일정부터 선택한 안내 순서대로 반영합니다. 중간에 멈추면 완료된 변경을 확인하고 남은 항목을
          이어서 적용할 수 있어요.
        </p>
        <p className="mt-2 break-keep text-xs leading-5 text-app-muted">
          작성 내용은 이번 검토용으로 이 탭에만 저장돼요. 안내 목록은 아래 ‘연결 저장’을 눌러야
          일정에 남습니다.
        </p>
        {plan.started || done > 0 ? (
          <p className="mt-3 font-bold text-role-primary" role="status">
            적용 완료 {done}개 · 유지 {kept}개 · 남은 변경 {remaining}개
          </p>
        ) : null}
      </section>
      {review.saveFailed ? (
        <p
          className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm font-bold leading-6 text-rose-700"
          role="alert"
        >
          검토 내용을 저장하지 못했어요. 저장을 확인할 때까지 적용을 시작하지 않습니다. 작성 내용을
          보관한 뒤 다시 확인해 주세요.
        </p>
      ) : null}
      {review.error === undefined ? null : (
        <p
          className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm font-bold leading-6 text-rose-700"
          ref={errorRef}
          role="alert"
          tabIndex={-1}
        >
          {review.error}
        </p>
      )}
      {plan.rows.map((row) => (
        <ChangeReviewRow
          impact={review.impacts[reviewRowKey(row.source)]}
          key={reviewRowKey(row.source)}
          locked={review.busy || plan.started}
          onChange={(change) => review.editRow(reviewRowKey(row.source), change)}
          onRemove={() => review.removeRow(reviewRowKey(row.source))}
          proposedDate={root?.draft.date ?? ""}
          row={row}
          scheduleDate={root?.source.date ?? ""}
        />
      ))}
      {plan.started || review.complete ? null : (
        <ChangeReviewPicker
          disabled={review.busy}
          onAdd={(kind, id) => void review.addRow(kind, id)}
          selected={plan.rows.map((row) => reviewRowKey(row.source))}
        />
      )}
      <LinkSaver disabled={review.busy} initialLinks={initialLinks} plan={plan} />
      <section
        aria-label="검토 및 적용"
        className="rounded-card border border-app-border bg-app-surface-raised p-5"
      >
        {review.reviewed && !review.complete ? (
          <p className="mb-4 break-keep text-sm font-bold leading-6 text-app-text">
            선택한 변경 {remaining}개와 유지 {kept}개를 검토했어요. 적용하면 변경된
            공지·준비물·숙제의 기존 확인 학생에게 다시 확인이 필요해집니다.
          </p>
        ) : null}
        <div className="flex flex-wrap gap-3">
          <Link
            className="ui-button ui-button-secondary min-h-12"
            to={`/schedules/${plan.scheduleId}`}
          >
            <ArrowLeft aria-hidden="true" size={17} />
            일정으로
          </Link>
          {review.complete ? (
            <button
              className="ui-button ui-button-primary min-h-12"
              disabled={review.busy}
              onClick={() => void review.startNew()}
              type="button"
            >
              새 검토 시작
            </button>
          ) : (
            <>
              <button
                aria-busy={review.busy}
                className="ui-button ui-button-primary min-h-12"
                disabled={review.busy}
                onClick={() => void (review.reviewed ? review.apply() : review.review())}
                type="button"
              >
                {review.reviewed ? (
                  <CheckCheck aria-hidden="true" size={18} />
                ) : (
                  <RefreshCw aria-hidden="true" size={18} />
                )}
                {review.busy
                  ? "확인 중"
                  : review.reviewed
                    ? `${done > 0 ? "남은" : "검토한"} ${remaining}개 변경 적용`
                    : plan.started
                      ? "적용 결과 다시 확인"
                      : "변경 영향 확인"}
              </button>
              {review.error === undefined ? null : (
                <button
                  className="ui-button ui-button-secondary min-h-12"
                  disabled={review.busy || plan.rows.some((row) => row.status === "unknown")}
                  onClick={() => void review.refreshSources()}
                  type="button"
                >
                  최신 원본으로 다시 검토
                </button>
              )}
              {plan.started && review.error !== undefined ? (
                <button
                  className="ui-button ui-button-secondary min-h-12"
                  disabled={review.busy || plan.rows.some((row) => row.status === "unknown")}
                  onClick={() => void review.startNew()}
                  type="button"
                >
                  현재 일정에서 새 검토
                </button>
              ) : null}
            </>
          )}
        </div>
      </section>
    </div>
  );
}

export function ScheduleChangeReviewPage(): React.JSX.Element {
  const { scheduleId } = useParams(),
    navigate = useNavigate();
  const [plan, setPlan] = useState<ReviewPlan>(),
    [savedLinks, setSavedLinks] = useState<string[]>(),
    [error, setError] = useState<string>(),
    [role, setRole] = useState<"teacher" | "student">(),
    [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setPlan(undefined);
    setError(undefined);
    void (async () => {
      if (scheduleId === undefined || !/^[1-9][0-9]{0,18}$/u.test(scheduleId))
        throw new Error("변경할 일정을 확인해 주세요.");
      const bootstrap = await getBootstrap(),
        member = bootstrap.current_membership;
      if (!active) return;
      setRole(member?.role);
      // 막다른 오류 화면 대신 공통 교사 전용 처리(총검수 B2-05).
      const accessRedirect = teacherOnlyAccessRedirect(bootstrap);
      if (accessRedirect !== null) {
        void navigate(accessRedirect.path, {
          replace: true,
          ...(accessRedirect.path === "/home" ? { state: accessRedirect.state } : {}),
        });
        return;
      }
      if (
        bootstrap.destination !== "HOME" ||
        member?.role !== "teacher" ||
        member.status !== "approved" ||
        !bootstrap.allowed_actions.includes("MANAGE_CLASS")
      )
        throw new Error("이 반의 선생님만 관련 안내의 변경을 검토할 수 있어요.");
      const source = await getReviewSource("schedule", scheduleId);
      const saved = readReviewPlan(member.id, scheduleId);
      if (saved !== undefined)
        await Promise.all(
          saved.rows.slice(1).map((row) => getReviewSource(row.source.kind, row.source.id)),
        );
      // 연결을 못 읽어도 검토 자체는 막지 않는다. 저장만 막는다(빈 연결로 덮어쓰지 않게).
      const links = await getScheduleLinks(scheduleId).catch(() => undefined);
      const keys = links === undefined ? undefined : linkKeys(links);
      let next = saved ?? makeReviewPlan(member.id, source);
      if (saved === undefined && keys !== undefined && keys.length <= MAX_REVIEW_LINKS) {
        const rows = await Promise.all(
          keys.map(async (key) => {
            const [kind, id] = key.split(":") as ["notice" | "supply", string];
            return makeReviewRow(await getReviewSource(kind, id));
          }),
        );
        next = { ...next, rows: [...next.rows, ...rows] };
      }
      if (active) {
        setSavedLinks(keys);
        setPlan(next);
      }
    })().catch((failure: unknown) => {
      if (!active) return;
      if (failure instanceof ApiRequestError && failure.status === 401) {
        void navigate("/login", { replace: true });
        return;
      }
      setError(failure instanceof Error ? failure.message : "검토할 내용을 불러오지 못했어요.");
    });
    return () => {
      active = false;
    };
  }, [attempt, navigate, scheduleId]);
  return (
    <AppShell {...(role === undefined ? {} : { navigationRole: role })} width="wide">
      <AppShellBar
        backLabel="일정으로"
        backTo={scheduleId === undefined ? "/schedules" : `/schedules/${scheduleId}`}
        brandTo="/home"
        context="변경 영향 검토"
      />
      <PageHeader
        eyebrow="일정과 관련 안내"
        title="변경 영향 검토"
        description="행사 날짜가 바뀔 때 변경할 안내와 유지할 마감일을 함께 확인해 주세요."
      />
      {plan === undefined ? (
        <AsyncStatePanel
          {...(error === undefined
            ? {}
            : {
                description: error,
                action: (
                  <button
                    className="ui-button ui-button-secondary"
                    onClick={() => setAttempt((value) => value + 1)}
                    type="button"
                  >
                    다시 확인
                  </button>
                ),
              })}
          kind={error === undefined ? "loading" : "error"}
          title={
            error === undefined ? "검토할 내용을 확인하고 있어요" : "변경 검토를 시작할 수 없어요"
          }
        />
      ) : (
        <ReviewEditor
          initial={plan}
          initialLinks={savedLinks}
          key={`${plan.membershipId}:${plan.scheduleId}`}
        />
      )}
    </AppShell>
  );
}

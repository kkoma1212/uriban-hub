import { Copy, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { ApiRequestError, getBootstrap } from "../../api/auth";
import { createNotice, getNotice, type NoticeWriteRequest } from "../../api/notices";
import { createSupply, getSupply, type SupplyWriteRequest } from "../../api/supplies";
import { listUpdates } from "../../api/updates";
import { useIdempotentContentCreate } from "../../lib/use-idempotent-content-create";
import { AppShell, AppShellBar } from "../layout/app-shell";
import { AsyncStatePanel } from "../layout/async-state";
import { PageHeader } from "../layout/page-header";
import { NoticeForm } from "../notices/notice-form";
import { SupplyForm } from "../supplies/supply-form";
import {
  isHomeworkReuseRequest,
  isNoticeReuseRequest,
  readReuseDraft,
  type ReuseKind,
  type ReuseWriteRequest,
} from "./content-reuse-draft";
import { teacherOnlyAccessRedirect } from "../layout/access-redirect-notice";

interface ReuseSource {
  id: string;
  kind: ReuseKind;
  initialValue: ReuseWriteRequest;
}
interface LoadedReuse {
  membershipId: string;
  selectedAudienceEnabled: boolean;
  serverToday: string;
  source: ReuseSource;
}

function sourcePath(source: Pick<ReuseSource, "id" | "kind">): string {
  return `/${source.kind === "notice" ? "notices" : "supplies"}/${source.id}`;
}

function ReuseEditor({
  membershipId,
  selectedAudienceEnabled,
  serverToday,
  source,
}: LoadedReuse): React.JSX.Element {
  const navigate = useNavigate();
  const storageKey = `classhub:content-reuse:v1:${membershipId}:${source.kind}:${source.id}`;
  const [draft, setDraft] = useState(
    () => readReuseDraft(storageKey, source.kind) ?? source.initialValue,
  );
  const [saveFailed, setSaveFailed] = useState(false);
  const completed = useRef(false);
  const kindLabel = source.kind === "notice" ? "공지" : "숙제";
  const persistDraft = useCallback(
    (request: ReuseWriteRequest) => {
      if (completed.current) return;
      setDraft(request);
      try {
        window.sessionStorage.setItem(storageKey, JSON.stringify(request));
        setSaveFailed(false);
      } catch {
        setSaveFailed(true);
      }
    },
    [storageKey],
  );
  const create = useIdempotentContentCreate<ReuseWriteRequest>({
    actionLabel: `새 ${kindLabel} 등록 요청`,
    create: (request, key) =>
      source.kind === "notice"
        ? createNotice(request as NoticeWriteRequest, key)
        : createSupply(request as SupplyWriteRequest, key),
    isRequest: source.kind === "notice" ? isNoticeReuseRequest : isHomeworkReuseRequest,
    membershipId,
    onCreated: (id) => {
      completed.current = true;
      try {
        window.sessionStorage.removeItem(storageKey);
      } catch {
        /* A completed draft cannot submit without a new reviewed action. */
      }
      void navigate(`/${source.kind === "notice" ? "notices" : "supplies"}/${id}`, {
        replace: true,
        state: { notice: `새 ${kindLabel}를 등록했어요.` },
      });
    },
    onUnauthorized: () => void navigate("/login", { replace: true }),
    readServerToday: async () => (await listUpdates("all")).server_today,
    // Independent source-scoped intent; neither existing composer drafts nor their pending keys are overwritten.
    resource: `reuse-${source.kind}-${source.id}`,
    serverToday,
  });
  const formProps = {
    busy: create.busy,
    focusTitleOnMount: !create.outcomeUnknown,
    locked: create.outcomeUnknown,
    onCancel: () => void navigate(sourcePath(source)),
    onDraftChange: persistDraft,
    requireAudienceSelection: true,
    selectedAudienceEnabled,
    showCompositionSteps: true,
    showPublishSummary: true,
    submitLabel: create.outcomeUnknown ? "결과 다시 확인" : `새 ${kindLabel} 등록하기`,
  };
  return (
    <section
      aria-label="재사용 초안"
      className="mt-5 min-w-0 rounded-card border border-role-border bg-app-surface-raised p-5 shadow-sm sm:p-7"
      data-content-reuse-editor
    >
      <div className="mb-5 rounded-2xl border border-role-border bg-role-soft p-4">
        <p className="flex items-center gap-2 font-extrabold text-app-text">
          <Copy aria-hidden="true" size={18} />새 {kindLabel} 초안
        </p>
        <p className="mt-2 break-keep text-sm leading-6 text-app-muted">
          제목·본문·분류를 가져왔어요. 본문 속 날짜와 이름도 이번 안내에 맞게 검토해 주세요.
          {source.kind === "homework"
            ? " 마감 날짜와 게시 대상을 새로 선택해 주세요."
            : " 중요 표시와 게시 대상을 새로 선택해 주세요."}
        </p>
        <p className="mt-2 break-keep text-xs leading-5 text-app-muted">
          원본과 학생의 확인 기록은 그대로 유지돼요. 이 초안은 검토 후 등록할 때 새 안내로
          게시됩니다.
        </p>
        <Link
          className="ui-button ui-button-secondary mt-3 min-h-11 text-sm"
          to={sourcePath(source)}
        >
          원본 {kindLabel} 보기
        </Link>
      </div>
      <p
        className={`mb-5 break-keep text-xs leading-5 ${saveFailed ? "text-rose-700" : "text-app-muted"}`}
        role={saveFailed ? "alert" : "status"}
      >
        {saveFailed
          ? "초안 자동 저장을 사용할 수 없어요. 닫기 전에 내용을 복사해 주세요."
          : "이 재사용 초안은 이 탭에 따로 저장돼요. 취소 후에도 이어서 작성할 수 있어요."}
      </p>
      {create.error === undefined ? null : (
        <p
          className="mb-5 rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm font-bold leading-6 text-rose-700"
          role="alert"
        >
          {create.error}
        </p>
      )}
      {source.kind === "notice" ? (
        <NoticeForm
          {...formProps}
          initialValue={(create.pendingRequest ?? draft) as NoticeWriteRequest}
          onSubmit={(request) => void create.submit(request)}
        />
      ) : (
        <SupplyForm
          {...formProps}
          initialValue={(create.pendingRequest ?? draft) as SupplyWriteRequest}
          onSubmit={(request) => void create.submit(request)}
          showCategorySelector={false}
        />
      )}
    </section>
  );
}

export function ContentReusePage(): React.JSX.Element {
  const { kind, sourceId } = useParams();
  const navigate = useNavigate();
  const [loaded, setLoaded] = useState<LoadedReuse>();
  const [error, setError] = useState<string>();
  const [role, setRole] = useState<"teacher" | "student">();
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setLoaded(undefined);
    setError(undefined);
    void (async () => {
      if (
        (kind !== "notice" && kind !== "homework") ||
        sourceId === undefined ||
        !/^[1-9][0-9]{0,18}$/u.test(sourceId)
      )
        throw new Error("재사용할 공지나 숙제를 확인해 주세요.");
      const bootstrap = await getBootstrap();
      if (!active) return;
      setRole(bootstrap.current_membership?.role);
      if (bootstrap.destination !== "HOME" || bootstrap.current_membership?.status !== "approved") {
        void navigate("/bootstrap", { replace: true });
        return;
      }
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
        bootstrap.current_membership.role !== "teacher" ||
        !bootstrap.allowed_actions.includes("MANAGE_CLASS")
      )
        throw new Error("선생님만 공지와 숙제를 재사용할 수 있어요.");
      const [entity, feed] = await Promise.all([
        kind === "notice" ? getNotice(sourceId) : getSupply(sourceId),
        listUpdates("all"),
      ]);
      if (!active) return;
      const item = entity.item;
      let initialValue: ReuseWriteRequest;
      if (kind === "notice" && "content" in item) {
        initialValue = {
          title: item.title,
          content: item.content,
          category: item.category,
          is_important: false,
        };
        if (!isNoticeReuseRequest(initialValue))
          throw new Error("원본 공지 내용을 불러오지 못했어요.");
      } else if (kind === "homework" && "description" in item && item.category === "homework") {
        initialValue = {
          title: item.title,
          description: item.description,
          category: "homework",
          needed_on: "",
        };
        if (!isHomeworkReuseRequest(initialValue))
          throw new Error("원본 숙제 내용을 불러오지 못했어요.");
      } else throw new Error("공지 또는 숙제 상세에서 재사용을 시작해 주세요.");
      setLoaded({
        membershipId: bootstrap.current_membership.id,
        selectedAudienceEnabled: feed.selected_audience_enabled,
        serverToday: feed.server_today,
        source: { id: sourceId, kind, initialValue },
      });
    })().catch((failure: unknown) => {
      if (!active) return;
      if (failure instanceof ApiRequestError && failure.status === 401) {
        void navigate("/login", { replace: true });
        return;
      }
      setError(failure instanceof Error ? failure.message : "재사용할 내용을 불러오지 못했어요.");
    });
    return () => {
      active = false;
    };
  }, [attempt, kind, navigate, sourceId]);
  const label = kind === "homework" ? "숙제" : "공지";
  return (
    <AppShell {...(role === undefined ? {} : { navigationRole: role })} width="medium">
      <AppShellBar backLabel="소식으로" backTo="/updates" brandTo="/home" context="내용 재사용" />
      <PageHeader
        eyebrow="내용 재사용"
        title={`새 ${label}로 재사용`}
        description="이전 안내를 바탕으로 이번에 게시할 내용을 검토해 주세요."
      />
      {loaded === undefined ? (
        <div className="mt-5">
          <AsyncStatePanel
            kind={error === undefined ? "loading" : "error"}
            title={
              error === undefined ? "원본 내용을 확인하고 있어요." : "내용을 재사용할 수 없어요."
            }
            {...(error === undefined ? {} : { description: error })}
            action={
              error === undefined ? undefined : (
                <button
                  className="ui-button ui-button-secondary"
                  onClick={() => setAttempt((value) => value + 1)}
                  type="button"
                >
                  <RefreshCw aria-hidden="true" size={17} />
                  다시 확인
                </button>
              )
            }
          />
        </div>
      ) : (
        <ReuseEditor
          {...loaded}
          key={`${loaded.membershipId}:${loaded.source.kind}:${loaded.source.id}`}
        />
      )}
    </AppShell>
  );
}

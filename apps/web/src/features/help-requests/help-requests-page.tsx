import { CheckCheck, LoaderCircle, MessagesSquare, RefreshCw } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState, type MouseEvent } from "react";
import { Link, useNavigate } from "react-router";
import { ApiRequestError, getBootstrap } from "../../api/auth";
import { AUTHENTICATED_CLIENT_STATE_CLEARED_EVENT } from "../../lib/authenticated-client-state";
import {
  helpRequestKindLabel,
  helpTargetPath,
  listHelpRequests,
  resolveHelpRequest,
  type HelpRequestItem,
} from "../../api/help-requests";
import { codePointLength } from "../../lib/text";
import { useLivePolling } from "../../lib/use-live-polling";
import { AppShell } from "../layout/app-shell";
import { teacherOnlyAccessRedirect } from "../layout/access-redirect-notice";
import { AsyncStatePanel } from "../layout/async-state";
import { ContentFilters, ContentFrameBody, ContentFrameHeader } from "../layout/content-frame";
import { HelpThreadPanel } from "./help-thread-page";
import "./help-request-layout.css";

const REPLY_MAX = 200;
type Filter = "open" | "closed" | "all";
function formatActivity(value: string): string {
  return new Intl.DateTimeFormat("ko-KR", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Seoul",
  }).format(new Date(value));
}
function HelpRequestRow({
  item,
  selected,
  onSelect,
  onResolved,
}: {
  item: HelpRequestItem;
  selected: boolean;
  onSelect: () => void;
  onResolved: (next: HelpRequestItem) => void;
}): React.JSX.Element {
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const navigate = useNavigate();
  const lifetime = useRef({ mounted: false, epoch: 0, busy: false });
  // 그려지는 순간 켠다. useEffect는 그린 뒤에 돌아 그 사이 누른 '처리 완료'가 사라졌다(10-20 부하 재현 18/288).
  useLayoutEffect(() => {
    lifetime.current.mounted = true;
    const invalidate = () => {
      lifetime.current.mounted = false;
      lifetime.current.epoch += 1;
    };
    window.addEventListener(AUTHENTICATED_CLIENT_STATE_CLEARED_EVENT, invalidate);
    return () => {
      invalidate();
      window.removeEventListener(AUTHENTICATED_CLIENT_STATE_CLEARED_EVENT, invalidate);
    };
  }, []);
  const replyId = useId();
  const length = codePointLength(reply.trim());
  const student = item.student;
  const name = student?.display_name.trim() || "학생";
  const label = (student?.student_number == null ? "" : student.student_number + "번 ") + name;
  function select(event: MouseEvent<HTMLAnchorElement>): void {
    if (
      event.button === 0 &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.shiftKey &&
      !event.altKey &&
      window.matchMedia?.("(min-width: 1280px)").matches
    ) {
      event.preventDefault();
      onSelect();
    }
  }
  async function resolve(): Promise<void> {
    if (!lifetime.current.mounted || lifetime.current.busy) return;
    lifetime.current.busy = true;
    const epoch = lifetime.current.epoch;
    const isCurrent = () => lifetime.current.mounted && lifetime.current.epoch === epoch;
    setBusy(true);
    setError(undefined);
    try {
      const text = reply.trim();
      const next = await resolveHelpRequest(item.id, text === "" ? null : text);
      if (isCurrent()) onResolved(next);
    } catch (failure) {
      if (!isCurrent()) return;
      if (failure instanceof ApiRequestError && failure.status === 401) {
        void navigate("/login", { replace: true });
        return;
      }
      setError(failure instanceof Error ? failure.message : "처리하지 못했어요.");
    } finally {
      if (!isCurrent()) return;
      lifetime.current.busy = false;
      setBusy(false);
    }
  }
  return (
    <li
      aria-current={selected ? "true" : undefined}
      className="help-request-row"
      data-selected={selected}
    >
      <div className="flex min-w-0 items-start gap-3">
        <span aria-hidden="true" className="help-avatar">
          {Array.from(name)[0]}
        </span>
        <div className="min-w-0 flex-1">
          <Link
            aria-label={label + " 대화 열기"}
            className="block min-h-11 min-w-0 text-app-text"
            data-help-thread-link
            onClick={select}
            to={"/help-requests/" + item.id}
          >
            <span className="flex min-w-0 items-start justify-between gap-2">
              <span className="min-w-0 break-words text-[15.5px] font-extrabold">{label}</span>
              <time
                className="max-w-24 shrink-0 text-right text-[11.5px] leading-4 text-app-muted"
                dateTime={item.last_activity_at}
              >
                {formatActivity(item.last_activity_at)}
              </time>
            </span>
            <span className="mt-1 block min-w-0 truncate text-[14.5px]">
              {item.message ?? helpRequestKindLabel[item.kind]}
            </span>
          </Link>
          {item.target ? (
            <Link
              className="mt-1 flex min-h-11 max-w-full items-center rounded-[7px] bg-app-surface-muted px-2 text-[12.5px] font-bold text-app-muted"
              to={helpTargetPath(item.target)}
            >
              <span className="truncate">
                {item.target.kind === "notice" ? "공지" : "준비물·숙제"} · {item.target.title}
              </span>
            </Link>
          ) : (
            <span className="mt-1 inline-block rounded-[7px] bg-app-surface-muted px-2 py-0.5 text-[12.5px] font-bold text-app-muted">
              일반 질문
            </span>
          )}
          <p className="mt-1 text-xs font-bold text-app-muted">
            {item.status === "open" ? "대화 중" : item.status === "resolved" ? "끝남" : "학생 철회"}
          </p>
        </div>
      </div>
      {item.status === "resolved" && item.reply !== null ? (
        <p className="mt-2 break-words rounded-xl bg-role-soft p-3 text-sm text-app-text">
          남긴 답변: {item.reply}
        </p>
      ) : null}
      {item.status === "open" ? (
        <details className="mt-2 text-xs text-app-muted">
          <summary className="flex min-h-11 w-fit cursor-pointer items-center font-bold">
            요청 처리
          </summary>
          <form
            className="mt-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (length <= REPLY_MAX) void resolve();
            }}
          >
            <label className="auth-label text-sm" htmlFor={replyId}>
              한 줄 답변 <span className="font-medium text-app-muted">(선택, 학생에게 보여요)</span>
            </label>
            <div className="mt-2 grid gap-2">
              <input
                aria-invalid={length > REPLY_MAX || undefined}
                className="ui-input"
                disabled={busy}
                id={replyId}
                maxLength={REPLY_MAX * 2}
                onChange={(event) => setReply(event.target.value)}
                value={reply}
              />
              <button
                aria-busy={busy}
                className="ui-button ui-button-primary min-h-11 text-sm"
                disabled={busy || length > REPLY_MAX}
                type="submit"
              >
                {busy ? (
                  <LoaderCircle aria-hidden="true" className="animate-spin" size={17} />
                ) : (
                  <CheckCheck aria-hidden="true" size={17} />
                )}
                처리 완료
              </button>
            </div>
            {length > REPLY_MAX ? (
              <p className="mt-1 text-xs font-bold text-danger">답변은 {REPLY_MAX}자까지예요.</p>
            ) : null}
          </form>
        </details>
      ) : null}
      {error ? (
        <p className="mt-2 text-sm font-bold text-danger" role="alert">
          {error}
        </p>
      ) : null}
    </li>
  );
}

export function HelpRequestsPage(): React.JSX.Element {
  const navigate = useNavigate();
  const [filter, setFilter] = useState<Filter>("open");
  const [items, setItems] = useState<HelpRequestItem[]>();
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const [selectedId, setSelectedId] = useState<string>();
  const [teacherAuthorised, setTeacherAuthorised] = useState(false);
  const requestStatus = filter === "open" ? "open" : "all";
  useEffect(() => {
    let active = true;
    setItems(undefined);
    setError(undefined);
    setTeacherAuthorised(false);
    void (async () => {
      const bootstrap = await getBootstrap();
      if (!active) return;
      // 막다른 오류 화면 대신(총검수 B1-07·B2-05): 학생은 자기 질문 화면으로, 그 밖에는 공통 교사 전용 처리.
      if (bootstrap.destination === "HOME" && bootstrap.current_membership?.role === "student") {
        void navigate("/help-requests/ask", { replace: true });
        return;
      }
      const accessRedirect = teacherOnlyAccessRedirect(bootstrap);
      if (accessRedirect !== null) {
        void navigate(accessRedirect.path, {
          replace: true,
          ...(accessRedirect.path === "/home" ? { state: accessRedirect.state } : {}),
        });
        return;
      }
      setTeacherAuthorised(true);
      const next = await listHelpRequests(requestStatus);
      if (active) setItems(next);
    })().catch((failure: unknown) => {
      if (!active) return;
      if (failure instanceof ApiRequestError && failure.status === 401) {
        void navigate("/login", { replace: true });
        return;
      }
      setError(failure instanceof Error ? failure.message : "도움 요청을 불러오지 못했어요.");
    });
    return () => {
      active = false;
    };
  }, [attempt, navigate, requestStatus]);
  // 새 요청·새 메시지를 새로고침 없이 반영한다(8초, 화면이 보일 때만). 바뀐 것이 없으면 그대로 둔다.
  useLivePolling(
    async () => {
      const next = await listHelpRequests(requestStatus);
      setItems((current) =>
        current &&
        current.length === next.length &&
        current.every(
          (item, index) =>
            item.id === next[index]?.id &&
            item.status === next[index]?.status &&
            item.last_activity_at === next[index]?.last_activity_at,
        )
          ? current
          : next,
      );
    },
    8000,
    teacherAuthorised && items !== undefined,
  );
  const visibleItems = items?.filter(
    (item) =>
      filter === "all" || (filter === "open" ? item.status === "open" : item.status !== "open"),
  );
  function updateRequest(next: HelpRequestItem): void {
    setItems((current) => current?.map((item) => (item.id === next.id ? next : item)));
  }
  return (
    <AppShell
      alignedFrame
      contentFrame
      {...(teacherAuthorised ? { navigationRole: "teacher" as const } : {})}
      width="wide"
    >
      <ContentFrameHeader
        title="도움 요청"
        actions={
          <button
            aria-label="새로고침"
            className="ui-icon-button"
            disabled={items === undefined && error === undefined}
            onClick={() => setAttempt((value) => value + 1)}
            type="button"
          >
            <RefreshCw aria-hidden="true" size={20} />
          </button>
        }
      >
        <ContentFilters label="보기 범위">
          {(
            [
              ["open", "대화 중"],
              ["closed", "끝남"],
              ["all", "전체"],
            ] as const
          ).map(([value, label]) => (
            <button
              aria-pressed={filter === value}
              className="content-filter"
              key={value}
              onClick={() => {
                setFilter(value);
                setSelectedId(undefined);
              }}
              type="button"
            >
              {label}
            </button>
          ))}
        </ContentFilters>
      </ContentFrameHeader>
      <ContentFrameBody>
        {items === undefined ? (
          <AsyncStatePanel
            kind={error === undefined ? "loading" : "error"}
            title={
              error === undefined ? "도움 요청을 불러오고 있어요" : "도움 요청을 불러오지 못했어요"
            }
            {...(error
              ? {
                  description: error,
                  action: (
                    <button
                      className="ui-button ui-button-secondary"
                      onClick={() => setAttempt((value) => value + 1)}
                      type="button"
                    >
                      다시 불러오기
                    </button>
                  ),
                }
              : {})}
          />
        ) : (
          <div className="help-request-split">
            <section aria-label="받은 도움 요청" className="help-request-list">
              <p className="content-pane-header text-xs text-app-muted">
                {filter === "open"
                  ? "열린 대화를 최근 활동순으로 보여요."
                  : "최근 100건 안에서 보여요."}
              </p>
              {visibleItems?.length === 0 ? (
                <p className="content-card text-sm font-semibold text-app-muted">
                  {filter === "open"
                    ? "처리할 도움 요청이 없어요."
                    : filter === "closed"
                      ? "끝난 대화가 없어요."
                      : "받은 도움 요청이 없어요."}
                </p>
              ) : (
                <ul className="grid gap-2">
                  {visibleItems?.map((item) => (
                    <HelpRequestRow
                      item={item}
                      key={item.id}
                      selected={selectedId === item.id}
                      onSelect={() => setSelectedId(item.id)}
                      onResolved={updateRequest}
                    />
                  ))}
                </ul>
              )}
            </section>
            <aside aria-label="선택한 도움 요청 대화" className="help-request-conversation">
              {selectedId ? (
                <HelpThreadPanel
                  embedded
                  key={selectedId}
                  onRequestChanged={updateRequest}
                  requestId={selectedId}
                  role="teacher"
                />
              ) : (
                <div className="content-card flex h-full min-h-80 flex-col items-center justify-center text-center">
                  <MessagesSquare aria-hidden="true" className="text-role-primary" size={32} />
                  <p className="mt-3 text-sm font-bold text-app-muted">
                    대화를 고르면 여기에서 답장할 수 있어요.
                  </p>
                </div>
              )}
            </aside>
          </div>
        )}
      </ContentFrameBody>
    </AppShell>
  );
}

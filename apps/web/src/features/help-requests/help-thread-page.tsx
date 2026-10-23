import {
  CheckCheck,
  ChevronRight,
  LoaderCircle,
  LockKeyhole,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Send,
  Undo2,
} from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";

import { ApiRequestError, getBootstrap } from "../../api/auth";
import { AUTHENTICATED_CLIENT_STATE_CLEARED_EVENT } from "../../lib/authenticated-client-state";
import {
  getHelpThread,
  createHelpRequest,
  HELP_MESSAGE_MAX,
  helpTargetPath,
  listHelpRequests,
  resolveHelpRequest,
  sendHelpMessage,
  startGeneralHelp,
  withdrawHelpRequest,
  type HelpThread,
  type HelpRequestTargetKind,
} from "../../api/help-requests";
import {
  currentClassTeacherPhotoUrl,
  optionalMemberProfilePhotoUrl,
} from "../../api/profile-photos";
import { isMutationOutcomeUnknown } from "../../lib/idempotent-create";
import { useNavigationCapabilities } from "../../lib/navigation-capabilities";
import { codePointLength } from "../../lib/text";
import { useLivePolling } from "../../lib/use-live-polling";
import { AppShell } from "../layout/app-shell";
import { Avatar } from "../profile-photos/avatar";
import { ContentBackbar, ContentFrameBody, ContentFrameHeader } from "../layout/content-frame";
import { ContentInputFrame, ContentInputMemo } from "../layout/content-input-frame";
import { getNotice, listNotices } from "../../api/notices";
import { PastHelpRequests } from "./past-help-requests";
import { getSupply, listSupplies } from "../../api/supplies";
import "./help-request-layout.css";
import { AsyncStatePanel } from "../layout/async-state";

type Role = "student" | "teacher";

interface Bubble {
  author: Role;
  body: string;
  created_at: string | null;
  key: string;
}

/** 예전 도움 요청의 첫 설명·처리 답변은 메시지 표 밖에 있어 대화 맨 앞에 이어 붙인다. */
function bubblesOf(thread: HelpThread): Bubble[] {
  const { request } = thread;
  const legacy: Bubble[] = [];
  if (request.message !== null)
    legacy.push({
      author: "student",
      body: request.message,
      created_at: request.created_at,
      key: "legacy-message",
    });
  if (request.reply !== null)
    legacy.push({ author: "teacher", body: request.reply, created_at: null, key: "legacy-reply" });
  return [...legacy, ...thread.messages.map((message) => ({ ...message, key: message.id }))];
}

async function currentRole(): Promise<Role> {
  const bootstrap = await getBootstrap(),
    role = bootstrap.current_membership?.role;
  if (bootstrap.destination !== "HOME" || (role !== "student" && role !== "teacher"))
    throw new Error("반에 참여한 학생과 담임 선생님만 볼 수 있어요.");
  return role;
}

function errorMessage(failure: unknown, fallback: string): string {
  return failure instanceof Error ? failure.message : fallback;
}

function Composer({
  busy,
  hint,
  label,
  role,
  onSend,
}: {
  busy: boolean;
  hint: string;
  label: string;
  role: Role;
  onSend: (body: string) => Promise<boolean>;
}): React.JSX.Element {
  const [text, setText] = useState("");
  const fieldId = useId();
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const length = codePointLength(text.trim());
  const tooLong = length > HELP_MESSAGE_MAX;
  useEffect(() => {
    const field = fieldRef.current;
    if (!field) return;
    field.style.height = "auto";
    field.style.height = Math.max(46, Math.min(120, field.scrollHeight)) + "px";
  }, [text]);
  return (
    <form
      className="help-composer"
      data-help-composer
      onSubmit={(event) => {
        event.preventDefault();
        if (busy || length === 0 || tooLong) return;
        void onSend(text.trim()).then((sent) => {
          if (sent) setText("");
        });
      }}
    >
      <div className="flex items-end gap-2">
        <label className="sr-only" htmlFor={fieldId}>
          {label}
        </label>
        <textarea
          aria-describedby={fieldId + "-hint " + fieldId + "-count"}
          aria-invalid={tooLong || undefined}
          className="help-composer-field"
          disabled={busy}
          id={fieldId}
          onChange={(event) => setText(event.target.value)}
          placeholder={label}
          ref={fieldRef}
          rows={1}
          value={text}
        />
        <button
          aria-busy={busy}
          aria-label="보내기"
          className="help-send"
          disabled={busy || length === 0 || tooLong}
          type="submit"
        >
          {busy ? (
            <LoaderCircle aria-hidden="true" className="animate-spin" size={20} />
          ) : (
            <Send aria-hidden="true" size={20} />
          )}
        </button>
      </div>
      <div className="mt-1.5 flex min-w-0 items-start justify-between gap-3 px-1.5 text-xs leading-5 text-app-muted">
        <span className="inline-flex min-w-0 items-start gap-1">
          {role === "student" ? (
            <LockKeyhole aria-hidden="true" className="mt-0.5 shrink-0" size={13} />
          ) : null}
          {role === "student" ? "선생님만 볼 수 있어요" : "답장하면 학생에게 알림이 가요"}
        </span>
        <span
          className={"shrink-0 tabular-nums " + (tooLong ? "font-bold text-danger" : "")}
          id={fieldId + "-count"}
        >
          {length} / {HELP_MESSAGE_MAX}
        </span>
      </div>
      <details className="mt-1 px-1.5 text-xs leading-5 text-app-muted">
        <summary className="w-fit cursor-pointer">대화 안내</summary>
        <p id={fieldId + "-hint"}>
          {hint}
          {role === "student" ? " 보내기는 1분에 20개, 하루에 200개까지 할 수 있어요." : ""}
        </p>
      </details>
    </form>
  );
}

const STUDENT_HINT =
  "선생님은 수업·밤 시간엔 답이 늦을 수 있어요. 건강·가정 사정처럼 민감한 내용은 직접 말해 주세요.";
const TEACHER_HINT =
  "학생 본인과 이 반 담임만 볼 수 있어요. 보낸 메시지는 고치거나 지울 수 없어요.";

function dayKey(value: string | null): string | null {
  if (value === null) return null;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(value));
}
function messageTime(value: string): string {
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}
function dayLabel(value: string): string {
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    month: "long",
    day: "numeric",
    weekday: "short",
  }).format(new Date(value));
}
function groupedBubbles(thread: HelpThread): Bubble[][] {
  const groups: Bubble[][] = [];
  for (const bubble of bubblesOf(thread)) {
    const previous = groups.at(-1);
    const last = previous?.at(-1);
    if (
      previous &&
      last?.author === bubble.author &&
      dayKey(last.created_at) === dayKey(bubble.created_at)
    )
      previous.push(bubble);
    else groups.push([bubble]);
  }
  return groups;
}
/** 자동 갱신 때 실제로 바뀐 것이 있는지 — 메시지 수·마지막 메시지·상태·마지막 활동 */
function threadSignature(thread: HelpThread): string {
  const last = thread.messages.at(-1);
  return [
    thread.messages.length,
    last?.id ?? "",
    thread.request.status,
    thread.request.last_activity_at,
  ].join("|");
}
function statusLabel(status: HelpThread["request"]["status"]): string {
  return status === "open" ? "대화 중" : status === "resolved" ? "끝난 대화" : "학생 철회";
}

function useHelpActionContext(context: string): () => () => boolean {
  const ref = useRef({ context, generation: 0, epoch: 0, mounted: false });
  if (ref.current.context !== context) {
    ref.current.context = context;
    ref.current.generation += 1;
  }
  const generation = ref.current.generation;
  useEffect(() => {
    ref.current.mounted = true;
    const invalidate = () => {
      ref.current.mounted = false;
      ref.current.epoch += 1;
    };
    window.addEventListener(AUTHENTICATED_CLIENT_STATE_CLEARED_EVENT, invalidate);
    return () => {
      invalidate();
      window.removeEventListener(AUTHENTICATED_CLIENT_STATE_CLEARED_EVENT, invalidate);
    };
  }, []);
  return useCallback(() => {
    const epoch = ref.current.epoch;
    return () =>
      ref.current.mounted && ref.current.epoch === epoch && ref.current.generation === generation;
  }, [generation]);
}

export function HelpThreadPanel({
  requestId,
  role,
  embedded = false,
  onRequestChanged,
}: {
  requestId: string;
  role: Role;
  embedded?: boolean;
  onRequestChanged?: (request: HelpThread["request"]) => void;
}): React.JSX.Element {
  const navigate = useNavigate();
  const captureAction = useHelpActionContext(`${role}:${requestId}`);
  const { profilePhotosEnabled, profilePhotoClassId } = useNavigationCapabilities();
  const [thread, setThread] = useState<HelpThread>();
  const [loadError, setLoadError] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const [reopening, setReopening] = useState(false);
  const [height, setHeight] = useState<number>();
  const panelRef = useRef<HTMLElement>(null);
  const menuRef = useRef<HTMLButtonElement>(null);
  const logRef = useRef<HTMLOListElement>(null);
  const activeRef = useRef(true);
  const requestChangedRef = useRef(onRequestChanged);
  requestChangedRef.current = onRequestChanged;
  const menuId = useId();

  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
    };
  }, []);
  useEffect(() => {
    let active = true;
    const isCurrent = captureAction();
    if (!isCurrent()) return;
    setLoadError(undefined);
    setRefreshing(true);
    void getHelpThread(requestId)
      .then((next) => {
        if (!active || !isCurrent()) return;
        setThread(next);
        requestChangedRef.current?.(next.request);
      })
      .catch((failure: unknown) => {
        if (!active || !isCurrent()) return;
        if (failure instanceof ApiRequestError && failure.status === 401) {
          void navigate("/login", { replace: true });
          return;
        }
        setLoadError(errorMessage(failure, "대화를 불러오지 못했어요."));
      })
      .finally(() => {
        if (active && isCurrent()) setRefreshing(false);
      });
    return () => {
      active = false;
    };
  }, [attempt, captureAction, navigate, requestId]);
  // 예전 메시지를 읽는 중이면(맨 아래에서 벗어남) 새 메시지가 와도 끌어내리지 않는다. 내가 보낸 뒤는 내려간다.
  const stickToBottomRef = useRef(true);
  const lastAuthor = thread?.messages.at(-1)?.author;
  useEffect(() => {
    const log = logRef.current;
    if (log && (stickToBottomRef.current || lastAuthor === role)) {
      log.scrollTop = log.scrollHeight;
      stickToBottomRef.current = true;
    }
  }, [thread?.messages.length, thread?.request.status, lastAuthor, role]);
  // 상대가 보낸 메시지·상태 변경을 새로고침 없이 반영한다(4초, 화면이 보일 때만). 바뀐 게 없으면 그대로 둔다.
  const busyRef = useRef(busy);
  busyRef.current = busy;
  // 보내기·처리를 시작할 때마다 늘린다. 조회가 출발한 뒤 늘었으면 그 조회 결과는 옛 상태다.
  const writeSeqRef = useRef(0);
  useLivePolling(
    async () => {
      if (busyRef.current) return;
      const isCurrent = captureAction();
      if (!isCurrent()) return;
      const writeSeq = writeSeqRef.current;
      const next = await getHelpThread(requestId);
      // 보내기 전에 출발한 조회가 보낸 뒤에 도착하면 방금 보낸 메시지가 다음 조회(4초)까지 사라졌다(2026-10-05 재현).
      if (
        !isCurrent() ||
        !activeRef.current ||
        next.request.id !== requestId ||
        writeSeqRef.current !== writeSeq
      )
        return;
      setThread((current) => {
        if (current && threadSignature(current) === threadSignature(next)) return current;
        if (current?.request.status !== next.request.status)
          requestChangedRef.current?.(next.request);
        return next;
      });
    },
    4000,
    thread !== undefined,
  );
  useEffect(() => {
    if (embedded) return;
    const update = () => {
      const panel = panelRef.current;
      if (!panel) return;
      const viewport = window.visualViewport;
      const bottom = viewport ? viewport.offsetTop + viewport.height : window.innerHeight;
      setHeight(Math.max(240, bottom - panel.getBoundingClientRect().top - 12));
    };
    update();
    window.addEventListener("resize", update);
    window.visualViewport?.addEventListener("resize", update);
    window.visualViewport?.addEventListener("scroll", update);
    return () => {
      window.removeEventListener("resize", update);
      window.visualViewport?.removeEventListener("resize", update);
      window.visualViewport?.removeEventListener("scroll", update);
    };
  }, [embedded, thread?.request.id]);

  async function act(action: () => Promise<HelpThread>): Promise<boolean> {
    const isCurrent = captureAction();
    if (!isCurrent() || busyRef.current) return false;
    busyRef.current = true;
    writeSeqRef.current += 1;
    setBusy(true);
    setActionError(undefined);
    try {
      const next = await action();
      if (!isCurrent()) return false;
      if (activeRef.current) {
        setThread(next);
        requestChangedRef.current?.(next.request);
        setReopening(false);
      }
      return true;
    } catch (failure) {
      if (!isCurrent()) return false;
      if (failure instanceof ApiRequestError && failure.status === 401) {
        void navigate("/login", { replace: true });
        return false;
      }
      if (activeRef.current) setActionError(errorMessage(failure, "보내지 못했어요."));
      return false;
    } finally {
      if (isCurrent()) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  }
  /**
   * 응답만 끊기고 저장은 됐을 수 있다. 그대로 다시 누르면 같은 메시지가 두 번 저장되므로(2026-10-05 재현)
   * 결과가 불확실하면 대화를 다시 읽어, 보낸 뒤 새로 생긴 내 같은 메시지가 있으면 보낸 것으로 본다.
   */
  async function sendMessage(body: string): Promise<HelpThread> {
    const isCurrent = captureAction();
    const known = new Set(thread?.messages.map((message) => message.id));
    try {
      return await sendHelpMessage(requestId, body);
    } catch (failure) {
      if (!isCurrent()) throw failure;
      if (!isMutationOutcomeUnknown(failure)) throw failure;
      const latest = await getHelpThread(requestId).catch((refreshFailure: unknown) => {
        if (refreshFailure instanceof ApiRequestError && refreshFailure.status === 401)
          throw refreshFailure;
        return undefined;
      });
      const saved = latest?.messages.some(
        (message) => !known.has(message.id) && message.author === role && message.body === body,
      );
      if (latest !== undefined && saved) return latest;
      throw failure;
    }
  }
  function closeMenu(): void {
    setMenuOpen(false);
    menuRef.current?.focus();
  }

  if (!thread)
    return (
      <AsyncStatePanel
        kind={loadError ? "error" : "loading"}
        title={loadError ? "대화를 불러오지 못했어요" : "대화를 불러오고 있어요"}
        {...(loadError
          ? {
              description: loadError,
              action: (
                <button
                  className="ui-button ui-button-secondary"
                  type="button"
                  onClick={() => setAttempt((value) => value + 1)}
                >
                  다시 불러오기
                </button>
              ),
            }
          : {})}
      />
    );
  const { request } = thread;
  const TitleTag = embedded ? "h2" : "h1";
  const groups = groupedBubbles(thread);
  const student = request.student;
  const participantName =
    role === "teacher" ? student?.display_name.trim() || "학생" : "담임 선생님";
  // T-PHOTO: 교사는 학생 구성원 사진, 학생은 현재 반 담임 사진. 꺼져 있으면 null(첫 글자).
  let participantPhotoUrl: string | null = null;
  if (role === "teacher")
    participantPhotoUrl = optionalMemberProfilePhotoUrl(
      profilePhotosEnabled && student?.has_profile_photo !== false,
      student?.member_id,
    );
  else if (
    profilePhotosEnabled &&
    profilePhotoClassId !== null &&
    thread.teacher_has_profile_photo !== false
  ) {
    try {
      participantPhotoUrl = currentClassTeacherPhotoUrl(profilePhotoClassId);
    } catch {
      participantPhotoUrl = null;
    }
  }
  const nextQuestionPath = request.target
    ? "/help-requests/ask?target_kind=" +
      request.target.kind +
      "&target_id=" +
      encodeURIComponent(request.target.id)
    : "/help-requests/ask";
  let previousDay: string | null = null;
  return (
    <section
      aria-labelledby={"help-thread-title-" + request.id}
      className="help-thread-panel"
      data-help-thread
      ref={panelRef}
      style={height === undefined || embedded ? undefined : { height }}
    >
      <header className="help-thread-header">
        <div className="min-w-0 flex-1">
          <TitleTag
            className="truncate text-[16.5px] font-extrabold text-app-text"
            id={"help-thread-title-" + request.id}
          >
            {participantName}
          </TitleTag>
          <p className="mt-0.5 truncate text-[12.5px] text-app-muted">
            {role === "teacher" && student?.student_number != null
              ? student.student_number + "번 · "
              : ""}
            {statusLabel(request.status)}
            {role === "student" ? " · 답장이 오면 알려 드려요" : ""}
          </p>
        </div>
        <button
          aria-label="대화 새로고침"
          className="ui-icon-button"
          disabled={refreshing || busy}
          onClick={() => setAttempt((value) => value + 1)}
          type="button"
        >
          <RefreshCw aria-hidden="true" className={refreshing ? "animate-spin" : ""} size={20} />
        </button>
        <div
          className="relative"
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) setMenuOpen(false);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") closeMenu();
          }}
        >
          <button
            aria-controls={menuId}
            aria-expanded={menuOpen}
            aria-label="대화 더보기"
            className="ui-icon-button"
            disabled={busy}
            onClick={() => setMenuOpen(!menuOpen)}
            ref={menuRef}
            type="button"
          >
            <MoreHorizontal aria-hidden="true" size={22} />
          </button>
          {menuOpen ? (
            <div className="help-thread-menu" id={menuId}>
              {role === "teacher" && request.status === "open" ? (
                <button
                  className="help-menu-action"
                  disabled={busy}
                  onClick={() => {
                    closeMenu();
                    void act(async () => {
                      await resolveHelpRequest(request.id, null);
                      return getHelpThread(request.id);
                    });
                  }}
                  type="button"
                >
                  <CheckCheck aria-hidden="true" size={17} />
                  대화 끝내기
                </button>
              ) : null}
              {role === "student" && request.status === "open" ? (
                <button
                  className="help-menu-action"
                  disabled={busy}
                  onClick={() => {
                    closeMenu();
                    void act(async () => {
                      await withdrawHelpRequest(request.id);
                      return getHelpThread(request.id);
                    });
                  }}
                  type="button"
                >
                  <Undo2 aria-hidden="true" size={17} />
                  요청 거두기
                </button>
              ) : null}
              {request.target ? (
                <Link className="help-menu-action" to={helpTargetPath(request.target)}>
                  글 보기
                </Link>
              ) : null}
              {role === "teacher" && student ? (
                <Link
                  className="help-menu-action"
                  to={"/members/manage/" + encodeURIComponent(student.member_id)}
                >
                  학생 정보
                </Link>
              ) : null}
              {request.status === "resolved" ? (
                <button
                  className="help-menu-action"
                  onClick={() => {
                    setReopening(true);
                    closeMenu();
                  }}
                  type="button"
                >
                  메시지 보내 다시 열기
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      </header>
      {request.target ? (
        <Link className="help-context-bar" to={helpTargetPath(request.target)}>
          <span className="help-kind">
            {request.target.kind === "notice" ? "공지" : "준비물·숙제"}
          </span>
          <span className="min-w-0 flex-1 truncate">{request.target.title}</span>
          <ChevronRight aria-hidden="true" className="shrink-0 text-app-muted" size={18} />
        </Link>
      ) : (
        <div className="help-context-bar">
          <span className="help-kind">일반</span>
          <span>일반 질문</span>
        </div>
      )}
      <ol
        aria-label="주고받은 메시지"
        aria-live="polite"
        className="help-messages"
        onScroll={(event) => {
          const log = event.currentTarget;
          stickToBottomRef.current = log.scrollHeight - log.scrollTop - log.clientHeight < 48;
        }}
        ref={logRef}
        role="log"
      >
        {groups.length === 0 ? (
          <li className="p-3 text-center text-sm text-app-muted">아직 주고받은 메시지가 없어요.</li>
        ) : (
          groups.map((group) => {
            const first = group[0]!;
            const last = group.at(-1)!;
            const date = group.find((bubble) => bubble.created_at !== null)?.created_at ?? null;
            const day = dayKey(date);
            const showDay = day !== null && day !== previousDay;
            if (day !== null) previousDay = day;
            const mine = first.author === role;
            const timestamp = [...group]
              .reverse()
              .find((bubble) => bubble.created_at !== null)?.created_at;
            return (
              <li className="help-message-group" data-help-group={first.author} key={first.key}>
                {showDay && date ? (
                  <p className="help-day">
                    <time dateTime={date}>{dayLabel(date)}</time>
                  </p>
                ) : null}
                <div className={"help-bubble-group " + (mine ? "help-bubble-group-mine" : "")}>
                  {mine ? null : profilePhotosEnabled ? (
                    <Avatar
                      className="help-avatar-small"
                      name={participantName}
                      photoUrl={participantPhotoUrl}
                      size={28}
                    />
                  ) : (
                    <span aria-hidden="true" className="help-avatar help-avatar-small">
                      {Array.from(participantName)[0]}
                    </span>
                  )}
                  <div className="help-bubble-column">
                    {group.map((bubble) => (
                      <div
                        className={
                          "help-bubble " + (mine ? "help-bubble-mine" : "help-bubble-other")
                        }
                        data-help-bubble={bubble.author}
                        key={bubble.key}
                      >
                        <p className="sr-only">
                          {bubble.author === "teacher" ? "선생님" : "학생"}:
                        </p>
                        <p className="whitespace-pre-wrap break-words">{bubble.body}</p>
                      </div>
                    ))}
                    {timestamp ? (
                      <time
                        className={"help-message-time " + (mine ? "text-right" : "")}
                        dateTime={timestamp}
                      >
                        {messageTime(timestamp)}
                      </time>
                    ) : last.created_at === null ? (
                      <span className="help-message-time">이전 답변</span>
                    ) : null}
                  </div>
                </div>
              </li>
            );
          })
        )}
        {request.status !== "open" ? (
          <li className="help-system-message">
            <CheckCheck aria-hidden="true" size={15} />
            {request.status === "resolved" ? "선생님이 대화를 끝냈어요" : "학생이 요청을 거뒀어요"}
          </li>
        ) : null}
      </ol>
      {loadError || actionError ? (
        <p className="help-action-error" role="alert">
          {actionError ?? loadError}
        </p>
      ) : null}
      {request.status === "open" || (request.status === "resolved" && reopening) ? (
        <Composer
          busy={busy}
          hint={role === "teacher" ? TEACHER_HINT : STUDENT_HINT}
          label={role === "teacher" ? "학생에게 답장 쓰기" : "선생님께 메시지 쓰기"}
          role={role}
          onSend={(body) => act(() => sendMessage(body))}
        />
      ) : (
        <div className="help-closed-bar">
          <strong className="text-sm text-app-text">대화가 끝났어요</strong>
          {request.status === "withdrawn" ? (
            <p className="text-xs leading-5 text-app-muted">
              학생이 철회한 요청이라 더 보낼 수 없어요.
            </p>
          ) : (
            <p className="text-xs leading-5 text-app-muted">
              닫힌 대화예요. 메시지를 보내면 다시 열려요.
            </p>
          )}
          <div className="mt-2 flex flex-wrap gap-2">
            {role === "student" ? (
              <Link className="ui-button ui-button-primary text-sm" to={nextQuestionPath}>
                <Plus aria-hidden="true" size={17} />
                새로 물어보기
              </Link>
            ) : null}
            {request.status === "resolved" ? (
              <button
                className="ui-button ui-button-secondary text-sm"
                onClick={() => setReopening(true)}
                type="button"
              >
                메시지 보내 다시 열기
              </button>
            ) : null}
          </div>
        </div>
      )}
    </section>
  );
}

/** 학생은 자신의 대화, 담임은 이 반 대화만 기존 권한 검사 후 연다. */
export function HelpThreadPage(): React.JSX.Element {
  const { helpRequestId = "" } = useParams();
  const navigate = useNavigate();
  const [role, setRole] = useState<Role>();
  const [loadError, setLoadError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setLoadError(undefined);
    void currentRole()
      .then((next) => {
        if (active) setRole(next);
      })
      .catch((failure: unknown) => {
        if (!active) return;
        if (failure instanceof ApiRequestError && failure.status === 401)
          void navigate("/login", { replace: true });
        else setLoadError(errorMessage(failure, "대화를 불러오지 못했어요."));
      });
    return () => {
      active = false;
    };
  }, [attempt, navigate]);
  return (
    // 다른 탭과 같은 정렬 틀(2026-09-30: PC에서 시작선 7px·끝선 8px 어긋나고 페이지가 스크롤됐다).
    <AppShell
      alignedFrame
      contentFrame
      hideMobileNavigation
      navigationRole={role ?? "student"}
      width="wide"
    >
      <ContentBackbar
        className="[&_.content-back-link]:min-w-11"
        label={role === "teacher" ? "도움 요청" : "홈"}
        to={role === "teacher" ? "/help-requests" : "/home"}
      />
      {role ? (
        <HelpThreadPanel key={helpRequestId} requestId={helpRequestId} role={role} />
      ) : (
        <AsyncStatePanel
          kind={loadError ? "error" : "loading"}
          title={loadError ? "대화를 불러오지 못했어요" : "대화를 불러오고 있어요"}
          {...(loadError
            ? {
                description: loadError,
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
      )}
    </AppShell>
  );
}

interface QuestionTopic {
  id: string;
  kind: HelpRequestTargetKind;
  title: string;
  label: string;
}
function topicKey(topic: Pick<QuestionTopic, "id" | "kind">): string {
  return topic.kind + ":" + topic.id;
}

/** 기존 열린 대화를 먼저 찾고, 없으면 일반 질문 또는 선택한 글의 질문을 시작한다. */
export function AskTeacherPage(): React.JSX.Element {
  const navigate = useNavigate();
  const [search] = useSearchParams();
  const rawKind = search.get("target_kind");
  const requestedKind = rawKind === "notice" || rawKind === "supply" ? rawKind : undefined;
  const requestedId = search.get("target_id");
  const captureAction = useHelpActionContext(`${requestedKind}:${requestedId}`);
  const busyRef = useRef(false);
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [topicError, setTopicError] = useState<string>();
  const [topics, setTopics] = useState<QuestionTopic[]>([]);
  const [topicsLoading, setTopicsLoading] = useState(false);
  const [selection, setSelection] = useState("general");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const fieldId = useId();
  const selectedTopic = topics.find((topic) => topicKey(topic) === selection);
  const maxLength = selectedTopic ? 200 : HELP_MESSAGE_MAX;
  const length = codePointLength(body.trim());
  const tooLong = length > maxLength;
  useEffect(() => {
    let active = true;
    const isCurrent = captureAction();
    if (!isCurrent()) return;
    setReady(false);
    busyRef.current = false;
    setBusy(false);
    setLoadError(undefined);
    void (async () => {
      const role = await currentRole();
      if (!active || !isCurrent()) return;
      if (role !== "student") throw new Error("선생님께 물어보기는 학생 화면이에요.");
      const target: Pick<QuestionTopic, "id" | "kind"> | undefined =
        requestedKind && requestedId ? { id: requestedId, kind: requestedKind } : undefined;
      const open = (await listHelpRequests("open", target)).find((item) =>
        target
          ? item.target?.id === target.id && item.target.kind === target.kind
          : item.kind === "general",
      );
      if (!active || !isCurrent()) return;
      if (open) {
        void navigate("/help-requests/" + open.id, { replace: true });
        return;
      }
      if (target) {
        const entity =
          target.kind === "notice" ? await getNotice(target.id) : await getSupply(target.id);
        if (!active || !isCurrent()) return;
        const topic: QuestionTopic = {
          ...target,
          title: entity.item.title,
          label:
            target.kind === "notice"
              ? "공지"
              : "category" in entity.item && entity.item.category === "homework"
                ? "숙제"
                : "준비물",
        };
        setTopics([topic]);
        setSelection(topicKey(topic));
      } else {
        setSelection("general");
      }
      setReady(true);
    })().catch((failure: unknown) => {
      if (!active || !isCurrent()) return;
      if (failure instanceof ApiRequestError && failure.status === 401) {
        void navigate("/login", { replace: true });
        return;
      }
      setLoadError(errorMessage(failure, "불러오지 못했어요."));
    });
    return () => {
      active = false;
    };
  }, [attempt, captureAction, navigate, requestedId, requestedKind]);
  useEffect(() => {
    if (!ready) return;
    let active = true;
    const isCurrent = captureAction();
    if (!isCurrent()) return;
    setTopicsLoading(true);
    setTopicError(undefined);
    void Promise.allSettled([listNotices("all"), listSupplies("upcoming")]).then(
      ([notices, supplies]) => {
        if (!active || !isCurrent()) return;
        const recent: QuestionTopic[] = [
          ...(supplies.status === "fulfilled"
            ? supplies.value.items.slice(0, 3).map((item) => ({
                id: item.id,
                kind: "supply" as const,
                title: item.title,
                label: item.category === "homework" ? "숙제" : "준비물",
              }))
            : []),
          ...(notices.status === "fulfilled"
            ? notices.value.items.slice(0, 3).map((item) => ({
                id: item.id,
                kind: "notice" as const,
                title: item.title,
                label: "공지",
              }))
            : []),
        ];
        setTopics((current) => [
          ...current,
          ...recent.filter(
            (topic) => !current.some((existing) => topicKey(existing) === topicKey(topic)),
          ),
        ]);
        if (notices.status === "rejected" || supplies.status === "rejected")
          setTopicError("일부 글 목록을 불러오지 못했어요. 그 밖의 질문은 보낼 수 있어요.");
        setTopicsLoading(false);
      },
    );
    return () => {
      active = false;
    };
  }, [captureAction, ready]);
  async function start(): Promise<void> {
    const isCurrent = captureAction();
    if (!isCurrent() || busyRef.current || !ready || length === 0 || tooLong) return;
    busyRef.current = true;
    setBusy(true);
    setActionError(undefined);
    try {
      const request = selectedTopic
        ? await createHelpRequest(
            { id: selectedTopic.id, kind: selectedTopic.kind },
            "question",
            body.trim(),
          )
        : (await startGeneralHelp(body.trim())).request;
      if (isCurrent()) void navigate("/help-requests/" + request.id, { replace: true });
    } catch (failure) {
      if (!isCurrent()) return;
      if (failure instanceof ApiRequestError && failure.status === 401) {
        void navigate("/login", { replace: true });
        return;
      }
      setActionError(errorMessage(failure, "보내지 못했어요."));
    } finally {
      if (isCurrent()) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  }
  return (
    // PC에서는 왼쪽 메뉴의 탭이라 다른 탭과 같은 정렬 틀을 쓰고 '홈' 돌아가기는 휴대폰에서만 보인다
    // (2026-09-30 사용자 지적: 이 화면만 시작선이 7px 어긋나고 페이지가 스크롤됐다).
    <AppShell alignedFrame contentFrame hideMobileNavigation navigationRole="student" width="wide">
      <ContentBackbar className="lg:hidden [&_.content-back-link]:min-w-11" label="홈" to="/home" />
      <ContentFrameHeader title="선생님께 물어보기" />
      <ContentFrameBody>
        {!ready ? (
          <AsyncStatePanel
            kind={loadError ? "error" : "loading"}
            title={loadError ? "불러오지 못했어요" : "불러오고 있어요"}
            {...(loadError
              ? {
                  description: loadError,
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
          <form
            data-ask-teacher
            onSubmit={(event) => {
              event.preventDefault();
              void start();
            }}
          >
            <ContentInputFrame
              preview={
                <section className="content-card h-full">
                  <p className="text-sm font-bold text-app-muted">담임 선생님께 가요</p>
                  <h2 className="mt-3 break-words text-lg font-extrabold">
                    {selectedTopic?.title ?? "그 밖의 질문"}
                  </h2>
                  <p className="mt-4 whitespace-pre-wrap break-words text-[15px] leading-6">
                    {body.trim() || "궁금한 것이나 어려운 점을 적어 주세요."}
                  </p>
                </section>
              }
              actions={
                <button
                  aria-busy={busy}
                  className="ui-button content-input-submit min-h-[52px] rounded-[14px]"
                  data-incomplete={length === 0}
                  disabled={busy || length === 0 || tooLong}
                  type="submit"
                >
                  {busy ? (
                    <LoaderCircle aria-hidden="true" className="animate-spin" size={18} />
                  ) : (
                    <Send aria-hidden="true" size={18} />
                  )}
                  {busy ? "보내고 있어요" : length === 0 ? "질문을 적어 주세요" : "보내기"}
                </button>
              }
            >
              <fieldset className="content-input-support" disabled={busy}>
                <legend className="mb-2 text-sm font-bold text-app-muted">
                  무엇에 대한 질문이에요?
                </legend>
                {topics.map((topic) => (
                  <label className="help-topic" key={topicKey(topic)}>
                    <span className="help-kind">{topic.label}</span>
                    <span className="min-w-0 flex-1 truncate">{topic.title}</span>
                    <input
                      checked={selection === topicKey(topic)}
                      name="help-topic"
                      onChange={() => setSelection(topicKey(topic))}
                      type="radio"
                      value={topicKey(topic)}
                    />
                  </label>
                ))}
                <label className="help-topic">
                  <span className="help-kind">일반</span>
                  <span className="min-w-0 flex-1">그 밖의 질문</span>
                  <input
                    checked={selection === "general"}
                    name="help-topic"
                    onChange={() => setSelection("general")}
                    type="radio"
                    value="general"
                  />
                </label>
                {topicsLoading ? (
                  <p className="px-1 text-xs text-app-muted" role="status">
                    최근 공지와 다가오는 준비물·숙제를 불러오고 있어요.
                  </p>
                ) : null}
                {topicError ? (
                  <p className="px-1 text-xs leading-5 text-app-muted" role="status">
                    {topicError}
                  </p>
                ) : null}
              </fieldset>
              <ContentInputMemo
                footer={
                  <div className="flex flex-wrap justify-between gap-2 text-xs text-app-muted">
                    <span className="inline-flex items-center gap-1">
                      <LockKeyhole aria-hidden="true" size={13} />
                      선생님만 볼 수 있어요
                    </span>
                    <span
                      className={tooLong ? "font-bold text-danger" : ""}
                      id={fieldId + "-count"}
                    >
                      {length} / {maxLength}
                    </span>
                  </div>
                }
              >
                <label className="sr-only" htmlFor={fieldId}>
                  선생님께 메시지 쓰기
                </label>
                <textarea
                  aria-describedby={fieldId + "-hint " + fieldId + "-count"}
                  aria-invalid={tooLong || undefined}
                  className="content-input-textarea"
                  disabled={busy}
                  id={fieldId}
                  onChange={(event) => setBody(event.target.value)}
                  placeholder="궁금한 것이나 어려운 점을 적어 주세요."
                  value={body}
                />
                <details className="mt-2 text-xs leading-5 text-app-muted">
                  <summary className="w-fit cursor-pointer">질문 안내</summary>
                  <p id={fieldId + "-hint"}>
                    {STUDENT_HINT}
                    {selectedTopic
                      ? " 글에 처음 남기는 설명은 200자까지, 대화를 시작한 뒤의 메시지는 500자까지 보낼 수 있어요."
                      : ""}
                  </p>
                </details>
              </ContentInputMemo>
              {actionError ? (
                <p className="text-sm font-bold text-danger" role="alert">
                  {actionError}
                </p>
              ) : null}
            </ContentInputFrame>
          </form>
        )}
        {ready ? <PastHelpRequests /> : null}
      </ContentFrameBody>
    </AppShell>
  );
}

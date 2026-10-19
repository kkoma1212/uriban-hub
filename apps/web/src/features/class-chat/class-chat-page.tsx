import {
  Flag,
  LoaderCircle,
  Lock,
  LockOpen,
  MoreHorizontal,
  Send,
  ShieldAlert,
} from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { useNavigate } from "react-router";

import { ApiRequestError, getBootstrap } from "../../api/auth";
import { AUTHENTICATED_CLIENT_STATE_CLEARED_EVENT } from "../../lib/authenticated-client-state";
import {
  CLASS_CHAT_MESSAGE_MAX,
  CLASS_CHAT_REPORT_REASON_MAX,
  getClassChat,
  hideClassChatMessage,
  muteClassChatMember,
  reportClassChatMessage,
  sendClassChatMessage,
  setClassChatRoomOpen,
  unmuteClassChatMember,
  type ClassChatBlockedReason,
  type ClassChatMessage,
  type ClassChatMuteDuration,
  type ClassChatState,
} from "../../api/class-chat";
import { optionalMemberProfilePhotoUrl } from "../../api/profile-photos";
import { isMutationOutcomeUnknown } from "../../lib/idempotent-create";
import { useNavigationCapabilities } from "../../lib/navigation-capabilities";
import { codePointLength } from "../../lib/text";
import { useLivePolling } from "../../lib/use-live-polling";
import { AppShell } from "../layout/app-shell";
import { AsyncStatePanel } from "../layout/async-state";
import { ContentBackbar } from "../layout/content-frame";
import { Avatar } from "../profile-photos/avatar";
import { ClassChatReportsPanel } from "./class-chat-reports";
import "../help-requests/help-request-layout.css";
import "./class-chat.css";

/*
 * 새 메시지는 4초마다 마지막 번호 뒤만 받는다. 담임이 예전 메시지를 가린 것·방 열림은
 * 8번째(약 30초)마다 전체를 다시 받아 맞춘다 — 반 전체가 방을 열어 두어도 서버 부담을 낮게 둔다.
 */
const POLL_MS = 4000;
const FULL_REFRESH_EVERY = 8;

const BLOCKED_TEXT: Record<ClassChatBlockedReason, string> = {
  closed: "선생님이 대화방을 열면 보낼 수 있어요.",
  muted: "선생님이 잠시 말하기를 멈춰 두었어요.",
  night: "밤 10시부터 아침 7시까지는 보낼 수 없어요.",
};
const MUTE_LABEL: Record<ClassChatMuteDuration, string> = {
  "10m": "10분 멈추기",
  "1h": "1시간 멈추기",
  today: "오늘 하루 멈추기",
};

function errorMessage(failure: unknown, fallback: string): string {
  return failure instanceof Error ? failure.message : fallback;
}
function dayKey(value: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date(value));
}
function dayLabel(value: string): string {
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    month: "long",
    day: "numeric",
    weekday: "short",
  }).format(new Date(value));
}
function messageTime(value: string): string {
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}
function authorLabel(message: ClassChatMessage): string {
  if (message.author.role === "teacher") return message.author.name + " 선생님";
  return (
    (message.author.student_number === null ? "" : message.author.student_number + "번 ") +
    message.author.name
  );
}
/** 같은 사람이 같은 날 이어 보낸 메시지를 한 묶음으로 */
function groupMessages(messages: ClassChatMessage[]): ClassChatMessage[][] {
  const groups: ClassChatMessage[][] = [];
  for (const message of messages) {
    const last = groups.at(-1)?.at(-1);
    if (
      last &&
      last.author.member_id === message.author.member_id &&
      dayKey(last.created_at) === dayKey(message.created_at)
    )
      groups.at(-1)!.push(message);
    else groups.push([message]);
  }
  return groups;
}
/** 이어 받은 메시지를 붙인다(같은 번호는 새 것으로). */
function mergeAfter(current: ClassChatState, next: ClassChatState): ClassChatState {
  const known = new Set(current.messages.map((message) => message.id));
  const added = next.messages.filter((message) => !known.has(message.id));
  return {
    ...next,
    has_more_before: current.has_more_before,
    messages: added.length === 0 ? current.messages : [...current.messages, ...added],
  };
}
function stateSignature(state: ClassChatState): string {
  return JSON.stringify([
    state.room,
    state.me,
    state.open_report_count,
    state.messages.map((message) => [message.id, message.hidden]),
  ]);
}

function Composer({
  busy,
  role,
  onSend,
}: {
  busy: boolean;
  role: ClassChatState["me"]["role"];
  onSend: (body: string) => Promise<boolean>;
}): React.JSX.Element {
  const [text, setText] = useState("");
  const fieldId = useId();
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const length = codePointLength(text.trim());
  const tooLong = length > CLASS_CHAT_MESSAGE_MAX;
  useEffect(() => {
    const field = fieldRef.current;
    if (!field) return;
    field.style.height = "auto";
    field.style.height = Math.max(46, Math.min(120, field.scrollHeight)) + "px";
  }, [text]);
  return (
    <form
      className="help-composer"
      data-class-chat-composer
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
          반 대화에 메시지 쓰기
        </label>
        <textarea
          aria-describedby={fieldId + "-count"}
          aria-invalid={tooLong || undefined}
          className="help-composer-field"
          disabled={busy}
          id={fieldId}
          onChange={(event) => setText(event.target.value)}
          placeholder="반 친구들과 선생님께 메시지 쓰기"
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
        <span className="break-keep">
          {role === "student"
            ? "반 전체와 선생님이 봐요. 민감한 내용·다른 사람 개인정보는 쓰지 마세요. 1분에 10개까지 보낼 수 있어요."
            : "반 전체가 봐요. 민감한 내용·다른 사람 개인정보는 쓰지 마세요. 보낸 메시지는 고치거나 지울 수 없어요."}
        </span>
        <span
          className={"shrink-0 tabular-nums " + (tooLong ? "font-bold text-danger" : "")}
          id={fieldId + "-count"}
        >
          {length} / {CLASS_CHAT_MESSAGE_MAX}
        </span>
      </div>
    </form>
  );
}

function MessageActions({
  message,
  role,
  onAct,
}: {
  message: ClassChatMessage;
  role: ClassChatState["me"]["role"];
  onAct: (action: () => Promise<unknown>) => Promise<boolean>;
}): React.JSX.Element | null {
  const [open, setOpen] = useState(false);
  const [reporting, setReporting] = useState(false);
  const [reason, setReason] = useState("");
  const [reported, setReported] = useState(false);
  const menuId = useId();
  const canModerate = role === "teacher" && message.author.role === "student";
  if (message.mine || (role === "teacher" && !canModerate)) return null;
  const close = () => {
    setOpen(false);
    setReporting(false);
  };
  const reasonLength = codePointLength(reason.trim());
  return (
    <div className="class-chat-actions">
      <button
        aria-controls={menuId}
        aria-expanded={open}
        aria-label={authorLabel(message) + " 메시지 더보기"}
        className="class-chat-more"
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        <MoreHorizontal aria-hidden="true" size={16} />
      </button>
      {open ? (
        <div className="help-thread-menu class-chat-menu" id={menuId}>
          {canModerate ? (
            <>
              {!message.hidden ? (
                <button
                  className="help-menu-action"
                  onClick={() => void onAct(() => hideClassChatMessage(message.id)).then(close)}
                  type="button"
                >
                  메시지 가리기
                </button>
              ) : null}
              {(Object.keys(MUTE_LABEL) as ClassChatMuteDuration[]).map((duration) => (
                <button
                  className="help-menu-action"
                  key={duration}
                  onClick={() =>
                    void onAct(() => muteClassChatMember(message.author.member_id, duration)).then(
                      close,
                    )
                  }
                  type="button"
                >
                  {MUTE_LABEL[duration]}
                </button>
              ))}
              <button
                className="help-menu-action"
                onClick={() =>
                  void onAct(() => unmuteClassChatMember(message.author.member_id)).then(close)
                }
                type="button"
              >
                말하기 멈춤 풀기
              </button>
            </>
          ) : reported ? (
            <p className="p-2 text-sm text-app-muted">신고했어요. 선생님이 확인해요.</p>
          ) : reporting ? (
            <form
              className="flex flex-col gap-2 p-1"
              onSubmit={(event) => {
                event.preventDefault();
                if (reasonLength === 0 || reasonLength > CLASS_CHAT_REPORT_REASON_MAX) return;
                void onAct(() => reportClassChatMessage(message.id, reason.trim())).then((ok) => {
                  if (ok) setReported(true);
                });
              }}
            >
              <label className="text-sm font-bold" htmlFor={menuId + "-reason"}>
                무엇이 문제인가요?
              </label>
              <input
                className="ui-input"
                id={menuId + "-reason"}
                maxLength={CLASS_CHAT_REPORT_REASON_MAX}
                onChange={(event) => setReason(event.target.value)}
                placeholder="예: 놀리는 말이에요"
                value={reason}
              />
              <button
                className="ui-button ui-button-primary text-sm"
                disabled={reasonLength === 0}
                type="submit"
              >
                선생님께 신고
              </button>
            </form>
          ) : (
            <button className="help-menu-action" onClick={() => setReporting(true)} type="button">
              <Flag aria-hidden="true" size={16} />
              선생님께 신고하기
            </button>
          )}
        </div>
      ) : null}
    </div>
  );
}

export function ClassChatPanel({
  onRole,
}: {
  onRole?: (role: ClassChatState["me"]["role"]) => void;
}): React.JSX.Element {
  const navigate = useNavigate();
  const { profilePhotosEnabled } = useNavigationCapabilities();
  const [chat, setChat] = useState<ClassChatState>();
  const [loadError, setLoadError] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [showReports, setShowReports] = useState(false);
  const [height, setHeight] = useState<number>();
  const panelRef = useRef<HTMLElement>(null);
  const logRef = useRef<HTMLOListElement>(null);
  const activeRef = useRef(true);
  const actionEpochRef = useRef(0);
  const pollCountRef = useRef(0);
  const busyRef = useRef(busy);
  busyRef.current = busy;
  // 보내기·방 열기 등을 시작할 때마다 늘린다. 조회가 출발한 뒤 늘었으면 그 조회 결과는 옛 상태다.
  const writeSeqRef = useRef(0);
  const role = chat?.me.role;
  useEffect(() => {
    if (role) onRole?.(role);
  }, [onRole, role]);
  // 이 화면으로 바로 들어오면(새로고침·즐겨찾기) 사진 켜짐 여부가 아직 비어 있다 — 한 번 채운다(T-PHOTO).
  useEffect(() => {
    void getBootstrap().catch(() => undefined);
  }, []);

  useEffect(() => {
    activeRef.current = true;
    const invalidate = () => {
      activeRef.current = false;
      actionEpochRef.current += 1;
    };
    window.addEventListener(AUTHENTICATED_CLIENT_STATE_CLEARED_EVENT, invalidate);
    return () => {
      invalidate();
      window.removeEventListener(AUTHENTICATED_CLIENT_STATE_CLEARED_EVENT, invalidate);
    };
  }, []);
  useEffect(() => {
    let active = true;
    const epoch = actionEpochRef.current;
    const isCurrent = () => active && activeRef.current && actionEpochRef.current === epoch;
    if (!isCurrent()) return;
    setLoadError(undefined);
    void getBootstrap()
      .then(async (bootstrap) => {
        if (!isCurrent()) return;
        // 반 대화가 꺼졌거나 쓸 수 없으면 서버 영문 404 대신 더보기로 돌려보낸다(총검수 B2-04·B4-03).
        if (bootstrap.destination !== "HOME") {
          void navigate("/bootstrap", { replace: true });
          return;
        }
        if (!bootstrap.allowed_actions.includes("USE_CLASS_CHAT")) {
          void navigate("/more", { replace: true });
          return;
        }
        const next = await getClassChat();
        if (isCurrent()) setChat(next);
      })
      .catch((failure: unknown) => {
        if (!isCurrent()) return;
        if (failure instanceof ApiRequestError && failure.status === 401) {
          void navigate("/login", { replace: true });
          return;
        }
        setLoadError(errorMessage(failure, "반 대화를 불러오지 못했어요."));
      });
    return () => {
      active = false;
    };
  }, [attempt, navigate]);
  useLivePolling(
    async () => {
      if (!activeRef.current || busyRef.current) return;
      const epoch = actionEpochRef.current;
      pollCountRef.current += 1;
      const full = pollCountRef.current % FULL_REFRESH_EVERY === 0;
      const lastId = chat?.messages.at(-1)?.id;
      const writeSeq = writeSeqRef.current;
      const next = await getClassChat(full ? undefined : lastId);
      // 조작 전에 출발한 조회가 늦게 오면 방이 닫힘으로 돌아가거나 보낸 글이 잠깐 사라졌다(2026-10-05 재현).
      if (
        !activeRef.current ||
        actionEpochRef.current !== epoch ||
        writeSeqRef.current !== writeSeq
      )
        return;
      setChat((current) => {
        if (!current) return next;
        const merged = full || lastId === undefined ? next : mergeAfter(current, next);
        return stateSignature(current) === stateSignature(merged) ? current : merged;
      });
    },
    POLL_MS,
    chat !== undefined,
  );
  // 예전 메시지를 읽는 중이면 새 메시지가 와도 끌어내리지 않는다. 내가 보낸 뒤는 내려간다.
  const stickToBottomRef = useRef(true);
  const lastMessage = chat?.messages.at(-1);
  useEffect(() => {
    const log = logRef.current;
    if (log && (stickToBottomRef.current || lastMessage?.mine)) {
      log.scrollTop = log.scrollHeight;
      stickToBottomRef.current = true;
    }
  }, [lastMessage?.id, lastMessage?.mine]);
  useEffect(() => {
    const update = () => {
      const panel = panelRef.current;
      if (!panel) return;
      const viewport = window.visualViewport;
      const bottom = viewport ? viewport.offsetTop + viewport.height : window.innerHeight;
      setHeight(Math.max(280, bottom - panel.getBoundingClientRect().top - 12));
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
  }, [chat !== undefined]);

  /**
   * 저장은 됐는데 응답만 끊기면 쓴 글이 남아, 다시 보내면 같은 말이 두 번 저장됐다(2026-10-05 Codex 총검수
   * F02). 결과가 불확실하면 대화를 다시 읽어 보낸 뒤 새로 생긴 내 같은 글이 있으면 보낸 것으로 본다.
   * 보낸 뒤 새로 생긴 글만 보므로 같은 말을 일부러 다시 보내는 것은 막지 않는다.
   */
  async function sendMessage(body: string): Promise<ClassChatState> {
    const epoch = actionEpochRef.current;
    const known = new Set(chat?.messages.map((message) => message.id));
    try {
      return await sendClassChatMessage(body);
    } catch (failure) {
      if (!activeRef.current || actionEpochRef.current !== epoch) throw failure;
      if (!isMutationOutcomeUnknown(failure)) throw failure;
      const latest = await getClassChat().catch((refreshFailure: unknown) => {
        if (refreshFailure instanceof ApiRequestError && refreshFailure.status === 401)
          throw refreshFailure;
        return undefined;
      });
      const saved = latest?.messages.some(
        (message) => !known.has(message.id) && message.mine && message.body === body,
      );
      if (latest !== undefined && saved) return latest;
      throw failure;
    }
  }

  async function act(action: () => Promise<unknown>): Promise<boolean> {
    if (!activeRef.current || busyRef.current) return false;
    const epoch = actionEpochRef.current;
    const isCurrent = () => activeRef.current && actionEpochRef.current === epoch;
    busyRef.current = true;
    writeSeqRef.current += 1;
    setBusy(true);
    setActionError(undefined);
    try {
      const result = await action();
      if (!isCurrent()) return false;
      // 상태를 돌려주는 요청은 그대로 쓰고, 나머지는 전체를 다시 받는다.
      const next =
        result && typeof result === "object" && "messages" in result
          ? (result as ClassChatState)
          : await getClassChat();
      if (!isCurrent()) return false;
      setChat(next);
      return true;
    } catch (failure) {
      if (!isCurrent()) return false;
      if (failure instanceof ApiRequestError && failure.status === 401) {
        void navigate("/login", { replace: true });
        return false;
      }
      if (activeRef.current) setActionError(errorMessage(failure, "처리하지 못했어요."));
      return false;
    } finally {
      if (isCurrent()) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  }

  if (!chat)
    return (
      <AsyncStatePanel
        kind={loadError ? "error" : "loading"}
        title={loadError ? "반 대화를 불러오지 못했어요" : "반 대화를 불러오고 있어요"}
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
  const teacher = chat.me.role === "teacher";
  const groups = groupMessages(chat.messages);
  let previousDay: string | null = null;
  return (
    <section
      aria-labelledby="class-chat-title"
      className="help-thread-panel"
      data-class-chat
      ref={panelRef}
      style={height === undefined ? undefined : { height }}
    >
      <header className="help-thread-header">
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[16.5px] font-extrabold text-app-text" id="class-chat-title">
            반 대화
          </h1>
          <p className="mt-0.5 truncate text-[12.5px] text-app-muted">
            {chat.room.is_open ? "열려 있어요" : "닫혀 있어요"} · 밤 10시~아침 7시는 학생 쉬는 시간
          </p>
        </div>
        {teacher ? (
          <>
            <button
              aria-expanded={showReports}
              className="ui-button ui-button-secondary relative text-sm"
              onClick={() => setShowReports((value) => !value)}
              type="button"
            >
              <ShieldAlert aria-hidden="true" size={16} />
              신고
              {chat.open_report_count ? (
                <span className="class-chat-badge">{chat.open_report_count}</span>
              ) : null}
            </button>
            <button
              className={
                "ui-button text-sm " +
                (chat.room.is_open ? "ui-button-secondary" : "ui-button-primary")
              }
              disabled={busy}
              onClick={() => void act(() => setClassChatRoomOpen(!chat.room.is_open))}
              type="button"
            >
              {chat.room.is_open ? (
                <Lock aria-hidden="true" size={16} />
              ) : (
                <LockOpen aria-hidden="true" size={16} />
              )}
              {chat.room.is_open ? "방 닫기" : "방 열기"}
            </button>
          </>
        ) : null}
      </header>
      {teacher && showReports ? (
        <ClassChatReportsPanel onChanged={() => act(getClassChat)} />
      ) : null}
      <ol
        aria-label="반 대화 메시지"
        aria-live="polite"
        className="help-messages"
        onScroll={(event) => {
          const log = event.currentTarget;
          stickToBottomRef.current = log.scrollHeight - log.scrollTop - log.clientHeight < 48;
        }}
        ref={logRef}
        role="log"
      >
        {chat.has_more_before ? (
          <li className="help-system-message">최근 메시지 100개만 보여요.</li>
        ) : null}
        {groups.length === 0 ? (
          <li className="p-3 text-center text-sm text-app-muted">
            {teacher
              ? "아직 메시지가 없어요. 방을 열면 학생들도 보낼 수 있어요."
              : "아직 메시지가 없어요."}
          </li>
        ) : (
          groups.map((group) => {
            const first = group[0]!;
            const last = group.at(-1)!;
            const day = dayKey(first.created_at);
            const showDay = day !== previousDay;
            previousDay = day;
            const mine = first.mine;
            return (
              <li className="help-message-group" data-class-chat-group key={first.id}>
                {showDay ? (
                  <p className="help-day">
                    <time dateTime={first.created_at}>{dayLabel(first.created_at)}</time>
                  </p>
                ) : null}
                <div className={"help-bubble-group " + (mine ? "help-bubble-group-mine" : "")}>
                  {mine ? null : profilePhotosEnabled ? (
                    <Avatar
                      className="help-avatar-small"
                      name={first.author.name}
                      photoUrl={optionalMemberProfilePhotoUrl(true, first.author.member_id)}
                      size={28}
                    />
                  ) : (
                    <span aria-hidden="true" className="help-avatar help-avatar-small">
                      {Array.from(first.author.name)[0]}
                    </span>
                  )}
                  <div className="help-bubble-column">
                    {!mine ? (
                      <p
                        className={
                          "class-chat-author " +
                          (first.author.role === "teacher" ? "class-chat-author-teacher" : "")
                        }
                      >
                        {authorLabel(first)}
                      </p>
                    ) : null}
                    {group.map((message) => (
                      <div className="class-chat-bubble-row" key={message.id}>
                        <div
                          className={
                            "help-bubble " +
                            (mine ? "help-bubble-mine" : "help-bubble-other") +
                            (message.hidden ? " class-chat-hidden" : "")
                          }
                          data-class-chat-message={message.id}
                        >
                          <p className="sr-only">{mine ? "나" : authorLabel(message)}:</p>
                          {message.body === null ? (
                            <p className="italic">선생님이 가린 메시지예요.</p>
                          ) : (
                            <>
                              {message.hidden ? (
                                <p className="class-chat-hidden-label">학생에게 가려진 메시지</p>
                              ) : null}
                              <p className="whitespace-pre-wrap break-words">{message.body}</p>
                            </>
                          )}
                        </div>
                        <MessageActions message={message} onAct={act} role={chat.me.role} />
                      </div>
                    ))}
                    <time
                      className={"help-message-time " + (mine ? "text-right" : "")}
                      dateTime={last.created_at}
                    >
                      {messageTime(last.created_at)}
                    </time>
                  </div>
                </div>
              </li>
            );
          })
        )}
      </ol>
      {actionError ? (
        <p className="help-action-error" role="alert">
          {actionError}
        </p>
      ) : null}
      {chat.me.can_send ? (
        <Composer busy={busy} onSend={(body) => act(() => sendMessage(body))} role={chat.me.role} />
      ) : (
        <div className="help-closed-bar" data-class-chat-blocked={chat.me.blocked_reason}>
          <strong className="text-sm text-app-text">지금은 보낼 수 없어요</strong>
          <p className="text-xs leading-5 text-app-muted">
            {chat.me.blocked_reason ? BLOCKED_TEXT[chat.me.blocked_reason] : ""}
            {chat.me.blocked_reason === "muted" && chat.me.muted_until
              ? " (" + messageTime(chat.me.muted_until) + "까지)"
              : ""}
          </p>
        </div>
      )}
    </section>
  );
}

/** 반의 승인된 학생·담임만. 서버가 CLASS_CHAT_ENABLED일 때 더보기에서 들어온다. */
export function ClassChatPage(): React.JSX.Element {
  const [role, setRole] = useState<ClassChatState["me"]["role"]>();
  return (
    // 다른 탭과 같은 정렬 틀(2026-09-30: PC에서 시작선 7px·끝선 8px 어긋나고 페이지가 스크롤됐다).
    <AppShell
      alignedFrame
      contentFrame
      hideMobileNavigation
      navigationRole={role ?? "student"}
      width="wide"
    >
      <ContentBackbar className="[&_.content-back-link]:min-w-11" label="더보기" to="/more" />
      <ClassChatPanel onRole={setRole} />
    </AppShell>
  );
}

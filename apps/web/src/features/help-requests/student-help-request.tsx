import {
  CheckCircle2,
  HelpCircle,
  LoaderCircle,
  LockKeyhole,
  MessagesSquare,
  Send,
  Undo2,
} from "lucide-react";
import { useEffect, useId, useState } from "react";
import { Link } from "react-router";

import {
  createHelpRequest,
  helpRequestKindLabel,
  listHelpRequests,
  withdrawHelpRequest,
  type HelpRequestItem,
  type HelpRequestKind,
  type HelpRequestTargetKind,
} from "../../api/help-requests";
import { codePointLength } from "../../lib/text";
import "./help-request-layout.css";

const MESSAGE_MAX = 200;

/**
 * 학생이 안내에 '질문 있어요/준비하기 어려워요'를 남긴다. 보낸 뒤에는 대화 화면에서
 * 선생님과 이어서 주고받는다(T-HELP-CHAT). 안내 확인·자기체크와는 별개라 확인 처리를 하지 않는다.
 */
export function StudentHelpRequest({
  target,
}: {
  target: { id: string; kind: HelpRequestTargetKind };
}): React.JSX.Element | null {
  const [latest, setLatest] = useState<HelpRequestItem | null>(),
    [failed, setFailed] = useState(false),
    [kind, setKind] = useState<Exclude<HelpRequestKind, "general">>(),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string>();
  const messageId = useId(),
    countId = useId();
  const { id, kind: targetKind } = target;

  useEffect(() => {
    let active = true;
    listHelpRequests("all", { id, kind: targetKind })
      .then((items) => {
        if (active) setLatest(items[0] ?? null);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [id, targetKind]);

  async function run(action: () => Promise<HelpRequestItem>): Promise<void> {
    setBusy(true);
    setError(undefined);
    try {
      setLatest(await action());
      setKind(undefined);
      setMessage("");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "요청을 처리하지 못했어요.");
      // 다른 탭에서 먼저 보냈거나 선생님이 처리했을 수 있으니 현재 상태를 다시 읽는다.
      await listHelpRequests("all", { id, kind: targetKind })
        .then((items) => setLatest(items[0] ?? null))
        .catch(() => undefined);
    } finally {
      setBusy(false);
    }
  }

  if (failed)
    return (
      <p className="mt-4 break-keep text-sm text-app-muted" role="status">
        도움 요청 기능을 불러오지 못했어요. 궁금한 점은 선생님께 직접 물어봐 주세요.
      </p>
    );
  if (latest === undefined) return null;
  const open = latest?.status === "open";
  const length = codePointLength(message.trim());

  return (
    <section
      aria-labelledby={`${messageId}-title`}
      className="content-card mt-4 p-4"
      data-help-request="student"
    >
      <p className="text-sm font-bold text-role-primary">선생님께 도움 요청</p>
      <h2
        className="mt-1 break-keep text-base font-extrabold text-app-text"
        id={`${messageId}-title`}
      >
        {open ? "선생님께 요청을 보냈어요" : "궁금하거나 준비가 어렵나요?"}
      </h2>

      {latest?.status === "resolved" && !open ? (
        <div className="mt-3 rounded-xl bg-role-soft p-3 text-sm leading-6 text-app-text">
          <p className="font-bold">선생님이 지난 요청을 확인했어요.</p>
          {latest.reply === null ? null : (
            <p className="mt-1 whitespace-pre-wrap break-words">답변: {latest.reply}</p>
          )}
          <Link
            className="mt-2 inline-flex items-center gap-1 font-bold text-role-primary underline-offset-4 hover:underline"
            data-help-thread-link
            to={`/help-requests/${latest.id}`}
          >
            <MessagesSquare aria-hidden="true" size={15} />
            지난 대화 보기
          </Link>
        </div>
      ) : null}

      {open ? (
        <div className="mt-3 text-sm leading-6 text-app-text">
          <p className="font-bold">{helpRequestKindLabel[latest.kind]}</p>
          {latest.message === null ? null : (
            <p className="mt-1 whitespace-pre-wrap break-words text-app-muted">{latest.message}</p>
          )}
          <p className="mt-2 break-keep text-app-muted">
            선생님 답장은 대화에서 볼 수 있어요. 이 요청은 선생님만 볼 수 있어요.
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <Link
              className="ui-button ui-button-primary text-sm"
              data-help-thread-link
              to={`/help-requests/${latest.id}`}
            >
              <MessagesSquare aria-hidden="true" size={17} />
              대화 보기
            </Link>
            <button
              className="ui-button ui-button-secondary text-sm"
              disabled={busy}
              onClick={() => void run(() => withdrawHelpRequest(latest.id))}
              type="button"
            >
              <Undo2 aria-hidden="true" size={17} />
              요청 거두기
            </button>
          </div>
        </div>
      ) : kind === undefined ? (
        <>
          <p className="mt-2 break-keep text-sm leading-6 text-app-muted">
            선생님만 볼 수 있어요. 안내 확인·체크와는 따로 처리돼요.
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            {(["question", "hard_to_prepare"] as const).map((option) => (
              <button
                className="ui-button ui-button-secondary min-h-[52px] flex-1 rounded-[14px] text-sm"
                disabled={busy}
                key={option}
                onClick={() => {
                  setKind(option);
                  setError(undefined);
                }}
                type="button"
              >
                <HelpCircle aria-hidden="true" size={17} />
                {helpRequestKindLabel[option]}
              </button>
            ))}
          </div>
        </>
      ) : (
        <form
          className="mt-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (busy || length > MESSAGE_MAX) return;
            const text = message.trim();
            void run(() => createHelpRequest(target, kind, text === "" ? null : text));
          }}
        >
          <p className="mb-3 flex min-h-12 items-center gap-2 rounded-[14px] bg-role-soft px-3 text-sm font-bold text-app-text">
            <CheckCircle2 aria-hidden="true" className="shrink-0 text-role-primary" size={18} />이{" "}
            {targetKind === "notice" ? "공지" : "준비물·숙제"}에 대한 요청
          </p>
          <label className="auth-label" htmlFor={messageId}>
            {helpRequestKindLabel[kind]}{" "}
            <span className="font-medium text-app-muted">(설명 선택)</span>
          </label>
          <p className="mt-1 break-keep text-xs leading-5 text-app-muted" id={`${countId}-hint`}>
            건강·가정 사정처럼 민감한 내용은 적지 말고 선생님께 직접 말해 주세요.
          </p>
          <textarea
            aria-describedby={`${countId}-hint ${countId}`}
            aria-invalid={length > MESSAGE_MAX || undefined}
            className="ui-input mt-2 min-h-40 resize-y rounded-[18px] py-3 text-[15px] leading-6"
            disabled={busy}
            id={messageId}
            onChange={(event) => setMessage(event.target.value)}
            placeholder="무엇이 궁금하거나 어려운지 적어도 좋아요."
            rows={3}
            value={message}
          />
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs font-medium text-app-muted">
            <span className="inline-flex items-center gap-1">
              <LockKeyhole aria-hidden="true" size={13} />
              선생님만 볼 수 있어요
            </span>
            <span id={countId}>
              {length} / {MESSAGE_MAX}자
            </span>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              aria-busy={busy}
              className="ui-button ui-button-primary min-h-[52px] flex-1 rounded-[14px] text-sm"
              disabled={busy || length > MESSAGE_MAX}
              type="submit"
            >
              {busy ? (
                <LoaderCircle aria-hidden="true" className="animate-spin" size={17} />
              ) : (
                <Send aria-hidden="true" size={17} />
              )}
              선생님께 보내기
            </button>
            <button
              className="ui-button ui-button-secondary text-sm"
              disabled={busy}
              onClick={() => setKind(undefined)}
              type="button"
            >
              취소
            </button>
          </div>
        </form>
      )}

      {error === undefined ? null : (
        <p className="mt-3 text-sm font-bold text-danger" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

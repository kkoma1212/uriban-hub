import { History, LoaderCircle, Plus, RefreshCw, ShieldCheck, Trash2, Vote, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";

import { ApiRequestError, getBootstrap, type BootstrapResponse } from "../../api/auth";
import {
  createPoll,
  listPolls,
  type CreatePollRequest,
  type PollBallotVisibility,
  type PollItem,
  type PollResultsPolicy,
  type PollScope,
} from "../../api/polls";
import { codePointLength } from "../../lib/text";
import { formatKstDateTimeWithShortWeekday } from "../../lib/kst-format";
import { AppShell } from "../layout/app-shell";
import { AsyncStatePanel, StaleDataAlert } from "../layout/async-state";
import { ContentFrameHeader, ContentSplit } from "../layout/content-frame";
import {
  ContentInputFrame,
  ContentInputMemo,
  ContentInputPreview,
} from "../layout/content-input-frame";

import {
  ContentPostCard,
  selectContentInPlace,
  useContentDesktop,
} from "../updates/content-list-view";
import "../activities/activity-layout.css";

function localDateTimeValue(date: Date): string {
  const offset = date.getTimezoneOffset() * 60 * 1_000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function defaultCloseValue(): string {
  return localDateTimeValue(new Date(Date.now() + 24 * 60 * 60 * 1_000));
}

function normalizedOption(value: string): string {
  return value.trim().replace(/\s+/gu, " ").toLocaleLowerCase("en-US");
}

function scopeFromSearch(searchParams: URLSearchParams): PollScope {
  return searchParams.get("scope") === "closed" ? "closed" : "open";
}

function resultsPolicyLabel(policy: PollResultsPolicy, visibility: PollBallotVisibility): string {
  if (visibility === "private") {
    return policy === "teacher_only" ? "집계 · 마감 후 선생님만" : "집계 · 마감 후";
  }
  if (policy === "after_close") return "집계 · 마감 후";
  if (policy === "teacher_only") return "집계 · 선생님만";
  return "집계 · 참여 후";
}

interface PollPolicyChoice<Value extends string> {
  copy: string;
  label: string;
  value: Value;
}

const BALLOT_VISIBILITY_CHOICES = [
  {
    copy: "학생 이름과 선택을 연결해서 표시하지 않아요.",
    label: "선택 비공개",
    value: "private",
  },
  {
    copy: "담임 선생님만 학생별 선택을 확인할 수 있어요.",
    label: "기명 · 선생님만",
    value: "teacher_visible",
  },
] as const satisfies readonly PollPolicyChoice<PollBallotVisibility>[];

const RESULTS_POLICY_CHOICES = [
  { copy: "학생은 참여한 뒤 확인", label: "참여 후", value: "after_vote" },
  { copy: "학생은 마감 뒤 확인", label: "마감 후", value: "after_close" },
  { copy: "학생에게 계속 비공개", label: "선생님만", value: "teacher_only" },
] as const satisfies readonly PollPolicyChoice<PollResultsPolicy>[];

function PollPolicyFieldset<Value extends string>({
  choices,
  footnote,
  gridClassName,
  legend,
  name,
  onChange,
  value,
}: {
  choices: readonly PollPolicyChoice<Value>[];
  footnote: string;
  gridClassName: "sm:grid-cols-2" | "sm:grid-cols-3";
  legend: string;
  name: string;
  onChange: (value: Value) => void;
  value: Value;
}): React.JSX.Element {
  return (
    <fieldset>
      <legend className="text-sm font-bold text-app-text">{legend}</legend>
      <div className={`mt-2 grid gap-2 ${gridClassName}`}>
        {choices.map((choice) => (
          <label
            className={`flex min-h-16 cursor-pointer items-start gap-2 rounded-[14px] border p-3 ${
              value === choice.value
                ? "border-role-primary bg-role-soft"
                : "border-app-border bg-app-surface"
            }`}
            key={choice.value}
          >
            <input
              checked={value === choice.value}
              className="mt-0.5 size-5 accent-role-primary"
              name={name}
              onChange={() => onChange(choice.value)}
              type="radio"
              value={choice.value}
            />
            <span>
              <strong className="block text-sm font-extrabold text-app-text">{choice.label}</strong>
              <span className="mt-1 block text-xs leading-5 text-app-muted">{choice.copy}</span>
            </span>
          </label>
        ))}
      </div>
      <p className="mt-2 text-xs leading-5 text-app-muted">{footnote}</p>
    </fieldset>
  );
}

function PollListItem({
  item,
  selected,
  onSelect,
}: {
  item: PollItem;
  selected: boolean;
  onSelect(id: string): void;
}): React.JSX.Element {
  return (
    <li className="min-w-0">
      <ContentPostCard
        to={`/polls/${item.id}`}
        selected={selected}
        onClick={(event) => {
          if (selectContentInPlace(event)) onSelect(item.id);
        }}
        title={item.title}
        kind={item.status === "open" ? "진행 중" : "마감"}
        body={`${item.has_voted ? "참여 완료 · " : ""}${item.ballot_visibility === "private" ? "선택 비공개" : "기명 · 선생님만"} · ${resultsPolicyLabel(item.results_policy, item.ballot_visibility)}`}
        footer={`${item.status === "open" ? "마감" : "마감됨"} ${formatKstDateTimeWithShortWeekday(item.closed_at ?? item.closes_at)}`}
      />
    </li>
  );
}

interface PollOptionDraft {
  id: string;
  value: string;
}

let pollOptionSequence = 0;

function createPollOption(): PollOptionDraft {
  pollOptionSequence += 1;
  return { id: `poll-option-${pollOptionSequence}`, value: "" };
}

function createInitialPollOptions(): PollOptionDraft[] {
  return [createPollOption(), createPollOption()];
}

export function PollsPage(): React.JSX.Element {
  const desktop = useContentDesktop();
  const [selectedId, setSelectedId] = useState<string>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const activeScope = scopeFromSearch(searchParams);
  const [bootstrap, setBootstrap] = useState<BootstrapResponse>();
  const [items, setItems] = useState<PollItem[]>();
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [fatalError, setFatalError] = useState<string>();
  const [formOpen, setFormOpen] = useState(searchParams.get("create") === "1");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [closesAt, setClosesAt] = useState(defaultCloseValue);
  const [options, setOptions] = useState<PollOptionDraft[]>(createInitialPollOptions);
  const [ballotVisibility, setBallotVisibility] = useState<PollBallotVisibility>("private");
  const [resultsPolicy, setResultsPolicy] = useState<PollResultsPolicy>("after_close");
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState<string>();
  const createAttemptRef = useRef<{ key: string; request: string } | undefined>(undefined);
  const loadGenerationRef = useRef(0);

  const load = useCallback(
    async (scope: PollScope, cursor?: string): Promise<void> => {
      const generation = ++loadGenerationRef.current;
      const appending = cursor !== undefined;
      if (appending) setLoadingMore(true);
      else setLoading(true);
      try {
        const result = await listPolls(scope, cursor);
        if (generation !== loadGenerationRef.current) return;
        setItems((previous) => (appending ? [...(previous ?? []), ...result.items] : result.items));
        setNextCursor(result.next_cursor);
        setLoadFailed(false);
      } catch (requestError) {
        if (generation !== loadGenerationRef.current) return;
        if (requestError instanceof ApiRequestError && requestError.status === 401) {
          void navigate("/login", { replace: true });
          return;
        }
        setLoadFailed(true);
      } finally {
        if (generation === loadGenerationRef.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [navigate],
  );

  useEffect(() => {
    let active = true;
    void getBootstrap()
      .then((result) => {
        if (!active) return;
        if (result.destination !== "HOME" || result.current_membership === null) {
          void navigate("/bootstrap", { replace: true });
          return;
        }
        const permitted =
          result.allowed_actions.includes("MANAGE_POLLS") ||
          result.allowed_actions.includes("VOTE_IN_POLLS");
        if (!permitted) {
          void navigate("/updates", { replace: true });
          return;
        }
        setBootstrap(result);
      })
      .catch((requestError: unknown) => {
        if (!active) return;
        if (requestError instanceof ApiRequestError && requestError.status === 401) {
          void navigate("/login", { replace: true });
          return;
        }
        setFatalError(
          requestError instanceof Error ? requestError.message : "투표 화면을 준비하지 못했어요.",
        );
        setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [navigate]);

  useEffect(() => {
    if (bootstrap === undefined) return;
    setItems(undefined);
    setNextCursor(null);
    setLoadFailed(false);
    void load(activeScope);
  }, [activeScope, bootstrap, load]);

  useEffect(() => {
    if (bootstrap?.allowed_actions.includes("MANAGE_POLLS") !== true) return;
    if (searchParams.get("create") !== "1") return;
    setFormOpen(true);
    const next = new URLSearchParams(searchParams);
    next.delete("create");
    setSearchParams(next, { replace: true });
  }, [bootstrap, searchParams, setSearchParams]);

  const teacher = bootstrap?.allowed_actions.includes("MANAGE_POLLS") === true;
  const navigationRole = bootstrap?.current_membership?.role;

  function updateOption(optionId: string, value: string): void {
    setOptions((current) =>
      current.map((option) => (option.id === optionId ? { ...option, value } : option)),
    );
    setFormError(undefined);
  }

  function removeOption(optionId: string): void {
    if (options.length <= 2) return;
    setOptions((current) => current.filter((option) => option.id !== optionId));
  }

  function requestPayload(): CreatePollRequest | undefined {
    const nextTitle = title.trim();
    const nextDescription = description.trim();
    const nextOptions = options.map((option) => option.value.trim());
    const closeTime = new Date(closesAt).getTime();
    const delay = closeTime - Date.now();
    if (codePointLength(nextTitle) < 1 || codePointLength(nextTitle) > 100) {
      setFormError("투표 제목은 1~100자로 적어 주세요.");
      return undefined;
    }
    if (codePointLength(nextDescription) > 500) {
      setFormError("설명은 500자 이하로 적어 주세요.");
      return undefined;
    }
    if (nextOptions.some((option) => codePointLength(option) < 1 || codePointLength(option) > 80)) {
      setFormError("각 선택지는 1~80자로 적어 주세요.");
      return undefined;
    }
    if (new Set(nextOptions.map(normalizedOption)).size !== nextOptions.length) {
      setFormError("같은 내용의 선택지는 한 번만 사용할 수 있어요.");
      return undefined;
    }
    if (Number.isNaN(closeTime) || delay < 5 * 60 * 1_000 || delay > 30 * 24 * 60 * 60 * 1_000) {
      setFormError("마감은 지금부터 5분 뒤~30일 이내로 정해 주세요.");
      return undefined;
    }
    return {
      ballot_visibility: ballotVisibility,
      closes_at: new Date(closeTime).toISOString(),
      description: nextDescription === "" ? null : nextDescription,
      options: nextOptions,
      results_policy: resultsPolicy,
      title: nextTitle,
    };
  }

  async function submitCreate(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const request = requestPayload();
    if (request === undefined) return;
    setCreating(true);
    setFormError(undefined);
    const serialized = JSON.stringify(request);
    if (createAttemptRef.current?.request !== serialized) {
      createAttemptRef.current = { key: window.crypto.randomUUID(), request: serialized };
    }
    try {
      const created = await createPoll(request, createAttemptRef.current.key);
      createAttemptRef.current = undefined;
      setTitle("");
      setDescription("");
      setClosesAt(defaultCloseValue());
      setOptions(createInitialPollOptions());
      setBallotVisibility("private");
      setResultsPolicy("after_vote");
      setFormOpen(false);
      void navigate(`/polls/${created.item.id}`, {
        state: { notice: "투표를 만들었습니다." },
      });
    } catch (requestError) {
      if (requestError instanceof ApiRequestError && requestError.status === 401) {
        void navigate("/login", { replace: true });
        return;
      }
      setFormError(
        requestError instanceof Error ? requestError.message : "투표를 만들지 못했어요.",
      );
    } finally {
      setCreating(false);
    }
  }

  if (bootstrap === undefined) {
    return (
      <AppShell contentFrame width="wide">
        <ContentFrameHeader title="투표" />
        <div className="mt-6 w-full text-center">
          {loading ? (
            <LoaderCircle
              aria-hidden="true"
              className="mx-auto animate-spin text-role-primary"
              size={32}
            />
          ) : (
            <Vote aria-hidden="true" className="mx-auto text-rose-500" size={32} />
          )}
          <p className="mt-4 font-bold" role={loading ? "status" : "alert"}>
            {loading ? "투표 화면을 준비하고 있어요." : fatalError}
          </p>
        </div>
      </AppShell>
    );
  }

  if (teacher && formOpen) {
    const missingField =
      title.trim() === ""
        ? "제목을 적어 주세요"
        : options.some((option) => option.value.trim() === "")
          ? "선택지를 채워 주세요"
          : undefined;
    const validClose = !Number.isNaN(new Date(closesAt).getTime());
    return (
      <AppShell contentFrame navigationRole="teacher" width="wide">
        <ContentFrameHeader
          title="투표 만들기"
          actions={
            <button
              aria-label="작성 닫기"
              className="ui-button ui-button-secondary text-sm"
              disabled={creating}
              onClick={() => setFormOpen(false)}
              type="button"
            >
              <X aria-hidden="true" size={18} />
              닫기
            </button>
          }
        />
        <form
          aria-busy={creating}
          data-input-form="poll"
          onSubmit={(event) => void submitCreate(event)}
        >
          <ContentInputFrame
            actions={
              <button
                aria-busy={creating}
                className="ui-button content-input-submit min-h-[52px] w-full text-base"
                data-incomplete={missingField !== undefined}
                disabled={creating || missingField !== undefined}
                type="submit"
              >
                {creating ? (
                  <LoaderCircle aria-hidden="true" className="animate-spin" size={18} />
                ) : (
                  <Vote aria-hidden="true" size={18} />
                )}
                {creating ? "투표를 만들고 있어요." : (missingField ?? "투표 만들기")}
              </button>
            }
            preview={
              <div className="grid min-w-0 gap-3">
                <ContentInputPreview
                  audienceLabel="반 전체"
                  content={description.trim()}
                  dateLabel={
                    validClose
                      ? formatKstDateTimeWithShortWeekday(new Date(closesAt).toISOString()) +
                        " 마감"
                      : "마감 시각을 선택해 주세요"
                  }
                  kind="투표"
                  title={title.trim() || "투표 제목"}
                />
                <section className="content-card p-4">
                  <h3 className="text-[15px] font-extrabold text-app-text">학생이 고를 선택지</h3>
                  <ol className="mt-3 grid gap-2">
                    {options.map((option, index) => (
                      <li
                        className="flex items-start gap-2 rounded-xl bg-app-surface-muted p-3 text-sm"
                        key={option.id}
                      >
                        <span className="font-extrabold text-role-primary">{index + 1}</span>
                        <span className="min-w-0 break-words">
                          {option.value.trim() || "선택지 " + (index + 1)}
                        </span>
                      </li>
                    ))}
                  </ol>
                  <p className="mt-3 text-xs leading-5 text-app-muted">
                    {ballotVisibility === "private"
                      ? "학생별 선택 비공개"
                      : "학생별 선택은 선생님만 확인"}{" "}
                    · {resultsPolicyLabel(resultsPolicy, ballotVisibility)}
                  </p>
                </section>
              </div>
            }
          >
            <ContentInputMemo
              footer={
                <div className="flex w-full justify-between gap-3 text-xs text-app-muted">
                  <span>{codePointLength(title.trim())} / 100자</span>
                  <span>{codePointLength(description.trim())} / 500자</span>
                </div>
              }
            >
              <label className="sr-only" htmlFor="poll-create-title">
                투표 제목
              </label>
              <input
                className="content-input-title"
                disabled={creating}
                id="poll-create-title"
                maxLength={100}
                onChange={(event) => {
                  setTitle(event.target.value);
                  setFormError(undefined);
                }}
                placeholder="투표 제목"
                required
                value={title}
              />
              <label className="sr-only" htmlFor="poll-create-description">
                설명 (선택)
              </label>
              <textarea
                className="content-input-textarea"
                disabled={creating}
                id="poll-create-description"
                maxLength={500}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="선택할 때 알아야 할 내용 (안 써도 돼요)"
                value={description}
              />
            </ContentInputMemo>
            <div className="content-input-support">
              <fieldset className="content-card grid gap-4 p-4" disabled={creating}>
                <legend className="sr-only">투표 설정</legend>
                <fieldset>
                  <legend className="text-sm font-bold text-app-text">선택지</legend>
                  <div className="mt-2 grid gap-2">
                    {options.map((option, index) => (
                      <div className="flex items-center gap-2" key={option.id}>
                        <span className="grid size-8 shrink-0 place-items-center rounded-xl bg-role-soft text-sm font-extrabold text-role-primary">
                          {index + 1}
                        </span>
                        <input
                          aria-label={"선택지 " + (index + 1)}
                          className="ui-input ui-input-compact min-w-0 flex-1"
                          maxLength={80}
                          onChange={(event) => updateOption(option.id, event.target.value)}
                          placeholder={"선택지 " + (index + 1)}
                          required
                          value={option.value}
                        />
                        <button
                          aria-label={"선택지 " + (index + 1) + " 삭제"}
                          className="ui-icon-button ui-button-secondary"
                          disabled={options.length <= 2 || creating}
                          onClick={() => removeOption(option.id)}
                          type="button"
                        >
                          <Trash2 aria-hidden="true" size={17} />
                        </button>
                      </div>
                    ))}
                  </div>
                  {options.length < 10 ? (
                    <button
                      className="ui-button ui-button-secondary mt-2 text-sm"
                      onClick={() => setOptions((current) => [...current, createPollOption()])}
                      type="button"
                    >
                      <Plus aria-hidden="true" size={17} />
                      선택지 추가
                    </button>
                  ) : null}
                </fieldset>
                <PollPolicyFieldset
                  choices={BALLOT_VISIBILITY_CHOICES}
                  footnote="중복 투표 방지와 탈퇴 처리를 위해 시스템은 응답을 계정과 내부적으로 연결합니다."
                  gridClassName="sm:grid-cols-2"
                  legend="학생별 선택 공개"
                  name="ballot-visibility"
                  onChange={(visibility) => {
                    setBallotVisibility(visibility);
                    if (visibility === "private" && resultsPolicy === "after_vote") {
                      setResultsPolicy("after_close");
                    }
                  }}
                  value={ballotVisibility}
                />
                <PollPolicyFieldset
                  choices={
                    ballotVisibility === "private"
                      ? RESULTS_POLICY_CHOICES.filter((choice) => choice.value !== "after_vote")
                      : RESULTS_POLICY_CHOICES
                  }
                  footnote={
                    ballotVisibility === "private"
                      ? "비공개 투표는 선생님도 마감 후에 집계를 확인할 수 있어요. 마감 후에도 참여 인원이 적거나 결과가 한쪽에 몰리면 선택을 짐작할 수 있습니다."
                      : "담임 선생님은 모든 설정에서 선택지별 집계를 확인할 수 있습니다."
                  }
                  gridClassName={
                    ballotVisibility === "private" ? "sm:grid-cols-2" : "sm:grid-cols-3"
                  }
                  legend="선택지별 집계 공개"
                  name="results-policy"
                  onChange={setResultsPolicy}
                  value={resultsPolicy}
                />

                <label className="grid gap-2 text-sm font-bold text-app-text">
                  마감 시각
                  <input
                    className="ui-input ui-input-compact min-w-0"
                    max={localDateTimeValue(new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000))}
                    min={localDateTimeValue(new Date(Date.now() + 5 * 60 * 1_000))}
                    onChange={(event) => setClosesAt(event.target.value)}
                    required
                    type="datetime-local"
                    value={closesAt}
                  />
                  <span className="text-xs font-medium text-app-muted">
                    지금부터 5분 뒤~30일 이내
                  </span>
                </label>
                <div className="flex items-start gap-2 rounded-xl bg-role-soft p-3 text-role-primary">
                  <ShieldCheck aria-hidden="true" className="mt-0.5 shrink-0" size={18} />
                  <div>
                    <h2 className="text-sm font-extrabold">반 운영을 위한 투표만 만들어요</h2>
                    <p className="mt-1 break-keep text-xs leading-5">
                      학생 관계·호감도·인기·서열·외모처럼 사람을 평가하는 투표는 만들 수 없습니다.
                    </p>
                  </div>
                </div>
              </fieldset>
              {formError === undefined ? null : (
                <p
                  className="mt-2 rounded-xl bg-rose-50 px-3 py-2 text-sm font-bold text-rose-700"
                  role="alert"
                >
                  {formError}
                </p>
              )}
            </div>
          </ContentInputFrame>
        </form>
      </AppShell>
    );
  }

  const selectedPoll = items?.find((item) => item.id === selectedId) ?? items?.[0];
  return (
    <AppShell contentFrame navigationRole={navigationRole ?? "student"} width="wide">
      <ContentFrameHeader
        actions={
          teacher ? (
            <button
              aria-expanded={formOpen}
              className="ui-button ui-button-primary min-h-12 px-5"
              onClick={() => setFormOpen((open) => !open)}
              type="button"
            >
              {formOpen ? (
                <X aria-hidden="true" size={19} />
              ) : (
                <Plus aria-hidden="true" size={19} />
              )}
              {formOpen ? "작성 닫기" : "투표 만들기"}
            </button>
          ) : undefined
        }
        title="투표"
      />

      <nav aria-label="투표 상태" className="mt-5 grid grid-cols-2 gap-2">
        {(["open", "closed"] as const).map((scope) => (
          <button
            aria-current={activeScope === scope ? "page" : undefined}
            className={`min-h-11 rounded-xl px-3 text-sm font-extrabold ${
              activeScope === scope
                ? "bg-role-primary text-app-canvas shadow-sm"
                : "text-app-muted hover:bg-app-surface-muted"
            }`}
            key={scope}
            onClick={() => setSearchParams(scope === "open" ? {} : { scope: "closed" })}
            type="button"
          >
            {scope === "open" ? "진행 중" : "마감된 투표"}
          </button>
        ))}
      </nav>

      <section className="mt-4 min-w-0">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-bold text-role-primary">
              {activeScope === "open" ? "지금 참여할 수 있어요" : "지난 결과를 확인해요"}
            </p>
            <h2 className="mt-1 text-xl font-extrabold text-app-text">
              {activeScope === "open" ? "진행 중인 투표" : "마감된 투표"}
            </h2>
          </div>
          <button
            aria-label="투표 목록 새로고침"
            className="ui-icon-button ui-button-secondary"
            disabled={loading}
            onClick={() => void load(activeScope)}
            type="button"
          >
            <RefreshCw aria-hidden="true" className={loading ? "animate-spin" : ""} size={18} />
          </button>
        </div>

        {loadFailed && items !== undefined ? (
          <StaleDataAlert
            busy={loading}
            description="이전에 불러온 목록을 유지하고 있어 최신 내용과 다를 수 있어요."
            onRetry={() => void load(activeScope)}
            title="최신 투표 목록을 확인하지 못했어요."
          />
        ) : null}

        {loading && items === undefined ? (
          <AsyncStatePanel kind="loading" title="투표 목록을 불러오고 있어요." />
        ) : items === undefined ? (
          <AsyncStatePanel
            action={
              <button
                className="ui-button ui-button-primary"
                onClick={() => void load(activeScope)}
                type="button"
              >
                다시 시도
              </button>
            }
            kind="error"
            title="투표 목록을 불러오지 못했어요."
          />
        ) : items.length === 0 ? (
          <AsyncStatePanel
            description={
              activeScope === "open"
                ? teacher
                  ? "필요한 반 운영 선택이 생기면 투표를 만들어 보세요."
                  : "선생님이 투표를 만들면 여기에 보여요."
                : "아직 마감된 투표가 없어요."
            }
            icon={activeScope === "open" ? Vote : History}
            kind="empty"
            title={activeScope === "open" ? "진행 중인 투표가 없어요." : "지난 투표가 없어요."}
          />
        ) : (
          <>
            <ContentSplit
              className="activity-overview mt-3"
              asideLabel="선택한 투표"
              aside={
                desktop && selectedPoll ? (
                  <section className="content-card activity-summary-panel flex flex-col p-5">
                    <h2 className="line-clamp-2 break-words text-lg font-extrabold">
                      {selectedPoll.title}
                    </h2>
                    <p className="mt-3 text-sm text-app-muted">
                      {selectedPoll.total_vote_count === null
                        ? "참여 현황은 투표에서 확인해요."
                        : `참여 ${selectedPoll.total_vote_count}명`}
                    </p>
                    <p className="mt-2 text-sm text-app-muted">
                      {resultsPolicyLabel(
                        selectedPoll.results_policy,
                        selectedPoll.ballot_visibility,
                      )}
                    </p>
                    <Link
                      className="ui-button ui-button-primary mt-auto"
                      to={`/polls/${selectedPoll.id}`}
                    >
                      투표 열기
                    </Link>
                  </section>
                ) : undefined
              }
            >
              <ul className="grid min-w-0 content-start gap-2">
                {items.map((item) => (
                  <PollListItem
                    item={item}
                    key={item.id}
                    selected={desktop && selectedPoll?.id === item.id}
                    onSelect={setSelectedId}
                  />
                ))}
              </ul>
              {nextCursor === null ? null : (
                <button
                  aria-busy={loadingMore}
                  className="ui-button ui-button-secondary mt-5 w-full text-sm"
                  disabled={loadingMore}
                  onClick={() => void load(activeScope, nextCursor)}
                  type="button"
                >
                  {loadingMore ? (
                    <LoaderCircle aria-hidden="true" className="animate-spin" size={17} />
                  ) : null}{" "}
                  투표 더 보기
                </button>
              )}
            </ContentSplit>
          </>
        )}
      </section>
    </AppShell>
  );
}

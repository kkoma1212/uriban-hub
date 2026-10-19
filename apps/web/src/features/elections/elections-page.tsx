import { Plus, RefreshCw, Vote } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";

import {
  ApiRequestError,
  getBootstrap,
  listMembers,
  type BootstrapResponse,
  type MemberListItem,
} from "../../api/auth";
import {
  getCurrentElection,
  getElectionResults,
  listElections,
  type ElectionPublicItem,
  type ElectionResults,
  type ElectionSummary,
} from "../../api/elections";
import { AppShell } from "../layout/app-shell";
import { AsyncStatePanel } from "../layout/async-state";
import { ContentFrameHeader, ContentSplit } from "../layout/content-frame";
import "../activities/activity-layout.css";
import {
  StudentElectionEmpty,
  StudentElectionResult,
  StudentElectionVote,
} from "./student-election-vote";
import { TeacherElectionPanel } from "./teacher-election-panel";

export function ElectionsPage(): React.JSX.Element {
  const navigate = useNavigate();
  /* 상단 "만들기"에서 넘어오면 ?create=1 이 붙는다 — 다른 정하기 화면과 같은 약속이다. */
  const [searchParams, setSearchParams] = useSearchParams();
  const createOpen = searchParams.get("create") === "1";
  const [bootstrap, setBootstrap] = useState<BootstrapResponse>();
  const [current, setCurrent] = useState<ElectionPublicItem | null>();
  /** 발표가 끝난 선거를 보고 있을 때만 채워진다. */
  const [studentResults, setStudentResults] = useState<ElectionResults>();
  const [elections, setElections] = useState<ElectionSummary[]>();
  const [members, setMembers] = useState<MemberListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [fatalError, setFatalError] = useState<string>();
  const [attempt, setAttempt] = useState(0);

  const isTeacher = bootstrap?.current_membership?.role === "teacher";
  /** 교사·학생 어느 쪽 권한이든 그 기능이 켜져 있으면 탭에 보인다. */
  const has = (...actions: string[]): boolean =>
    actions.some((action) => bootstrap?.allowed_actions.includes(action as never) === true);
  /* 만들 권한이 있을 때만 「투표 만들기」를 보인다 — 학생에게는 갈 곳 없는 단추가 된다. */
  const pollsEnabled = has("MANAGE_POLLS");

  /*
   * 다시 불러올 때 전체 화면을 "불러오는 중"으로 바꾸면 교사 패널이 통째로 언마운트되어
   * 열어 둔 선거 상세가 사라진다. 후보를 한 명 등록할 때마다 화면이 처음으로 돌아가는
   * 셈이라, 새로고침은 조용히 한다(2026-08-12 브라우저 QA 가 잡았다).
   */
  const load = useCallback(
    async (teacher: boolean, silent = false): Promise<void> => {
      if (!silent) setLoading(true);
      try {
        if (teacher) {
          const [list, memberList] = await Promise.all([listElections(), listMembers("approved")]);
          setElections(list.items);
          // 이 목록은 학생만 담는다(역할 칸이 없다). 쓰지 못하는 계정은 후보에서 뺀다.
          setMembers(memberList.members.filter((member) => member.account_state === "active"));
        } else {
          const result = await getCurrentElection();
          setCurrent(result.item);
          /*
           * 발표가 끝난 선거면 결과까지 불러 온다. 서버가 "지금 볼 선거"로 이것을
           * 골라 준 것이므로 화면은 종류만 보고 따라간다(T-HUB-45).
           */
          setStudentResults(
            result.item?.status === "published"
              ? await getElectionResults(result.item.id)
              : undefined,
          );
        }
      } catch (requestError) {
        if (requestError instanceof ApiRequestError && requestError.status === 401) {
          void navigate("/login", { replace: true });
          return;
        }
        setFatalError(
          requestError instanceof ApiRequestError
            ? requestError.message
            : "선거 화면을 준비하지 못했어요.",
        );
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [navigate],
  );

  useEffect(() => {
    let active = true;
    void getBootstrap()
      .then(async (result) => {
        if (!active) return;
        if (result.destination !== "HOME" || result.current_membership === null) {
          void navigate("/bootstrap", { replace: true });
          return;
        }
        // 선거가 꺼졌으면 서버 영문 404 대신 반 활동으로 돌려보낸다(투표 화면과 같은 방식, 총검수 B4-03).
        if (
          !result.allowed_actions.includes("MANAGE_ELECTIONS") &&
          !result.allowed_actions.includes("VOTE_IN_ELECTIONS")
        ) {
          void navigate("/activities", { replace: true });
          return;
        }
        setBootstrap(result);
        await load(result.current_membership.role === "teacher");
      })
      .catch((requestError: unknown) => {
        if (!active) return;
        if (requestError instanceof ApiRequestError && requestError.status === 401) {
          void navigate("/login", { replace: true });
          return;
        }
        setFatalError("선거 화면을 준비하지 못했어요.");
        setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [attempt, load, navigate]);

  return (
    <AppShell contentFrame navigationRole={isTeacher ? "teacher" : "student"} width="wide">
      <ContentFrameHeader
        actions={
          isTeacher ? (
            <div className="grid w-full gap-2 lg:w-auto lg:shrink-0">
              <button
                className="ui-button ui-button-primary min-h-12 w-full px-5 text-base"
                onClick={() => {
                  const next = new URLSearchParams(searchParams);
                  next.set("create", "1");
                  setSearchParams(next);
                }}
                type="button"
              >
                <Plus aria-hidden="true" size={20} />
                대표 선거 만들기
              </button>
              {/*
               * 투표 만들기가 여기 있는 이유(2026-08-17 Hex 결정): 만드는 입구가 알림·띠·
               * 투표 화면 셋으로 흩어져 있었다. 선거와 투표는 둘 다 "반에서 뽑는 일"이라
               * 한 화면에서 시작하게 모았고, 그래서 띠에서 「투표」 칸이 빠졌다.
               */}
              {pollsEnabled ? (
                <Link
                  className="ui-button ui-button-secondary min-h-12 w-full px-5 text-base"
                  to="/polls?create=1"
                >
                  <Vote aria-hidden="true" size={20} />
                  투표 만들기
                </Link>
              ) : null}
            </div>
          ) : undefined
        }
        title="대표 선거"
      />

      <div>
        {fatalError !== undefined ? (
          <AsyncStatePanel
            action={
              // 오류 화면에서 다시 시도할 길이 없었다(총검수 B1-14).
              <button
                className="ui-button ui-button-primary text-sm"
                onClick={() => {
                  setFatalError(undefined);
                  setLoading(true);
                  setAttempt((current) => current + 1);
                }}
                type="button"
              >
                <RefreshCw aria-hidden="true" size={17} /> 다시 시도
              </button>
            }
            description={fatalError}
            icon={Vote}
            kind="error"
            title="선거 화면을 열지 못했어요."
          />
        ) : loading ? (
          <AsyncStatePanel
            description="잠시만 기다려 주세요."
            icon={Vote}
            kind="loading"
            title="불러오는 중이에요."
          />
        ) : isTeacher ? (
          <TeacherElectionPanel
            createOpen={createOpen}
            elections={elections ?? []}
            members={members}
            onChanged={() => void load(true, true)}
            onCloseCreate={() => {
              const next = new URLSearchParams(searchParams);
              next.delete("create");
              setSearchParams(next, { replace: true });
            }}
          />
        ) : current === null || current === undefined ? (
          <StudentElectionEmpty />
        ) : (
          <ContentSplit
            className="activity-overview"
            asideOnMobile
            asideLabel="선거 참여와 결과"
            aside={
              studentResults === undefined ? (
                <StudentElectionVote election={current} onVoted={(next) => setCurrent(next)} />
              ) : (
                <StudentElectionResult results={studentResults} />
              )
            }
          >
            <section className="content-card p-4">
              <h2 className="line-clamp-2 break-words text-base font-extrabold">{current.title}</h2>
              <p className="mt-2 text-sm text-app-muted">
                참여 {current.participant_count}명{current.has_voted ? " · 제출 완료" : ""}
              </p>
              <p className="mt-2 text-sm text-app-muted">누가 누구를 골랐는지는 공개하지 않아요.</p>
            </section>
          </ContentSplit>
        )}
      </div>
    </AppShell>
  );
}

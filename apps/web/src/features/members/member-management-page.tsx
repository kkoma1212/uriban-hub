import {
  CheckCircle2,
  ChevronRight,
  LoaderCircle,
  RefreshCw,
  Plus,
  Search,
  UsersRound,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router";

import {
  ApiRequestError,
  approveMember,
  getBootstrap,
  listMembers,
  rejectMember,
  type MemberListItem,
} from "../../api/auth";
import {
  compareStudentsByName,
  matchesStudentSearch,
  type StudentSearchTarget,
} from "../../lib/korean-name-search";
import { optionalMemberProfilePhotoUrl } from "../../api/profile-photos";
import { useNavigationCapabilities } from "../../lib/navigation-capabilities";
import { codePointLength } from "../../lib/text";
import { AppShell } from "../layout/app-shell";
import { teacherOnlyAccessRedirect } from "../layout/access-redirect-notice";
import { AsyncStatePanel, StaleDataAlert } from "../layout/async-state";
import { ConfirmDialog } from "../layout/confirm-dialog";
import {
  ContentFrameBody,
  ContentFrameHeader,
  ContentPanel,
  ContentSplit,
} from "../layout/content-frame";
import { Avatar } from "../profile-photos/avatar";
import { MemberProfilePanel } from "./member-profile-panel";
import {
  getTodayAttendance,
  type AttendanceNotificationType,
  type AttendanceTeacherItem,
} from "../../api/attendance-notifications";
import {
  approvalRequestFromDraft,
  bulkApproveSummary,
  MemberBulkApprove,
} from "./member-bulk-approve";
import { confirmMemberTransition } from "./member-transition-recovery";
import {
  TAB_ORDER,
  tabConfig,
  tabFromSearchParams,
  type ManagementTab,
} from "./member-management-tabs";

interface MemberDraft {
  displayName: string;
  reason: string;
  studentNumber: string;
}

interface MemberConfirmation {
  action: "reject";
  reason: string;
  target: MemberListItem;
  trigger: HTMLButtonElement;
}

function emptyDraft(): MemberDraft {
  return { displayName: "", reason: "", studentNumber: "" };
}

function searchTarget(member: MemberListItem): StudentSearchTarget {
  return { displayName: member.display_name, studentNumber: member.student_number };
}

async function loadTodayRoster(): Promise<AttendanceTeacherItem[]> {
  const items: AttendanceTeacherItem[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  let day: string | undefined;
  do {
    const { data } = await getTodayAttendance("all", "all", cursor);
    if (data.role !== "teacher") return [];
    if (day !== undefined && day !== data.server_today) throw new Error("출결 날짜가 바뀌었어요.");
    day = data.server_today;
    items.push(...data.items);
    cursor = data.next_cursor ?? undefined;
    if (cursor !== undefined) {
      if (cursors.has(cursor)) throw new Error("출결 목록을 끝까지 불러오지 못했어요.");
      cursors.add(cursor);
    }
  } while (cursor !== undefined);
  return items;
}

const attendanceLabels: Record<AttendanceNotificationType, string> = {
  absent: "결석",
  early: "조퇴",
  late: "지각",
};

export function MemberManagementPage(): React.JSX.Element {
  const navigate = useNavigate();
  const { profilePhotosEnabled } = useNavigationCapabilities();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = tabFromSearchParams(searchParams);
  const [focusedTab, setFocusedTab] = useState<ManagementTab>(activeTab);
  const [members, setMembers] = useState<MemberListItem[]>([]);
  const [drafts, setDrafts] = useState<Record<string, MemberDraft>>({});
  const [loading, setLoading] = useState(true);
  const [bulkRunning, setBulkRunning] = useState(false);
  const [actingId, setActingId] = useState<string>();
  const [confirmation, setConfirmation] = useState<MemberConfirmation>();
  const [error, setError] = useState<string>();
  const [loadFailed, setLoadFailed] = useState(false);
  const [loadedTab, setLoadedTab] = useState<ManagementTab>();
  const [notice, setNotice] = useState<string | undefined>(
    typeof location.state?.memberNotice === "string" ? location.state.memberNotice : undefined,
  );
  // 일괄 승인 결과 문구일 때만 다음 할 일(공지 작성) 링크를 붙인다.
  const [bulkNotice, setBulkNotice] = useState<string>();
  const [studentSearch, setStudentSearch] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string>();
  const [expandedRequest, setExpandedRequest] = useState<string>();
  const [attendance, setAttendance] = useState<Record<string, AttendanceNotificationType>>({});
  const [attendanceEnabled, setAttendanceEnabled] = useState(false);
  const [attendanceFailed, setAttendanceFailed] = useState(false);
  // 일괄 승인 버튼은 대기 학생이 없어지면 사라지므로, 끝난 뒤 초점을 결과 안내로 옮긴다.
  const focusResultAfterBulkRef = useRef(false);
  const resultMessageRef = useRef<HTMLDivElement>(null);
  const loadGenerationRef = useRef(0);
  const loadedTabRef = useRef<ManagementTab | undefined>(undefined);
  const activeTabRef = useRef(activeTab);
  activeTabRef.current = activeTab;
  const tabRefs = useRef<Record<ManagementTab, HTMLButtonElement | null>>({
    approved: null,
    pending: null,
    removed: null,
  });

  async function load(tab = activeTab): Promise<boolean> {
    if (tab !== activeTabRef.current) return false;
    const generation = ++loadGenerationRef.current;
    setLoading(true);
    setError(undefined);
    if (loadedTabRef.current !== tab) setLoadFailed(false);
    try {
      const bootstrap = await getBootstrap();
      if (generation !== loadGenerationRef.current || tab !== activeTabRef.current) return false;
      const accessRedirect = teacherOnlyAccessRedirect(bootstrap);
      if (accessRedirect !== null) {
        void navigate(accessRedirect.path, {
          replace: true,
          ...(accessRedirect.path === "/home" ? { state: accessRedirect.state } : {}),
        });
        return false;
      }
      const enabled = bootstrap.allowed_actions.includes("MANAGE_ATTENDANCE_NOTIFICATIONS");
      setAttendanceEnabled(enabled);
      const [result, today] = await Promise.all([
        listMembers("pending,approved,removed,rejoin_allowed"),
        enabled ? loadTodayRoster().catch(() => undefined) : Promise.resolve([]),
      ]);
      if (generation !== loadGenerationRef.current || tab !== activeTabRef.current) return false;
      setMembers(result.members);
      setAttendanceFailed(enabled && today === undefined);
      setAttendance(
        Object.fromEntries((today ?? []).map((item) => [item.member_id, item.notification_type])),
      );
      loadedTabRef.current = tab;
      setLoadedTab(tab);
      setLoadFailed(false);
      setDrafts((current) => {
        const next = { ...current };
        for (const member of result.members) next[member.id] ??= emptyDraft();
        return next;
      });
      return true;
    } catch (requestError) {
      if (generation !== loadGenerationRef.current || tab !== activeTabRef.current) return false;
      if (requestError instanceof ApiRequestError && requestError.status === 401) {
        void navigate("/login", { replace: true });
        return false;
      }
      setLoadFailed(true);
      return false;
    } finally {
      if (generation === loadGenerationRef.current) setLoading(false);
    }
  }

  useEffect(() => {
    setFocusedTab(activeTab);
    void load(activeTab);
  }, [activeTab]);

  useEffect(() => {
    if (!focusResultAfterBulkRef.current) return;
    focusResultAfterBulkRef.current = false;
    resultMessageRef.current?.focus();
  }, [notice, error]);

  function switchTab(tab: ManagementTab): void {
    if (bulkRunning || actingId !== undefined) return;
    setFocusedTab(tab);
    setNotice(undefined);
    setStudentSearch("");
    if (tab === activeTab) return;
    const next = new URLSearchParams(searchParams);
    if (tab === "pending") next.delete("tab");
    else next.set("tab", tab);
    setSearchParams(next);
  }

  function moveTabFocus(
    event: React.KeyboardEvent<HTMLButtonElement>,
    currentTab: ManagementTab,
  ): void {
    const currentIndex = TAB_ORDER.indexOf(currentTab);
    let targetIndex: number | undefined;

    switch (event.key) {
      case "ArrowLeft":
        targetIndex = (currentIndex - 1 + TAB_ORDER.length) % TAB_ORDER.length;
        break;
      case "ArrowRight":
        targetIndex = (currentIndex + 1) % TAB_ORDER.length;
        break;
      case "End":
        targetIndex = TAB_ORDER.length - 1;
        break;
      case "Home":
        targetIndex = 0;
        break;
      default:
        return;
    }

    event.preventDefault();
    const targetTab = TAB_ORDER[targetIndex];
    if (targetTab === undefined) return;
    setFocusedTab(targetTab);
    tabRefs.current[targetTab]?.focus();
  }

  function updateDraft(memberId: string, field: keyof MemberDraft, value: string): void {
    setDrafts((current) => ({
      ...current,
      [memberId]: { ...(current[memberId] ?? emptyDraft()), [field]: value },
    }));
  }

  async function approve(target: MemberListItem): Promise<void> {
    if (bulkRunning || actingId !== undefined) return;
    const prepared = approvalRequestFromDraft(drafts[target.id] ?? emptyDraft());
    setError(undefined);
    setNotice(undefined);
    if (!prepared.ok) {
      setError(prepared.message);
      return;
    }

    setActingId(target.id);
    try {
      const result = await approveMember(target.id, prepared.request);
      await load(activeTab);
      setNotice(
        (result.warnings.includes("EXPECTED_STUDENT_COUNT_EXCEEDED")
          ? `${result.member.display_name} 학생을 승인했어요. 예상 학생 수를 넘었어요.`
          : `${result.member.display_name} 학생을 승인했어요.`) +
          (result.email_delivery_status === "failed"
            ? " 안내 메일을 보내지 못했어요. 학생에게 결과를 알려 주세요."
            : ""),
      );
    } catch (requestError) {
      if (await confirmMemberTransition(requestError, target.id, "approved")) {
        await load(activeTab);
        setNotice("학생이 승인된 것을 확인했어요. 안내 메일이 갔는지는 확인하지 못했어요.");
        return;
      }
      setError(
        requestError instanceof Error
          ? requestError.message
          : "반 참여 요청을 승인하지 못했습니다.",
      );
    } finally {
      setActingId(undefined);
    }
  }

  function requestReject(target: MemberListItem, trigger: HTMLButtonElement): void {
    if (bulkRunning || actingId !== undefined) return;
    const reason = (drafts[target.id]?.reason ?? "").trim();
    if (codePointLength(reason) > 300) {
      setNotice(undefined);
      setError("거절 사유는 300자 이하로 입력해 주세요.");
      return;
    }
    setConfirmation({ action: "reject", reason, target, trigger });
  }

  async function reject(target: MemberListItem, reason: string): Promise<void> {
    setActingId(target.id);
    setError(undefined);
    setNotice(undefined);
    try {
      const result = await rejectMember(target.id, reason || null);
      await load(activeTab);
      setNotice(
        `${target.display_name} 학생의 반 참여 요청을 거절했습니다.${result.email_delivery_status === "failed" ? " 안내 메일을 보내지 못했어요. 학생에게 결과를 알려 주세요." : ""}`,
      );
    } catch (requestError) {
      if (await confirmMemberTransition(requestError, target.id, "rejected")) {
        await load(activeTab);
        setNotice("참여 요청이 거절된 것을 확인했어요. 안내 메일이 갔는지는 확인하지 못했어요.");
        return;
      }
      setError(
        requestError instanceof Error
          ? requestError.message
          : "반 참여 요청을 거절하지 못했습니다.",
      );
    } finally {
      setActingId(undefined);
    }
  }

  const config = tabConfig[activeTab];
  const hasActiveData = loadedTab === activeTab;
  const pendingMembers = members.filter((member) => member.status === "pending");
  const approvedMembers = members.filter((member) => member.status === "approved");
  const removedMembers = members.filter(
    (member) => member.status === "removed" || member.status === "rejoin_allowed",
  );
  const counts: Record<ManagementTab, number> = {
    pending: pendingMembers.length,
    approved: approvedMembers.length,
    removed: removedMembers.length,
  };
  const listedMembers =
    activeTab === "approved"
      ? approvedMembers
          .filter((member) => matchesStudentSearch(searchTarget(member), studentSearch))
          .sort(
            (left, right) =>
              (left.student_number ?? 100) - (right.student_number ?? 100) ||
              compareStudentsByName(searchTarget(left), searchTarget(right)),
          )
      : activeTab === "pending"
        ? pendingMembers
        : removedMembers;
  const selectedMember =
    listedMembers.find((member) => member.id === selectedId) ?? listedMembers[0];

  function pendingRows(): React.JSX.Element {
    return (
      <section aria-label="참여 요청" className="content-card overflow-hidden p-0">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-app-border px-4 py-3">
          <h2 className="text-sm font-bold text-app-muted">참여 요청 {pendingMembers.length}명</h2>
          <MemberBulkApprove
            disabled={bulkRunning || actingId !== undefined || loading}
            drafts={drafts}
            onRunningChange={(running) => {
              setBulkRunning(running);
              if (running) {
                setNotice(undefined);
                setBulkNotice(undefined);
                setError(undefined);
              }
            }}
            onFinished={async (result) => {
              await load(activeTab);
              const summary = bulkApproveSummary(result);
              focusResultAfterBulkRef.current = true;
              setNotice(summary.notice);
              setBulkNotice(summary.notice);
              setError(summary.error);
            }}
            pending={pendingMembers}
          />
        </div>
        <ul className="divide-y divide-app-border">
          {pendingMembers.map((member) => {
            const draft = drafts[member.id] ?? emptyDraft();
            const inactive = member.account_state === "inactive";
            const acting = actingId === member.id;
            const expanded = expandedRequest === member.id;
            return (
              <li key={member.id}>
                <div className="content-row gap-2 px-4">
                  <span className="grid size-[30px] shrink-0 place-items-center rounded-[10px] bg-app-surface-muted text-[13px] font-extrabold text-app-text">
                    {member.student_number ?? "—"}
                  </span>
                  <button
                    aria-expanded={expanded}
                    aria-controls={"member-approval-fields-" + member.id}
                    aria-label={member.display_name + " 승인 정보 입력"}
                    className="min-w-0 flex-1 py-2 text-left"
                    onClick={() => setExpandedRequest(expanded ? undefined : member.id)}
                    type="button"
                  >
                    <span className="block truncate text-[15px] font-bold text-app-text">
                      {member.display_name}
                    </span>
                    <span className="block truncate text-xs text-app-muted">
                      {member.email_masked ?? "이름·번호·사유 입력"}
                      {member.birth_date
                        ? ` · 생년월일 ${member.birth_date.replaceAll("-", ". ")}.`
                        : ""}
                    </span>
                  </button>
                  <button
                    aria-busy={acting}
                    aria-label={member.display_name + " 학생 거절"}
                    className="ui-button ui-button-secondary px-3 text-sm"
                    disabled={bulkRunning || actingId !== undefined}
                    onClick={(event) => requestReject(member, event.currentTarget)}
                    type="button"
                  >
                    거절
                  </button>
                  <button
                    aria-busy={acting}
                    aria-label={member.display_name + " 학생 승인"}
                    className="ui-button ui-button-primary px-3 text-sm"
                    disabled={inactive || bulkRunning || actingId !== undefined}
                    onClick={() => void approve(member)}
                    type="button"
                  >
                    {acting ? (
                      <LoaderCircle aria-hidden="true" className="animate-spin" size={16} />
                    ) : null}
                    승인
                  </button>
                </div>
                {expanded ? (
                  <div
                    className="border-t border-app-border bg-app-surface-muted p-4"
                    id={"member-approval-fields-" + member.id}
                  >
                    {member.requested_at === null ? null : (
                      <p className="mb-3 text-xs text-app-muted">
                        요청{" "}
                        {new Intl.DateTimeFormat("ko-KR", {
                          dateStyle: "medium",
                          timeStyle: "short",
                          timeZone: "Asia/Seoul",
                        }).format(new Date(member.requested_at))}
                      </p>
                    )}
                    <div className="grid grid-cols-[5rem_minmax(0,1fr)] gap-3">
                      <label className="text-sm font-bold text-app-muted">
                        학생 번호
                        <input
                          className="ui-input ui-input-compact mt-2"
                          disabled={bulkRunning || inactive || acting}
                          inputMode="numeric"
                          max={99}
                          min={1}
                          onChange={(event) =>
                            updateDraft(member.id, "studentNumber", event.target.value)
                          }
                          placeholder="선택"
                          type="number"
                          value={draft.studentNumber}
                        />
                      </label>
                      <label className="min-w-0 text-sm font-bold text-app-muted">
                        반에서 보이는 이름
                        <input
                          className="ui-input ui-input-compact mt-2"
                          disabled={bulkRunning || inactive || acting}
                          onChange={(event) =>
                            updateDraft(member.id, "displayName", event.target.value)
                          }
                          placeholder="기본 이름 사용"
                          value={draft.displayName}
                        />
                      </label>
                    </div>
                    <input
                      aria-label={member.display_name + " 거절 사유"}
                      className="ui-input ui-input-compact mt-3"
                      disabled={bulkRunning || acting}
                      onChange={(event) => updateDraft(member.id, "reason", event.target.value)}
                      placeholder="거절 사유 (선택)"
                      value={draft.reason}
                    />
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      </section>
    );
  }

  const content = (
    <>
      <div className="outline-none" ref={resultMessageRef} tabIndex={-1}>
        {error === undefined ? null : (
          <p
            className="mb-4 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-medium text-rose-700"
            role="alert"
          >
            {error}
          </p>
        )}
        {notice === undefined ? null : (
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3">
            <p
              aria-live="polite"
              className="flex items-center gap-2 text-sm font-bold text-emerald-700"
              role="status"
            >
              <CheckCircle2 aria-hidden="true" size={18} />
              {notice}
            </p>
            {notice === bulkNotice ? (
              <Link
                className="ui-button ui-button-secondary min-h-11 text-sm"
                to="/updates?create=notice"
              >
                학생들에게 공지 쓰기
              </Link>
            ) : null}
          </div>
        )}
      </div>
      {loadFailed && hasActiveData ? (
        <StaleDataAlert
          busy={loading || bulkRunning || actingId !== undefined}
          description="이전에 불러온 학생 목록을 계속 표시하고 있어 최신 정보와 다를 수 있어요."
          onRetry={() => {
            if (!bulkRunning && actingId === undefined) void load();
          }}
          title="최신 학생 목록을 확인하지 못했어요."
        />
      ) : null}
      {!hasActiveData && !loadFailed ? (
        <AsyncStatePanel kind="loading" title="학생 목록을 불러오고 있어요." tone="neutral" />
      ) : !hasActiveData && loadFailed ? (
        <AsyncStatePanel
          action={
            <button
              aria-busy={loading}
              className="ui-button ui-button-primary text-sm"
              disabled={loading}
              onClick={() => void load()}
              type="button"
            >
              다시 시도
            </button>
          }
          description="인터넷 연결을 확인하고 잠시 뒤 다시 시도해 주세요."
          kind="error"
          title="학생 목록을 불러오지 못했어요."
          tone="neutral"
        />
      ) : (
        <>
          {pendingMembers.length > 0 && activeTab !== "removed" ? pendingRows() : null}
          {activeTab === "approved" ? (
            <div className="content-pane-header">
              <p className="text-[13px] font-bold text-app-muted" role="status">
                번호순 {listedMembers.length}명
              </p>
              {attendanceEnabled ? (
                <Link
                  className="inline-flex min-h-11 items-center text-sm font-bold text-role-primary"
                  to="/attendance"
                >
                  출결 보기
                </Link>
              ) : null}
            </div>
          ) : null}
          {attendanceFailed && activeTab === "approved" ? (
            <p className="mb-3 text-sm text-app-muted">
              오늘 출결 연락을 불러오지 못해 표시하지 않았어요.
            </p>
          ) : null}
          {listedMembers.length === 0 ? (
            <AsyncStatePanel
              description={
                activeTab === "approved" && studentSearch.trim() !== ""
                  ? "다른 이름이나 번호로 찾아보거나, 검색어를 지우면 전체 명단이 다시 나와요."
                  : config.emptyDescription
              }
              icon={UsersRound}
              kind="empty"
              title={
                activeTab === "approved" && studentSearch.trim() !== ""
                  ? "'" + studentSearch.trim() + "'로 찾은 학생이 없어요."
                  : config.empty
              }
              tone="neutral"
            />
          ) : activeTab === "pending" ? null : (
            <ul
              aria-label={activeTab === "approved" ? "승인 학생 목록" : "제외 학생 목록"}
              className="content-card overflow-hidden p-0 divide-y divide-app-border"
              data-member-roster-view="compact-rows"
            >
              {listedMembers.map((member) => (
                <li data-member-roster-row key={member.id}>
                  {activeTab === "approved" ? (
                    <Link
                      aria-label={member.display_name + " 학생 정보 보기"}
                      aria-current={selectedMember?.id === member.id ? "true" : undefined}
                      className={
                        "content-row gap-3 px-4 transition-colors hover:bg-role-soft" +
                        (selectedMember?.id === member.id ? " xl:bg-role-soft" : "")
                      }
                      onClick={(event) => {
                        if (
                          typeof window.matchMedia === "function" &&
                          window.matchMedia("(min-width: 1280px)").matches
                        ) {
                          event.preventDefault();
                          setSelectedId(member.id);
                        }
                      }}
                      to={"/members/manage/" + member.id}
                    >
                      <span className="grid size-[30px] shrink-0 place-items-center rounded-[10px] bg-app-surface-muted text-[13px] font-extrabold text-app-text">
                        {member.student_number ?? "—"}
                      </span>
                      {/* T-PHOTO: 참여 학생만(서버가 승인된 구성원 사진만 준다). 기능이 꺼지면 그리지 않는다. */}
                      {profilePhotosEnabled ? (
                        <Avatar
                          name={member.display_name}
                          photoUrl={optionalMemberProfilePhotoUrl(
                            member.has_profile_photo !== false,
                            member.id,
                          )}
                          size={30}
                        />
                      ) : null}
                      <span
                        className="min-w-0 flex-1 truncate text-[15px] font-bold text-app-text"
                        data-member-name
                      >
                        {member.display_name}
                      </span>
                      {attendance[member.id] === undefined ? null : (
                        <span
                          aria-label={"오늘 출결 연락 " + attendanceLabels[attendance[member.id]!]}
                          className={
                            "shrink-0 rounded-lg px-2 py-1 text-xs font-extrabold " +
                            (attendance[member.id] === "absent"
                              ? "bg-rose-50 text-rose-700"
                              : "bg-app-surface-muted text-app-muted")
                          }
                        >
                          {attendanceLabels[attendance[member.id]!]}
                        </span>
                      )}
                      <ChevronRight
                        aria-hidden="true"
                        className="shrink-0 text-app-muted"
                        size={18}
                      />
                    </Link>
                  ) : (
                    <div className="content-row gap-3 px-4">
                      <span className="grid size-[30px] shrink-0 place-items-center rounded-[10px] bg-app-surface-muted text-[13px] font-extrabold">
                        {member.student_number ?? "—"}
                      </span>
                      <span
                        className="min-w-0 flex-1 truncate text-[15px] font-bold text-app-text"
                        data-member-name
                      >
                        {member.display_name}
                      </span>
                      <span className="shrink-0 rounded-lg bg-app-surface-muted px-2 py-1 text-xs font-bold text-app-muted">
                        {member.status === "rejoin_allowed" ? "다시 참여 허용" : "제외"}
                      </span>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </>
  );

  return (
    <AppShell alignedFrame contentFrame navigationRole="teacher" width="wide">
      <ContentFrameHeader
        className="relative"
        title="학생"
        actions={
          <>
            {activeTab === "approved" ? (
              <label
                className={
                  (searchOpen ? "flex" : "hidden xl:flex") +
                  " min-w-0 items-center gap-2 max-xl:absolute max-xl:inset-x-0 max-xl:top-[52px]"
                }
              >
                <span className="sr-only">학생 찾기</span>
                <Search aria-hidden="true" className="shrink-0 text-app-muted" size={18} />
                <input
                  aria-describedby="member-search-hint"
                  className="ui-input ui-input-compact min-w-0 max-w-[220px] max-xl:max-w-none"
                  onChange={(event) => setStudentSearch(event.target.value)}
                  placeholder="이름·초성·번호 검색"
                  type="search"
                  value={studentSearch}
                />
              </label>
            ) : null}
            {activeTab === "approved" ? (
              <button
                aria-label="학생 검색"
                aria-expanded={searchOpen}
                className="ui-icon-button ui-button-secondary xl:hidden"
                onClick={() => {
                  setSearchOpen(!searchOpen);
                  if (searchOpen) setStudentSearch("");
                }}
                type="button"
              >
                <Search aria-hidden="true" size={18} />
              </button>
            ) : null}
            <button
              aria-label="목록 새로고침"
              aria-busy={loading || bulkRunning || actingId !== undefined}
              className="ui-icon-button ui-button-secondary"
              disabled={loading || bulkRunning || actingId !== undefined}
              onClick={() => void load()}
              type="button"
            >
              <RefreshCw aria-hidden="true" className={loading ? "animate-spin" : ""} size={18} />
            </button>
            <Link className="ui-button ui-button-primary px-3 text-sm" to="/class/manage">
              <Plus aria-hidden="true" size={17} />
              초대
            </Link>
          </>
        }
      >
        <p className="sr-only" id="member-search-hint">
          이름·이름 시작 초성·학생 번호로 찾을 수 있어요.
        </p>
        <div
          className={
            (searchOpen && activeTab === "approved" ? "pt-14 xl:pt-0 " : "") +
            "content-filter-strip"
          }
        >
          <div
            aria-label="학생 관리 보기"
            aria-orientation="horizontal"
            className="content-filters"
            role="tablist"
          >
            {TAB_ORDER.map((tab) => (
              <button
                aria-busy={loading && activeTab === tab}
                aria-controls={"member-panel-" + tab}
                aria-selected={activeTab === tab}
                className="content-filter whitespace-nowrap"
                disabled={loading || bulkRunning || actingId !== undefined}
                id={"member-tab-" + tab}
                key={tab}
                onClick={() => void switchTab(tab)}
                onFocus={() => setFocusedTab(tab)}
                onKeyDown={(event) => moveTabFocus(event, tab)}
                ref={(element) => {
                  tabRefs.current[tab] = element;
                }}
                role="tab"
                tabIndex={focusedTab === tab ? 0 : -1}
                type="button"
              >
                {tabConfig[tab].label}
                <span
                  className={
                    tab === "pending" && counts.pending > 0
                      ? activeTab === tab
                        ? "font-extrabold text-danger-on-inverse"
                        : "font-extrabold text-danger"
                      : "font-medium"
                  }
                >
                  {loadedTab === undefined ? "—" : counts[tab]}
                </span>
              </button>
            ))}
          </div>
        </div>
      </ContentFrameHeader>
      <ContentFrameBody data-feature-surface="members-main">
        {TAB_ORDER.map((tab) => (
          <div
            aria-busy={activeTab === tab && (loading || !hasActiveData)}
            aria-labelledby={"member-tab-" + tab}
            hidden={activeTab !== tab}
            id={"member-panel-" + tab}
            key={tab}
            role="tabpanel"
            tabIndex={0}
          >
            {activeTab !== tab ? null : activeTab === "approved" ? (
              <ContentSplit
                asideLabel="선택한 학생"
                aside={
                  <ContentPanel className="h-full">
                    {selectedMember === undefined || !hasActiveData ? (
                      <p className="text-sm text-app-muted">
                        목록에서 학생을 선택하면 이름과 번호를 확인할 수 있어요.
                      </p>
                    ) : (
                      <MemberProfilePanel
                        initialMember={selectedMember}
                        key={selectedMember.id}
                        memberId={selectedMember.id}
                        onProfileChanged={(updated) =>
                          setMembers((current) =>
                            current.map((member) => (member.id === updated.id ? updated : member)),
                          )
                        }
                        onRemoved={(message) => {
                          setNotice(message);
                          void load(activeTab);
                        }}
                      />
                    )}
                  </ContentPanel>
                }
              >
                {content}
              </ContentSplit>
            ) : (
              <div>{content}</div>
            )}
          </div>
        ))}
      </ContentFrameBody>
      <ConfirmDialog
        confirmLabel="반 참여 요청 거절"
        description="거절하면 현재 반 참여 요청이 종료됩니다. 입력한 사유가 있으면 해당 학생에게 표시됩니다."
        onCancel={() => setConfirmation(undefined)}
        onConfirm={() => {
          const current = confirmation;
          setConfirmation(undefined);
          if (current !== undefined) void reject(current.target, current.reason);
        }}
        open={confirmation !== undefined}
        returnFocusTo={confirmation?.trigger ?? null}
        title={
          (confirmation?.target.display_name ?? "선택한") + " 학생의 반 참여 요청을 거절할까요?"
        }
      />
    </AppShell>
  );
}

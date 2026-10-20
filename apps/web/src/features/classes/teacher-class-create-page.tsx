import {
  AlertCircle,
  CheckCircle2,
  LoaderCircle,
  LogOut,
  MapPin,
  RefreshCw,
  Search,
  School,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";

import {
  ApiRequestError,
  createClass,
  getBootstrap,
  getSignUpOptions,
  logout,
  searchSchools,
  type BootstrapResponse,
  type CreateClassRequest,
  type SchoolSearchItem,
} from "../../api/auth";
import {
  changedMutationResultMessage,
  clearIdempotentCreateAttempt,
  expiredMutationResultMessage,
  idempotentCreateStorageKey,
  type IdempotentCreateAttempt,
  isMutationOutcomeUnknown,
  persistIdempotentCreateAttempt,
  prepareServerDatedIdempotentCreateAttempt,
  readIdempotentCreateAttempt,
  unavailableMutationStorageMessage,
  unknownMutationResultMessage,
} from "../../lib/idempotent-create";
import { AUTHENTICATED_CLIENT_STATE_CLEARED_EVENT } from "../../lib/authenticated-client-state";
import { codePointLength } from "../../lib/text";
import { AppShell, AppShellBar } from "../layout/app-shell";
import { PageHeader } from "../layout/page-header";

const SCHOOL_KIND_COPY = {
  elementary: "초등학교",
  high: "고등학교",
  middle: "중학교",
} as const;

interface ClassCreateAttemptRequest {
  request: CreateClassRequest;
  school: SchoolSearchItem;
}

const CLASS_CREATE_ATTEMPT_STORAGE_KEY = idempotentCreateStorageKey("classes", "pending-teacher");
const UNKNOWN_CLASS_CREATE_MESSAGE = unknownMutationResultMessage("반 만들기 요청");

function isClassCreateAttemptRequest(value: unknown): value is ClassCreateAttemptRequest {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<ClassCreateAttemptRequest>;
  const request = candidate.request as Partial<CreateClassRequest> | undefined;
  const school = candidate.school as Partial<SchoolSearchItem> | undefined;
  return (
    request !== undefined &&
    Number.isInteger(request.academic_year) &&
    typeof request.edu_office_code === "string" &&
    Number.isInteger(request.expected_student_count) &&
    Number.isInteger(request.grade) &&
    typeof request.name === "string" &&
    typeof request.school_code === "string" &&
    school !== undefined &&
    typeof school.edu_office_code === "string" &&
    typeof school.edu_office_name === "string" &&
    typeof school.region_name === "string" &&
    typeof school.school_code === "string" &&
    (school.school_kind === "elementary" ||
      school.school_kind === "middle" ||
      school.school_kind === "high") &&
    typeof school.school_name === "string"
  );
}

export function TeacherClassCreatePage(): React.JSX.Element {
  const navigate = useNavigate();
  const [bootstrap, setBootstrap] = useState<BootstrapResponse>();
  const [query, setQuery] = useState("");
  const [schools, setSchools] = useState<SchoolSearchItem[]>();
  const [selectedSchool, setSelectedSchool] = useState<SchoolSearchItem>();
  const [schoolSearchExpanded, setSchoolSearchExpanded] = useState(false);
  const [academicYear, setAcademicYear] = useState(2026);
  const [grade, setGrade] = useState(1);
  const [name, setName] = useState("");
  const [expectedStudentCount, setExpectedStudentCount] = useState("30");
  const [searching, setSearching] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createOutcomeUnknown, setCreateOutcomeUnknown] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [error, setError] = useState<string>();
  const mountedRef = useRef(false);
  const authGenerationRef = useRef(0);
  const createErrorRef = useRef<HTMLParagraphElement>(null);
  const [createError, setCreateError] = useState<string>();
  const [errorFocus, setErrorFocus] = useState(0);
  const showCreateError = (message: string) => {
    setCreateError(message);
    setErrorFocus((value) => value + 1);
  };
  useEffect(() => {
    if (errorFocus > 0) createErrorRef.current?.focus();
  }, [errorFocus]);
  useEffect(() => {
    mountedRef.current = true;
    const endSession = () => {
      authGenerationRef.current += 1;
      bootstrapLoadGenerationRef.current += 1;
      schoolSearchGenerationRef.current += 1;
      createAttemptRef.current = undefined;
    };
    window.addEventListener(AUTHENTICATED_CLIENT_STATE_CLEARED_EVENT, endSession);
    return () => {
      mountedRef.current = false;
      authGenerationRef.current += 1;
      window.removeEventListener(AUTHENTICATED_CLIENT_STATE_CLEARED_EVENT, endSession);
    };
  }, []);
  const creatingRef = useRef(false);
  const loggingOutRef = useRef(false);
  const createAttemptRef = useRef<IdempotentCreateAttempt<ClassCreateAttemptRequest> | undefined>(
    undefined,
  );
  const bootstrapLoadGenerationRef = useRef(0);
  const schoolSearchGenerationRef = useRef(0);
  const classDetailsHeadingRef = useRef<HTMLHeadingElement>(null);
  const schoolChosenByUserRef = useRef(false);
  // 만 14세 미만 가입이 닫혀 있으면(P-025②) 초등·중1·중2 반은 학생 대부분이 가입하지 못한다.
  // 반을 만든 뒤가 아니라 만들 때 알린다(ux2 2026-10-15). 그런 학년을 고를 때만 설정을 한 번 읽고,
  // 못 읽으면 안내만 빠진다.
  const mostStudentsUnder14 =
    selectedSchool?.school_kind === "elementary" ||
    (selectedSchool?.school_kind === "middle" && grade <= 2);
  const [under14SignupClosed, setUnder14SignupClosed] = useState<boolean>();
  useEffect(() => {
    if (!mostStudentsUnder14 || under14SignupClosed !== undefined) return;
    const controller = new AbortController();
    void getSignUpOptions(controller.signal)
      .then((options) => setUnder14SignupClosed(options.under_14_signup === false))
      .catch(() => undefined);
    return () => controller.abort();
  }, [mostStudentsUnder14, under14SignupClosed]);

  useEffect(() => {
    if (selectedSchool !== undefined && schoolChosenByUserRef.current && !createOutcomeUnknown) {
      schoolChosenByUserRef.current = false;
      const heading = classDetailsHeadingRef.current;
      heading?.focus({ preventScroll: true });
      if (window.matchMedia?.("(max-width: 767px)").matches) {
        heading?.scrollIntoView?.({ block: "start" });
      }
    }
  }, [selectedSchool, createOutcomeUnknown]);

  const loadBootstrap = useCallback(async (): Promise<void> => {
    const generation = ++bootstrapLoadGenerationRef.current;
    setError(undefined);
    try {
      const result = await getBootstrap();
      if (generation !== bootstrapLoadGenerationRef.current) return;
      if (
        result.destination !== "CREATE_CLASS" ||
        result.teacher_profile?.status !== "active" ||
        !result.allowed_actions.includes("CREATE_CLASS")
      ) {
        clearIdempotentCreateAttempt(CLASS_CREATE_ATTEMPT_STORAGE_KEY);
        void navigate("/bootstrap", { replace: true });
        return;
      }
      setBootstrap(result);
      setAcademicYear(Number(result.server_today.slice(0, 4)));
      const pending = readIdempotentCreateAttempt(
        CLASS_CREATE_ATTEMPT_STORAGE_KEY,
        isClassCreateAttemptRequest,
      );
      createAttemptRef.current = pending;
      if (pending !== undefined) {
        setSchools([pending.request.school]);
        setSelectedSchool(pending.request.school);
        setAcademicYear(pending.request.request.academic_year);
        setGrade(pending.request.request.grade);
        setName(pending.request.request.name);
        setExpectedStudentCount(String(pending.request.request.expected_student_count));
        setCreateOutcomeUnknown(true);
        setCreateError(UNKNOWN_CLASS_CREATE_MESSAGE);
      }
    } catch (requestError) {
      if (generation !== bootstrapLoadGenerationRef.current) return;
      if (requestError instanceof ApiRequestError && requestError.status === 401) {
        void navigate("/login", { replace: true });
        return;
      }
      setError(
        requestError instanceof Error ? requestError.message : "계정 상태를 불러오지 못했습니다.",
      );
    }
  }, [navigate]);

  useEffect(() => {
    void loadBootstrap();
    return () => {
      bootstrapLoadGenerationRef.current += 1;
      schoolSearchGenerationRef.current += 1;
    };
  }, [loadBootstrap]);

  async function submitSearch(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (!mountedRef.current || loggingOutRef.current || creatingRef.current || createOutcomeUnknown)
      return;
    const generation = ++schoolSearchGenerationRef.current;
    const normalizedQuery = query.trim();
    const queryLength = codePointLength(normalizedQuery);
    setError(undefined);
    if (queryLength < 2 || queryLength > 100) {
      setSearching(false);
      setError("학교 이름은 2자 이상 100자 이하로 입력해 주세요.");
      return;
    }

    setSearching(true);
    setSchools(undefined);
    try {
      const result = await searchSchools(normalizedQuery);
      if (generation !== schoolSearchGenerationRef.current) return;
      setSchools(result.schools);
    } catch (requestError) {
      if (generation !== schoolSearchGenerationRef.current) return;
      if (requestError instanceof ApiRequestError && requestError.status === 401) {
        void navigate("/login", { replace: true });
        return;
      }
      setError(
        requestError instanceof Error ? requestError.message : "학교를 검색하지 못했습니다.",
      );
    } finally {
      if (generation === schoolSearchGenerationRef.current) setSearching(false);
    }
  }

  function chooseSchool(school: SchoolSearchItem): void {
    if (
      !mountedRef.current ||
      searching ||
      loggingOutRef.current ||
      creatingRef.current ||
      createOutcomeUnknown
    )
      return;
    schoolSearchGenerationRef.current += 1;
    setSearching(false);
    schoolChosenByUserRef.current = true;
    setSelectedSchool({ ...school });
    setSchoolSearchExpanded(false);
    if (
      selectedSchool?.edu_office_code !== school.edu_office_code ||
      selectedSchool.school_code !== school.school_code
    ) {
      setGrade(1);
    }
    setError(undefined);
  }

  async function submitClass(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (
      !mountedRef.current ||
      creatingRef.current ||
      loggingOutRef.current ||
      searching ||
      bootstrap === undefined
    )
      return;
    if (selectedSchool === undefined) {
      showCreateError("학교를 먼저 선택해 주세요.");
      return;
    }
    const normalizedName = name.trim();
    const nameLength = codePointLength(normalizedName);
    if (nameLength < 1 || nameLength > 40) {
      showCreateError("반 이름은 1자 이상 40자 이하로 입력해 주세요.");
      return;
    }
    const parsedStudentCount = Number(expectedStudentCount);
    if (
      expectedStudentCount.trim() === "" ||
      !Number.isInteger(parsedStudentCount) ||
      parsedStudentCount < 1 ||
      parsedStudentCount > 60
    ) {
      showCreateError("예상 학생 수는 1명 이상 60명 이하의 정수로 입력해 주세요.");
      return;
    }

    const request: CreateClassRequest = {
      academic_year: academicYear,
      edu_office_code: selectedSchool.edu_office_code,
      expected_student_count: parsedStudentCount,
      grade,
      name: normalizedName,
      school_code: selectedSchool.school_code,
    };
    const attemptRequest: ClassCreateAttemptRequest = { request, school: selectedSchool };
    const generation = authGenerationRef.current;
    const isCurrent = () => mountedRef.current && generation === authGenerationRef.current;
    creatingRef.current = true;
    const preparation = prepareServerDatedIdempotentCreateAttempt(
      CLASS_CREATE_ATTEMPT_STORAGE_KEY,
      attemptRequest,
      bootstrap.server_today,
      createAttemptRef.current,
    );
    if (preparation.kind === "mismatch") {
      showCreateError(changedMutationResultMessage());
      creatingRef.current = false;
      return;
    }
    if (preparation.kind === "expired") {
      showCreateError(expiredMutationResultMessage("반 만들기 요청"));
      creatingRef.current = false;
      return;
    }
    if (preparation.kind === "storage-unavailable") {
      showCreateError(unavailableMutationStorageMessage());
      creatingRef.current = false;
      return;
    }

    createAttemptRef.current = preparation.attempt;
    setCreating(true);
    setCreateError(undefined);
    try {
      await createClass(request, preparation.attempt.idempotencyKey);
      if (!isCurrent()) return;
      clearIdempotentCreateAttempt(
        CLASS_CREATE_ATTEMPT_STORAGE_KEY,
        preparation.attempt.idempotencyKey,
      );
      createAttemptRef.current = undefined;
      setCreateOutcomeUnknown(false);
      void navigate("/class/manage", { replace: true });
    } catch (requestError) {
      if (!isCurrent()) return;
      if (isMutationOutcomeUnknown(requestError)) {
        setCreateOutcomeUnknown(true);
        showCreateError(
          persistIdempotentCreateAttempt(CLASS_CREATE_ATTEMPT_STORAGE_KEY, preparation.attempt)
            ? UNKNOWN_CLASS_CREATE_MESSAGE
            : `${UNKNOWN_CLASS_CREATE_MESSAGE} 이 화면을 닫거나 새로고침하지 마세요. 닫으면 저장됐는지 다시 확인할 수 없어요.`,
        );
      } else {
        clearIdempotentCreateAttempt(
          CLASS_CREATE_ATTEMPT_STORAGE_KEY,
          preparation.attempt.idempotencyKey,
        );
        createAttemptRef.current = undefined;
        setCreateOutcomeUnknown(false);
        if (requestError instanceof ApiRequestError && requestError.status === 401) {
          void navigate("/login", { replace: true });
          return;
        }
        showCreateError(
          requestError instanceof Error ? requestError.message : "반을 만들지 못했습니다.",
        );
      }
    } finally {
      if (!isCurrent()) return;
      creatingRef.current = false;
      setCreating(false);
    }
  }

  async function submitLogout(): Promise<void> {
    if (!mountedRef.current || loggingOutRef.current) return;
    loggingOutRef.current = true;
    authGenerationRef.current += 1;
    bootstrapLoadGenerationRef.current += 1;
    schoolSearchGenerationRef.current += 1;
    setSearching(false);
    creatingRef.current = false;
    setCreating(false);
    setLoggingOut(true);
    setError(undefined);
    try {
      await logout();
      if (!mountedRef.current) return;
      void navigate("/login", { replace: true });
    } catch (requestError) {
      if (!mountedRef.current) return;
      if (createAttemptRef.current !== undefined) {
        setCreateOutcomeUnknown(true);
        setCreateError(UNKNOWN_CLASS_CREATE_MESSAGE);
      }
      setError(requestError instanceof Error ? requestError.message : "로그아웃하지 못했습니다.");
      loggingOutRef.current = false;
      setLoggingOut(false);
    }
  }

  if (bootstrap === undefined) {
    return (
      <AppShell centered width="medium">
        <div
          aria-live={error === undefined ? "polite" : "assertive"}
          className="text-center"
          role={error === undefined ? "status" : "alert"}
        >
          {error === undefined ? (
            <LoaderCircle
              aria-hidden="true"
              className="mx-auto animate-spin text-role-primary"
              size={32}
            />
          ) : (
            <AlertCircle aria-hidden="true" className="mx-auto text-rose-500" size={32} />
          )}
          <p className="mt-4 font-bold">{error ?? "반 생성 준비를 확인하고 있어요."}</p>
          {error === undefined ? null : (
            <button
              className="ui-button ui-button-primary mt-5 text-sm"
              onClick={() => void loadBootstrap()}
              type="button"
            >
              <RefreshCw aria-hidden="true" size={17} /> 다시 시도
            </button>
          )}
        </div>
      </AppShell>
    );
  }

  const maximumGrade = selectedSchool?.school_kind === "elementary" ? 6 : 3;

  return (
    <AppShell width="medium">
      <AppShellBar brandTo="/bootstrap" context="반 만들기" />
      <PageHeader
        className="relative [&_.app-page-actions]:absolute [&_.app-page-actions]:right-0 [&_.app-page-actions]:top-4 [&_.app-page-actions]:w-auto [&_.app-page-title]:pr-28 md:[&_.app-page-actions]:static md:[&_.app-page-title]:pr-0"
        actions={
          <button
            aria-busy={loggingOut}
            className="ui-button ui-button-secondary h-11 px-4 text-sm"
            disabled={loggingOut}
            onClick={() => void submitLogout()}
            type="button"
          >
            {loggingOut ? (
              <LoaderCircle aria-hidden="true" className="animate-spin" size={17} />
            ) : (
              <LogOut size={17} />
            )}
            로그아웃
          </button>
        }
        description="학교를 검색해 선택하고 반 정보를 입력하면 반 초대 코드가 자동으로 발급됩니다."
        eyebrow="선생님 시작하기"
        title="반 만들기"
      />

      {error === undefined ? null : (
        <p
          className="mt-5 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-medium text-rose-700"
          role="alert"
        >
          {error}
        </p>
      )}

      <section className="mt-5 rounded-shell border border-app-border bg-app-surface-raised p-5 shadow-card sm:p-6">
        {selectedSchool === undefined ? null : (
          <div className="flex items-center justify-between gap-3 sm:hidden">
            <div className="min-w-0 break-words">
              <p className="text-xs font-bold text-app-muted">선택한 학교</p>
              <strong className="text-app-text">{selectedSchool.school_name}</strong>
              <p className="mt-1 text-xs text-app-muted">
                {selectedSchool.region_name} · {SCHOOL_KIND_COPY[selectedSchool.school_kind]}
              </p>
            </div>
            <button
              type="button"
              className="ui-button ui-button-secondary min-h-11 shrink-0 px-3 text-sm"
              disabled={creating || createOutcomeUnknown || loggingOut}
              onClick={() => setSchoolSearchExpanded((value) => !value)}
              aria-expanded={schoolSearchExpanded}
              aria-controls="class-school-search"
            >
              {schoolSearchExpanded ? "검색 접기" : "학교 변경"}
            </button>
          </div>
        )}
        <div
          id="class-school-search"
          className={
            selectedSchool !== undefined && !schoolSearchExpanded ? "hidden sm:block" : undefined
          }
        >
          <div className="flex items-center gap-3">
            <div className="grid size-11 place-items-center rounded-2xl bg-role-soft text-role-primary">
              <Search size={21} />
            </div>
            <div>
              <p className="text-sm font-bold text-app-muted">1단계</p>
              <h2 className="text-xl font-black text-app-text">학교 검색</h2>
            </div>
          </div>
          <form className="mt-4 flex flex-col gap-3 sm:flex-row" onSubmit={submitSearch}>
            <label className="sr-only" htmlFor="school-query">
              학교 이름
            </label>
            <input
              className="ui-input sm:flex-1"
              disabled={creating || createOutcomeUnknown || loggingOut}
              id="school-query"
              onChange={(event) => setQuery(event.target.value)}
              placeholder="학교 이름을 두 글자 이상 입력"
              value={query}
            />
            <button
              aria-busy={searching}
              className="ui-button ui-button-primary h-12 px-5 text-sm"
              disabled={searching || creating || createOutcomeUnknown || loggingOut}
              type="submit"
            >
              {searching ? (
                <LoaderCircle aria-hidden="true" className="animate-spin" size={17} />
              ) : (
                <Search size={17} />
              )}
              학교 검색
            </button>
          </form>

          {schools === undefined ? null : schools.length === 0 ? (
            <p
              aria-live="polite"
              className="mt-5 rounded-2xl bg-app-surface-muted px-4 py-4 text-sm font-medium text-app-muted"
              role="status"
            >
              학교를 찾을 수 없어요. 관리자에게 추가를 요청해 주세요.
            </p>
          ) : (
            <ul className="mt-4 space-y-2">
              {schools.map((school) => {
                const selected =
                  selectedSchool?.edu_office_code === school.edu_office_code &&
                  selectedSchool.school_code === school.school_code;
                return (
                  <li key={`${school.edu_office_code}-${school.school_code}`}>
                    <button
                      aria-pressed={selected}
                      className={`ui-button ui-button-secondary w-full items-start justify-between gap-4 px-4 py-3 text-left ${
                        selected ? "border-role-border bg-role-soft" : ""
                      }`}
                      disabled={searching || creating || createOutcomeUnknown || loggingOut}
                      onClick={() => chooseSchool(school)}
                      type="button"
                    >
                      <span className="min-w-0 break-words">
                        <strong className="block text-app-text">{school.school_name}</strong>
                        <span className="mt-1 flex items-center gap-1 text-xs text-app-muted">
                          <MapPin size={13} /> {school.region_name} ·{" "}
                          {SCHOOL_KIND_COPY[school.school_kind]}
                        </span>
                        <span className="mt-1 block text-xs text-app-muted">
                          {school.edu_office_name}
                        </span>
                      </span>
                      {selected ? (
                        <CheckCircle2 className="shrink-0 text-role-primary" size={21} />
                      ) : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </section>

      {selectedSchool === undefined ? null : (
        <section className="mt-4 rounded-shell border border-app-border bg-app-surface-raised p-5 shadow-card sm:p-6">
          <div className="flex items-center gap-3">
            <div className="grid size-11 place-items-center rounded-2xl bg-role-soft text-role-primary">
              <School size={21} />
            </div>
            <div>
              <p className="text-sm font-bold text-app-muted">2단계</p>
              <h2
                className="scroll-mt-6 text-xl font-black text-app-text"
                ref={classDetailsHeadingRef}
                tabIndex={-1}
              >
                반 정보 입력
              </h2>
            </div>
          </div>
          <p
            className={`mt-4 rounded-2xl bg-app-surface-muted px-4 py-3 text-sm font-bold text-app-text ${!schoolSearchExpanded ? "hidden sm:block" : ""}`}
          >
            {selectedSchool.school_name} · {SCHOOL_KIND_COPY[selectedSchool.school_kind]}
          </p>

          <form className="mt-4 grid grid-cols-2 gap-4" onSubmit={submitClass}>
            <label className="grid gap-2 text-sm font-bold text-app-text">
              학년도
              <input
                className="ui-input"
                disabled={creating || createOutcomeUnknown || loggingOut}
                max={2100}
                min={2020}
                onChange={(event) => setAcademicYear(Number(event.target.value))}
                required
                type="number"
                value={academicYear}
              />
            </label>
            <label className="grid gap-2 text-sm font-bold text-app-text">
              학년
              <select
                className="ui-input"
                disabled={creating || createOutcomeUnknown || loggingOut}
                onChange={(event) => setGrade(Number(event.target.value))}
                value={grade}
              >
                {Array.from({ length: maximumGrade }, (_, index) => index + 1).map((value) => (
                  <option key={value} value={value}>
                    {value}학년
                  </option>
                ))}
              </select>
            </label>
            {under14SignupClosed === true && mostStudentsUnder14 ? (
              <p
                className="col-span-2 rounded-2xl border border-warning-border bg-warning-surface px-4 py-3 text-sm leading-6 text-warning-text"
                data-under-14-notice="true"
                role="status"
              >
                이 학년 학생은 대부분 만 14세 미만이라 지금은 가입할 수 없어요. 반은 만들 수 있지만
                만 14세가 지난 학생만 참여할 수 있어요.
              </p>
            ) : null}
            <label className="col-span-2 grid gap-2 text-sm font-bold text-app-text sm:col-span-1">
              반 이름
              <input
                className="ui-input"
                disabled={creating || createOutcomeUnknown || loggingOut}
                onChange={(event) => setName(event.target.value)}
                placeholder="예: 1반"
                required
                value={name}
              />
            </label>
            <label className="col-span-2 grid gap-2 text-sm font-bold text-app-text sm:col-span-1">
              예상 학생 수
              <input
                className="ui-input"
                disabled={creating || createOutcomeUnknown || loggingOut}
                max={60}
                min={1}
                onChange={(event) => setExpectedStudentCount(event.target.value)}
                required
                type="number"
                value={expectedStudentCount}
              />
            </label>
            {createError === undefined ? null : (
              <p
                id="class-create-error"
                ref={createErrorRef}
                tabIndex={-1}
                role="alert"
                className="col-span-2 scroll-mt-24 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-medium text-rose-700"
              >
                {createError}
              </p>
            )}
            <button
              aria-describedby={createError === undefined ? undefined : "class-create-error"}
              aria-busy={creating}
              className="ui-button ui-button-primary col-span-2 mt-2 h-12 px-5 text-sm"
              disabled={searching || creating || loggingOut}
              type="submit"
            >
              {creating ? (
                <LoaderCircle aria-hidden="true" className="animate-spin" size={18} />
              ) : (
                <School size={18} />
              )}
              {createOutcomeUnknown ? "결과 다시 확인" : "반 만들기"}
            </button>
          </form>
        </section>
      )}
    </AppShell>
  );
}

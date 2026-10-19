import {
  AlertCircle,
  ChevronRight,
  DoorOpen,
  KeyRound,
  Link2,
  LoaderCircle,
  LogOut,
  RefreshCw,
  Trash2,
  UserRound,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";

import {
  ApiRequestError,
  getBootstrap,
  getCurrentClass,
  leaveCurrentClass,
  logout,
  type BootstrapResponse,
  type CurrentClassResponse,
} from "../../api/auth";
import { SchoolDetailsPanel } from "../classes/school-details-panel";
import { AppShell } from "../layout/app-shell";
import { ConfirmDialog } from "../layout/confirm-dialog";
import { ContentFrameBody, ContentFrameHeader } from "../layout/content-frame";
import { ProfilePhotoSettings } from "../profile-photos/profile-photo-settings";
import { AppearanceControl } from "../theme";
import { PushNotificationPanel } from "./push-notification-panel";
import {
  getSocialConnections,
  socialProviderLabels,
  type SocialConnections,
} from "../../api/social-auth";

function StudentLogoutButton({
  className = "",
  disabled = false,
  loggingOut,
  onLogout,
}: {
  className?: string;
  disabled?: boolean;
  loggingOut: boolean;
  onLogout: () => void;
}): React.JSX.Element {
  return (
    <button
      aria-busy={loggingOut}
      className={`ui-button ui-button-secondary min-h-11 text-sm ${className}`}
      data-student-logout="true"
      disabled={disabled || loggingOut}
      onClick={onLogout}
      type="button"
    >
      {loggingOut ? (
        <LoaderCircle aria-hidden="true" className="animate-spin" size={17} />
      ) : (
        <LogOut aria-hidden="true" size={17} />
      )}
      {loggingOut ? "로그아웃 중..." : "로그아웃"}
    </button>
  );
}

/*
 * 2026-09-27 확정 시안(더보기설정_v3_확정): 설정은 관리형 '줄 목록' — 프로필 · 화면 · 알림 · 계정,
 * 맨 아래 '조심해서 쓰는 기능'(반 나가기 · 계정 삭제)만 빨간 줄. 기능 · 확인 절차는 그대로.
 */
const ROW_CLASS =
  "flex min-h-14 w-full items-center gap-3 px-4 py-2.5 text-left transition hover:bg-role-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-role-primary disabled:opacity-60";

function SettingsGroup({
  children,
  label,
  section,
}: {
  children: React.ReactNode;
  label: string;
  section: string;
}): React.JSX.Element {
  return (
    <section aria-labelledby={`settings-${section}-title`} data-settings-section={section}>
      <h2 className="mb-2 text-sm font-bold text-app-muted" id={`settings-${section}-title`}>
        {label}
      </h2>
      <div className="divide-y divide-app-border overflow-hidden rounded-card bg-app-surface shadow-card">
        {children}
      </div>
    </section>
  );
}

function RowText({
  danger = false,
  description,
  icon: Icon,
  label,
}: {
  danger?: boolean;
  description?: string | undefined;
  icon: LucideIcon;
  label: string;
}): React.JSX.Element {
  return (
    <>
      <Icon
        aria-hidden="true"
        className={`shrink-0 ${danger ? "text-danger-text" : "text-role-primary"}`}
        size={20}
      />
      <span className="min-w-0 flex-1">
        <span className={`block font-bold ${danger ? "text-danger-text" : "text-app-text"}`}>
          {label}
        </span>
        {description === undefined ? null : (
          <span className="mt-0.5 block break-keep text-xs text-app-muted [overflow-wrap:anywhere]">
            {description}
          </span>
        )}
      </span>
    </>
  );
}

function ValueRow({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex min-h-14 items-center justify-between gap-3 px-4 py-2.5">
      <span className="shrink-0 font-bold text-app-text">{label}</span>
      <span className="min-w-0 text-right text-sm text-app-muted [overflow-wrap:anywhere]">
        {value}
      </span>
    </div>
  );
}

/**
 * 학생이 맞는 반(어느 선생님 반)에 들어왔는지 확인할 곳이 없었다(총검수 A1-05, 2026-10-03 사용자
 * 결정: 담임·학년도·학년만, 학생 수는 빼고). 못 불러오면 줄을 숨긴다.
 */
function StudentClassRows(): React.JSX.Element | null {
  const [current, setCurrent] = useState<CurrentClassResponse>();
  useEffect(() => {
    let active = true;
    getCurrentClass().then(
      (result) => {
        if (active) setCurrent(result);
      },
      () => undefined,
    );
    return () => {
      active = false;
    };
  }, []);
  if (current === undefined) return null;
  return (
    <>
      <ValueRow label="담임 선생님" value={current.teacher_display_name} />
      <ValueRow
        label="학년도 · 학년"
        value={`${current.academic_year}학년도 · ${current.grade}학년`}
      />
    </>
  );
}

/** 2026-10-01 사용자 요청: 빠른 로그인 연결을 설정의 별도 줄로. 서버에서 꺼져 있으면 줄을 보이지 않는다. */
function SocialConnectionsRow(): React.JSX.Element | null {
  const [data, setData] = useState<SocialConnections>();
  useEffect(() => {
    const controller = new AbortController();
    void getSocialConnections(controller.signal)
      .then(setData)
      .catch(() => undefined);
    return () => controller.abort();
  }, []);
  if (!data?.enabled) return null;
  const linked = data.connections.map((provider) => socialProviderLabels[provider]);
  return (
    <Link aria-label="빠른 로그인 연결" className={ROW_CLASS} to="/account/social">
      <RowText
        description={
          linked.length > 0 ? `${linked.join("·")} 연결됨` : "구글·카카오·네이버로 바로 로그인"
        }
        icon={Link2}
        label="빠른 로그인 연결"
      />
      <ChevronRight aria-hidden="true" className="shrink-0 text-app-muted" size={18} />
    </Link>
  );
}

export function StudentSettingsPage(): React.JSX.Element {
  const navigate = useNavigate();
  const [bootstrap, setBootstrap] = useState<BootstrapResponse>();
  const [error, setError] = useState<string>();
  const [leaving, setLeaving] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState<string>();
  const [leaveDialogOpen, setLeaveDialogOpen] = useState(false);
  const leaveButtonRef = useRef<HTMLButtonElement>(null);
  const bootstrapLoadGenerationRef = useRef(0);

  const loadBootstrap = useCallback(async (): Promise<void> => {
    const generation = ++bootstrapLoadGenerationRef.current;
    setError(undefined);
    try {
      const result = await getBootstrap();
      if (generation !== bootstrapLoadGenerationRef.current) return;
      if (
        result.destination !== "HOME" ||
        !(
          result.current_membership?.role === "teacher" ||
          (result.current_membership?.role === "student" &&
            result.allowed_actions.includes("LEAVE_CLASS"))
        )
      ) {
        void navigate("/bootstrap", { replace: true });
        return;
      }
      setBootstrap(result);
    } catch (requestError) {
      if (generation !== bootstrapLoadGenerationRef.current) return;
      if (requestError instanceof ApiRequestError && requestError.status === 401) {
        void navigate("/login", { replace: true });
        return;
      }
      setError(
        requestError instanceof Error ? requestError.message : "설정을 불러오지 못했습니다.",
      );
    }
  }, [navigate]);

  useEffect(() => {
    void loadBootstrap();
    return () => {
      bootstrapLoadGenerationRef.current += 1;
    };
  }, [loadBootstrap]);

  async function submitLeave(): Promise<void> {
    setLeaving(true);
    setError(undefined);
    try {
      await leaveCurrentClass();
      void navigate("/bootstrap", { replace: true });
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "반에서 나가지 못했습니다.");
      setLeaving(false);
    }
  }

  async function submitLogout(): Promise<void> {
    setLoggingOut(true);
    setLogoutError(undefined);
    try {
      await logout();
      void navigate("/login", { replace: true });
    } catch (requestError) {
      setLogoutError(
        requestError instanceof Error ? requestError.message : "로그아웃하지 못했습니다.",
      );
      setLoggingOut(false);
    }
  }

  if (bootstrap === undefined) {
    return (
      <AppShell centered width="narrow">
        {error === undefined ? (
          <div className="text-center">
            <div
              aria-label="설정을 불러오고 있어요."
              aria-live="polite"
              className="text-role-primary"
              role="status"
            >
              <LoaderCircle aria-hidden="true" className="mx-auto animate-spin" size={32} />
              <span className="sr-only">설정을 불러오고 있어요.</span>
            </div>
            <p className="mt-5 break-keep text-sm leading-6 text-app-muted">
              공용 기기에서는 설정을 기다리는 중에도 현재 기기에서 로그아웃할 수 있어요.
            </p>
            <StudentLogoutButton
              className="mx-auto mt-5"
              loggingOut={loggingOut}
              onLogout={() => void submitLogout()}
            />
            {logoutError === undefined ? null : (
              <p className="mt-3 text-sm font-bold text-danger-text" role="alert">
                {logoutError}
              </p>
            )}
          </div>
        ) : (
          <div aria-live="assertive" className="text-center text-danger-text" role="alert">
            <AlertCircle aria-hidden="true" className="mx-auto" size={32} />
            <p className="mt-3 font-bold">{error}</p>
            <div className="mt-5 flex flex-wrap justify-center gap-3">
              <button
                className="ui-button ui-button-primary text-sm"
                disabled={loggingOut}
                onClick={() => void loadBootstrap()}
                type="button"
              >
                <RefreshCw aria-hidden="true" size={17} /> 다시 시도
              </button>
              <StudentLogoutButton loggingOut={loggingOut} onLogout={() => void submitLogout()} />
            </div>
            {logoutError === undefined ? null : (
              <p className="mt-3 text-sm font-bold">{logoutError}</p>
            )}
          </div>
        )}
      </AppShell>
    );
  }

  const teacher = bootstrap.current_membership?.role === "teacher";
  const canDelete = bootstrap.allowed_actions.includes("DELETE_ACCOUNT");
  const accountGroup = (
    <>
      <SettingsGroup label="계정" section="security">
        <Link aria-label="비밀번호 변경" className={ROW_CLASS} to="/account/password">
          <RowText
            description="바꾸면 모든 기기에서 로그아웃돼요"
            icon={KeyRound}
            label="비밀번호 변경"
          />
          <ChevronRight aria-hidden="true" className="shrink-0 text-app-muted" size={18} />
        </Link>
        <SocialConnectionsRow />
        <button
          aria-busy={loggingOut}
          aria-label={loggingOut ? "로그아웃 중..." : "로그아웃"}
          className={ROW_CLASS}
          data-student-logout="true"
          disabled={leaving || loggingOut}
          onClick={() => void submitLogout()}
          type="button"
        >
          {loggingOut ? (
            <LoaderCircle
              aria-hidden="true"
              className="shrink-0 animate-spin text-role-primary"
              size={20}
            />
          ) : null}
          <RowText
            description="공용 기기에서는 쓴 뒤 꼭 로그아웃해 주세요"
            icon={LogOut}
            label={loggingOut ? "로그아웃 중..." : "로그아웃"}
          />
        </button>
      </SettingsGroup>
      {logoutError === undefined ? null : (
        <p
          className="rounded-xl border border-danger-border bg-danger-surface px-3 py-2 text-sm font-medium text-danger-text"
          role="alert"
        >
          {logoutError}
        </p>
      )}
    </>
  );

  return (
    <AppShell
      alignedFrame
      contentFrame
      navigationRole={teacher ? "teacher" : "student"}
      width="wide"
    >
      <ContentFrameHeader title="설정" />

      <ContentFrameBody>
        <div className="grid gap-5" data-settings-layout="stack">
          {/* 2026-10-03 사용자 결정: 휴대폰 학생이 공용 기기에서 바로 로그아웃하도록 계정 묶음을 맨 위로.
              교사 화면은 시안 순서 그대로(아래 원래 자리). */}
          {teacher ? null : accountGroup}

          <SettingsGroup label="프로필" section="profile">
            {/* 사진 기능이 꺼져 있으면(USE_PROFILE_PHOTOS 없음) 요청도 하지 않는다(이름 첫 글자 유지). */}
            {bootstrap.allowed_actions.includes("USE_PROFILE_PHOTOS") ? (
              <ProfilePhotoSettings
                key={bootstrap.session_context ?? bootstrap.current_membership?.id}
                name={
                  bootstrap.current_membership?.display_name_in_class ??
                  bootstrap.account.display_name
                }
              />
            ) : null}
            <Link aria-label="내 이름 변경" className={ROW_CLASS} to="/account/profile">
              <RowText
                description={bootstrap.account.display_name}
                icon={UserRound}
                label="내 이름 변경"
              />
              <ChevronRight aria-hidden="true" className="shrink-0 text-app-muted" size={18} />
            </Link>
            <ValueRow
              label="반에서 보이는 이름"
              value={
                bootstrap.current_membership?.display_name_in_class ??
                bootstrap.account.display_name
              }
            />
            {teacher ? null : (
              <ValueRow
                label="학생 번호"
                value={
                  bootstrap.current_membership?.student_number == null
                    ? "미지정"
                    : `${bootstrap.current_membership.student_number}번`
                }
              />
            )}
            <ValueRow label="현재 반" value={bootstrap.current_class?.name ?? "-"} />
            {teacher ? null : <StudentClassRows />}
          </SettingsGroup>

          <section aria-labelledby="settings-appearance-title" data-settings-section="appearance">
            <h2 className="mb-2 text-sm font-bold text-app-muted" id="settings-appearance-title">
              화면
            </h2>
            <div className="rounded-card bg-app-surface p-4 shadow-card">
              <AppearanceControl label="테마 선택" />
            </div>
          </section>

          {/* 교사에게 보내는 알림이 아직 없어 교사에게는 '알림 받기'를 보이지 않는다(총검수 B1-02). */}
          {teacher ? null : <PushNotificationPanel />}

          {teacher ? accountGroup : null}

          {/* 학교 정보 칸은 자체 상자가 있어 겉 상자를 두지 않는다(상자 속 상자 금지). */}
          <section aria-label="학교 정보" data-settings-section="class">
            <SchoolDetailsPanel
              school={{
                school_address: bootstrap.current_class?.school_address ?? null,
                school_homepage_url: bootstrap.current_class?.school_homepage_url ?? null,
                school_name: bootstrap.current_class?.school_name ?? "우리 학교",
                school_phone_number: bootstrap.current_class?.school_phone_number ?? null,
              }}
            />
          </section>

          {!teacher || canDelete ? (
            <SettingsGroup label="조심해서 쓰는 기능" section="danger">
              {!teacher ? (
                <button
                  aria-busy={leaving}
                  aria-label="현재 반 나가기"
                  className={ROW_CLASS}
                  disabled={leaving || loggingOut}
                  onClick={() => setLeaveDialogOpen(true)}
                  ref={leaveButtonRef}
                  type="button"
                >
                  {leaving ? (
                    <LoaderCircle
                      aria-hidden="true"
                      className="shrink-0 animate-spin text-danger-text"
                      size={20}
                    />
                  ) : null}
                  <RowText
                    danger
                    description="다시 들어오려면 초대 코드와 선생님 승인이 필요해요"
                    icon={DoorOpen}
                    label="현재 반 나가기"
                  />
                </button>
              ) : null}
              {canDelete ? (
                <Link aria-label="계정 삭제 알아보기" className={ROW_CLASS} to="/account/deletion">
                  <RowText
                    danger
                    description="삭제한 계정은 복구할 수 없어요 · 한 번 더 확인해요"
                    icon={Trash2}
                    label="계정 삭제 알아보기"
                  />
                  <ChevronRight aria-hidden="true" className="shrink-0 text-app-muted" size={18} />
                </Link>
              ) : null}
            </SettingsGroup>
          ) : null}

          {error === undefined ? null : (
            <p
              className="rounded-2xl border border-danger-border bg-danger-surface px-4 py-3 text-sm font-medium text-danger-text"
              role="alert"
            >
              {error}
            </p>
          )}
        </div>
      </ContentFrameBody>

      <ConfirmDialog
        confirmLabel="반 나가기"
        description="나가면 반 자료에 접근할 수 없고, 다시 참여하려면 반 초대 코드와 선생님의 승인이 필요해요."
        onCancel={() => setLeaveDialogOpen(false)}
        onConfirm={() => {
          setLeaveDialogOpen(false);
          void submitLeave();
        }}
        open={leaveDialogOpen}
        returnFocusTo={leaveButtonRef.current}
        title="현재 반에서 나갈까요?"
      />
    </AppShell>
  );
}

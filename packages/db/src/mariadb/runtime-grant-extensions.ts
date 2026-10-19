import { adminPasskeyGrants, socialLoginGrants } from "./auth-extension-grants.js";
import { classArchiveGrants, legacyClassArchiveGrants } from "./class-archive-grants.js";
import {
  requiredMariaDbRuntimeGrants as baselineGrants,
  type MariaDbRuntimeGrantProfile as BaselineProfile,
} from "./runtime-grant-profile.js";

export type MariaDbRuntimeGrantProfile =
  | BaselineProfile
  | "app_mail_management_v1"
  | "app_poll_close_v1"
  | "app_push_subscriptions_v1"
  | "app_push_deliveries_v1"
  | "app_schedule_links_v1"
  | "app_help_requests_v1"
  | "app_help_chat_v1"
  | "app_teacher_library_v1"
  | "app_profile_photos_v1"
  | "app_class_chat_v1"
  | AuthExtendedAppProfile
  | PhotoExtendedAppProfile
  | BirthDateExtendedAppProfile
  | AccessLogExtendedAppProfile
  | PollEditExtendedAppProfile
  | TeacherLibraryExtendedAppProfile
  | "operator_commands_v1"
  | "retention_mail_logs_v1"
  | "retention_audit_consents_v1"
  | "retention_admin_records_v1"
  | "retention_class_archives_v1"
  | "retention_class_archives_legacy_v1";

/** 인증 확장(원장 90~93)은 기능 켜기와 따로, DB에 "설치된" 것만 고른다. */
export type MariaDbAuthDatabaseExtensions = "none" | "passkeys" | "social" | "all";
type AuthExtendedAppProfile =
  | "app_help_chat_passkeys_v1"
  | "app_help_chat_social_v1"
  | "app_help_chat_passkeys_social_v1"
  | "app_class_chat_passkeys_v1"
  | "app_class_chat_social_v1"
  | "app_class_chat_passkeys_social_v1";
type PhotoExtendedAppProfile =
  | "app_help_chat_photos_v1"
  | "app_help_chat_photos_passkeys_v1"
  | "app_help_chat_photos_social_v1"
  | "app_help_chat_photos_passkeys_social_v1"
  | "app_class_chat_photos_v1"
  | "app_class_chat_photos_passkeys_v1"
  | "app_class_chat_photos_social_v1"
  | "app_class_chat_photos_passkeys_social_v1";
/** 생년월일(원장 99·100)을 더한 고정 프로필 — 기존 16개 각각에 "_birthdates"를 붙인 16개. */
type BirthDateBaseProfile =
  "app_help_chat_v1" | "app_class_chat_v1" | AuthExtendedAppProfile | PhotoExtendedAppProfile;
type BirthDateExtendedAppProfile = BirthDateBaseProfile extends `${infer Name}_v1`
  ? `${Name}_birthdates_v1`
  : never;
/** 관리자 접속기록(원장 101·102)을 더한 고정 프로필 — 위 32개 각각에 "_accesslogs"를 붙인 32개. */
type AccessLogBaseProfile = BirthDateBaseProfile | BirthDateExtendedAppProfile;
type AccessLogExtendedAppProfile = AccessLogBaseProfile extends `${infer Name}_v1`
  ? `${Name}_accesslogs_v1`
  : never;
/** 진행 중 투표 내용 수정(원장 107·108)을 더한 고정 프로필 — 위 64개 각각에 "_polledit"를 붙인 64개. */
type PollEditBaseProfile = AccessLogBaseProfile | AccessLogExtendedAppProfile;
type PollEditExtendedAppProfile = PollEditBaseProfile extends `${infer Name}_v1`
  ? `${Name}_polledit_v1`
  : never;
/** 자료함 설치(원장 86·87)는 기능 개방과 무관한 고정 조합이다. */
type TeacherLibraryBaseProfile = PollEditBaseProfile | PollEditExtendedAppProfile;
type TeacherLibraryExtendedAppProfile = TeacherLibraryBaseProfile extends `${infer Name}_v1`
  ? `${Name}_teacherlibrary_v1`
  : never;
const operatorCommands = Object.freeze(
  [
    ...baselineGrants("operator", undefined)!,
    "table|operator_transaction_lock_keys|SELECT|*",
    "table|public_holidays|DELETE|*",
  ].sort(),
);
const appMailManagement = Object.freeze(
  [
    ...baselineGrants("app", undefined)!,
    "table|admin_signup_approvals|INSERT|recipient_email",
    "table|admin_signup_approvals|INSERT|code_encrypted",
    "table|teacher_profiles|INSERT|created_by_signup_approval_id",
    "table|mail_templates|SELECT|*",
    "table|mail_templates|INSERT|*",
    "table|mail_templates|UPDATE|*",
    "table|mail_delivery_logs|SELECT|*",
    "table|mail_delivery_logs|INSERT|*",
    "table|mail_delivery_logs|UPDATE|status",
    "table|mail_delivery_logs|UPDATE|failure_code",
    "table|mail_delivery_logs|UPDATE|completed_at",
  ].sort(),
);

const appPollClose = Object.freeze(
  [...appMailManagement, "table|polls|UPDATE|closed_at", "table|polls|UPDATE|row_version"].sort(),
);

// 통합순7 웹 푸시 구독(원장 76·77). endpoint·created_at 수정 권한은 주지 않는다.
const appPushSubscriptions = Object.freeze(
  [
    ...appPollClose,
    "table|push_subscriptions|SELECT|*",
    "table|push_subscriptions|INSERT|*",
    "table|push_subscriptions|DELETE|*",
    "table|push_subscriptions|UPDATE|user_id",
    "table|push_subscriptions|UPDATE|p256dh",
    "table|push_subscriptions|UPDATE|auth_secret",
    "table|push_subscriptions|UPDATE|updated_at",
  ].sort(),
);

// 통합순7 웹 푸시 대기열(원장 78·79). 발송 결과 열만 수정할 수 있다.
const appPushDeliveries = Object.freeze(
  [
    ...appPushSubscriptions,
    "table|push_deliveries|SELECT|*",
    "table|push_deliveries|INSERT|*",
    "table|push_deliveries|DELETE|*",
    "table|push_deliveries|UPDATE|status",
    "table|push_deliveries|UPDATE|accepted_count",
    "table|push_deliveries|UPDATE|failed_count",
    "table|push_deliveries|UPDATE|removed_count",
    "table|push_deliveries|UPDATE|completed_at",
  ].sort(),
);

// 통합순8 일정↔공지·준비물 연결(원장 80·81). 연결은 만들고 지우기만 하며 수정하지 않는다.
const appScheduleLinks = Object.freeze(
  [
    ...appPushDeliveries,
    "table|schedule_notice_links|SELECT|*",
    "table|schedule_notice_links|INSERT|*",
    "table|schedule_notice_links|DELETE|*",
    "table|schedule_supply_links|SELECT|*",
    "table|schedule_supply_links|INSERT|*",
    "table|schedule_supply_links|DELETE|*",
  ].sort(),
);

// 통합순9 도움 요청(원장 82·83). 요청은 지우지 않고 상태·답변·종료 시각만 바꾼다.
const appHelpRequests = Object.freeze(
  [
    ...appScheduleLinks,
    "table|help_requests|SELECT|*",
    "table|help_requests|INSERT|*",
    "table|help_requests|UPDATE|closed_at",
    "table|help_requests|UPDATE|reply",
    "table|help_requests|UPDATE|status",
  ].sort(),
);

// T-HELP-CHAT 도움 요청 자유 대화(원장 84·85). 주고받은 말은 쓰기·보기만 한다(수정·삭제 없음).
// 운영 DB에 84·85를 적용한 뒤에만 API가 이 프로필로 바꾼다 — 먼저 바꾸면 기동 검사가 실패한다.
const appHelpChat = Object.freeze(
  [
    ...appHelpRequests,
    "table|help_request_messages|SELECT|*",
    "table|help_request_messages|INSERT|*",
  ].sort(),
);

const teacherLibraryGrants = Object.freeze([
  "table|teacher_library_items|SELECT|*",
  "table|teacher_library_items|INSERT|*",
  "table|teacher_library_items|DELETE|*",
]);

// S2 교사 자료함(원장 86·87). 자료는 담기·보기·지우기만 한다(수정 없음).
// 운영 DB에 86·87을 적용한 뒤에만 API가 이 프로필로 바꾼다 — 먼저 바꾸면 기동 검사가 실패한다.
const appTeacherLibrary = Object.freeze([...appHelpChat, ...teacherLibraryGrants].sort());

// T-PHOTO 프로필 사진(원장 96·97). 다른 설치 확장과 합친 고정 프로필은 아래 photoExtendedProfiles.
const profilePhotoGrants = Object.freeze([
  "table|user_profile_photos|SELECT|*",
  "table|user_profile_photos|INSERT|*",
  "table|user_profile_photos|DELETE|*",
  "table|user_profile_photos|UPDATE|photo_version",
  "table|user_profile_photos|UPDATE|image_bytes",
  "table|user_profile_photos|UPDATE|updated_at",
]);
const appProfilePhotos = Object.freeze([...appHelpChat, ...profilePhotoGrants].sort());

// T-CLASS-CHAT 반 단체 대화(원장 94·95). 말은 쓰기·보기·가리기만 하고 지우지 않는다. 말하기 제한만 지운다(해제).
// 운영 DB에 94·95를 적용한 뒤에만 API가 이 프로필로 바꾼다. 다른 선택 기능(자료함·프로필 사진·관리자 패스키)과
// 함께 켤 때는 합친 프로필이 필요하다 — 배포 검수 항목.
const appClassChat = Object.freeze(
  [
    ...appHelpChat,
    "table|class_chat_rooms|SELECT|*",
    "table|class_chat_rooms|INSERT|*",
    "table|class_chat_rooms|UPDATE|is_open",
    "table|class_chat_rooms|UPDATE|updated_at",
    "table|class_chat_rooms|UPDATE|updated_by_member_id",
    "table|class_chat_messages|SELECT|*",
    "table|class_chat_messages|INSERT|*",
    "table|class_chat_messages|UPDATE|hidden_at",
    "table|class_chat_messages|UPDATE|hidden_by_member_id",
    "table|class_chat_mutes|SELECT|*",
    "table|class_chat_mutes|INSERT|*",
    "table|class_chat_mutes|DELETE|*",
    "table|class_chat_mutes|UPDATE|muted_until",
    "table|class_chat_mutes|UPDATE|created_by_member_id",
    "table|class_chat_mutes|UPDATE|created_at",
    "table|class_chat_reports|SELECT|*",
    "table|class_chat_reports|INSERT|*",
    "table|class_chat_reports|UPDATE|resolved_at",
    "table|class_chat_reports|UPDATE|resolved_by_member_id",
  ].sort(),
);

const withAuth = (base: readonly string[], extensions: readonly (readonly string[])[]) =>
  Object.freeze([...base, ...extensions.flat()].sort());
const authExtendedProfiles: Readonly<Record<AuthExtendedAppProfile, readonly string[]>> = {
  app_help_chat_passkeys_v1: withAuth(appHelpChat, [adminPasskeyGrants]),
  app_help_chat_social_v1: withAuth(appHelpChat, [socialLoginGrants]),
  app_help_chat_passkeys_social_v1: withAuth(appHelpChat, [adminPasskeyGrants, socialLoginGrants]),
  app_class_chat_passkeys_v1: withAuth(appClassChat, [adminPasskeyGrants]),
  app_class_chat_social_v1: withAuth(appClassChat, [socialLoginGrants]),
  app_class_chat_passkeys_social_v1: withAuth(appClassChat, [
    adminPasskeyGrants,
    socialLoginGrants,
  ]),
};
// 2026-09-29 사용자 결정: 조립식 대신 고정 이름을 8→16개로 늘린다(사진 설치 여부 × 기존 8개).
const photoExtendedProfiles: Readonly<Record<PhotoExtendedAppProfile, readonly string[]>> = {
  app_help_chat_photos_v1: withAuth(appHelpChat, [profilePhotoGrants]),
  app_help_chat_photos_passkeys_v1: withAuth(appHelpChat, [profilePhotoGrants, adminPasskeyGrants]),
  app_help_chat_photos_social_v1: withAuth(appHelpChat, [profilePhotoGrants, socialLoginGrants]),
  app_help_chat_photos_passkeys_social_v1: withAuth(appHelpChat, [
    profilePhotoGrants,
    adminPasskeyGrants,
    socialLoginGrants,
  ]),
  app_class_chat_photos_v1: withAuth(appClassChat, [profilePhotoGrants]),
  app_class_chat_photos_passkeys_v1: withAuth(appClassChat, [
    profilePhotoGrants,
    adminPasskeyGrants,
  ]),
  app_class_chat_photos_social_v1: withAuth(appClassChat, [profilePhotoGrants, socialLoginGrants]),
  app_class_chat_photos_passkeys_social_v1: withAuth(appClassChat, [
    profilePhotoGrants,
    adminPasskeyGrants,
    socialLoginGrants,
  ]),
};

// 생년월일(원장 99·100): 가입 때 넣고 설정에서 고치는 두 칸만. 읽기는 기존 users SELECT로 된다.
const birthDateGrants = Object.freeze([
  "table|users|INSERT|birth_date",
  "table|users|INSERT|birthday_shared",
  "table|users|UPDATE|birth_date",
  "table|users|UPDATE|birthday_shared",
]);
const birthDateBaseProfiles: Readonly<Record<BirthDateBaseProfile, readonly string[]>> = {
  app_help_chat_v1: appHelpChat,
  app_class_chat_v1: appClassChat,
  ...authExtendedProfiles,
  ...photoExtendedProfiles,
};
// 이름은 위 16개에서만 만든다(닫힌 목록) — 외부 입력으로 임의 조합을 만들지 않는다.
const birthDateExtendedProfiles = Object.freeze(
  Object.fromEntries(
    Object.entries(birthDateBaseProfiles).map(([name, grants]) => [
      name.replace(/_v1$/u, "_birthdates_v1"),
      withAuth(grants, [birthDateGrants]),
    ]),
  ),
) as Readonly<Record<BirthDateExtendedAppProfile, readonly string[]>>;

// 관리자 접속기록(원장 101·102): 조회할 때 넣고 점검 화면에서 읽기만 한다(고치기·지우기 없음).
const accessLogGrants = Object.freeze([
  "table|admin_access_logs|INSERT|*",
  "table|admin_access_logs|SELECT|*",
]);
// 이름은 위 32개(생년월일 포함)에서만 만든다(닫힌 목록).
const accessLogExtendedProfiles = Object.freeze(
  Object.fromEntries(
    Object.entries({ ...birthDateBaseProfiles, ...birthDateExtendedProfiles }).map(
      ([name, grants]) => [
        name.replace(/_v1$/u, "_accesslogs_v1"),
        withAuth(grants, [accessLogGrants]),
      ],
    ),
  ),
) as Readonly<Record<AccessLogExtendedAppProfile, readonly string[]>>;

// 진행 중 투표 내용 수정(원장 107·108, 2026-10-04 사용자 결정): 제목·설명·선택지 수·마감 시간 네 칸만.
// 선택지 바꾸기는 기존 poll_options DELETE·INSERT로 한다(0표일 때만 — API가 투표 행 잠금 안에서 지킨다).
const pollEditGrants = Object.freeze(
  ["title", "description", "option_count", "closes_at"].map(
    (column) => `table|polls|UPDATE|${column}`,
  ),
);
// 이름은 위 64개(접속기록 포함)에서만 만든다(닫힌 목록).
const pollEditExtendedProfiles = Object.freeze(
  Object.fromEntries(
    Object.entries({
      ...birthDateBaseProfiles,
      ...birthDateExtendedProfiles,
      ...accessLogExtendedProfiles,
    }).map(([name, grants]) => [
      name.replace(/_v1$/u, "_polledit_v1"),
      withAuth(grants, [pollEditGrants]),
    ]),
  ),
) as Readonly<Record<PollEditExtendedAppProfile, readonly string[]>>;

// 기존 닫힌 목록에서만 자료함 설치 조합을 만든다.
const teacherLibraryExtendedProfiles = Object.freeze(
  Object.fromEntries(
    Object.entries({
      ...birthDateBaseProfiles,
      ...birthDateExtendedProfiles,
      ...accessLogExtendedProfiles,
      ...pollEditExtendedProfiles,
    }).map(([name, grants]) => [
      name.replace(/_v1$/u, "_teacherlibrary_v1"),
      withAuth(grants, [teacherLibraryGrants]),
    ]),
  ),
) as Readonly<Record<TeacherLibraryExtendedAppProfile, readonly string[]>>;

/**
 * API가 쓸 수 있는 앱 프로필은 이 고정 조합뿐이다(임의 프로필 이름을 외부에서 넣지 않는다).
 * base: 운영 DB에 설치된 기반(도움 대화 84·85 / 반 단체 대화 94·95), profilePhotos: 사진(96·97) 설치,
 * auth: 설치된 인증 확장.
 */
export function selectAppRuntimeGrantProfile(installed: {
  classChat: boolean;
  profilePhotos?: boolean;
  birthDates?: boolean;
  adminAccessLogs?: boolean;
  pollEdit?: boolean;
  teacherLibrary?: boolean;
  auth: MariaDbAuthDatabaseExtensions;
}): MariaDbRuntimeGrantProfile {
  const base = selectBirthDateBaseProfile(installed);
  const profile: AccessLogBaseProfile =
    installed.birthDates === true
      ? (base.replace(/_v1$/u, "_birthdates_v1") as BirthDateExtendedAppProfile)
      : base;
  const withAccessLogs: PollEditBaseProfile =
    installed.adminAccessLogs === true
      ? (profile.replace(/_v1$/u, "_accesslogs_v1") as AccessLogExtendedAppProfile)
      : profile;
  const withPollEdit: TeacherLibraryBaseProfile =
    installed.pollEdit === true
      ? (withAccessLogs.replace(/_v1$/u, "_polledit_v1") as PollEditExtendedAppProfile)
      : withAccessLogs;
  return installed.teacherLibrary === true
    ? (withPollEdit.replace(/_v1$/u, "_teacherlibrary_v1") as TeacherLibraryExtendedAppProfile)
    : withPollEdit;
}

function selectBirthDateBaseProfile(installed: {
  classChat: boolean;
  profilePhotos?: boolean;
  auth: MariaDbAuthDatabaseExtensions;
}): BirthDateBaseProfile {
  const chat = installed.classChat ? "app_class_chat" : "app_help_chat";
  const base = installed.profilePhotos === true ? (`${chat}_photos` as const) : chat;
  if (installed.auth === "none") return `${base}_v1`;
  if (installed.auth === "passkeys") return `${base}_passkeys_v1`;
  if (installed.auth === "social") return `${base}_social_v1`;
  if (installed.auth === "all") return `${base}_passkeys_social_v1`;
  throw new Error("Unsupported authentication database extension installation.");
}

/**
 * 메일 발송 기록 1년 자동 삭제(2026-10-03 사용자 승인, 총검수 I5-04): 정리 계정에
 * mail_delivery_logs SELECT·DELETE를 더한 묶음(권한 파일 0061). 권한 검사는 정확히 일치해야
 * 하므로, DB에 권한을 넣은 뒤에만 RETENTION_MAIL_LOGS_GRANT_INSTALLED=true로 이 묶음을 고른다.
 */
function retentionMailLogs(): readonly string[] {
  const base = baselineGrants("retention", "retention_v1");
  if (base === undefined) throw new Error("Retention baseline grants are missing.");
  return Object.freeze(
    [...base, "table|mail_delivery_logs|DELETE|*", "table|mail_delivery_logs|SELECT|*"].sort(),
  );
}

/**
 * 관리자 작업 기록(2년)·탈퇴·철회 동의 증빙(1년) 자동 삭제(2026-10-03 사용자 승인, 총검수
 * I3-01): 메일 묶음(원장 104) 위에 두 표의 SELECT·DELETE를 더한 묶음(권한 파일 0062, 원장 105).
 */
function retentionAuditConsents(): readonly string[] {
  return Object.freeze(
    [
      ...retentionMailLogs(),
      "table|admin_operation_audit_logs|DELETE|*",
      "table|admin_operation_audit_logs|SELECT|*",
      "table|user_consents|DELETE|*",
      "table|user_consents|SELECT|*",
    ].sort(),
  );
}

/**
 * 관리자 기록 보관 기간(2026-10-04 사용자 결정, 처리방침 4장): 원장 105 묶음 위에 가입 승인(이메일·코드
 * 두 칸 비우기 + 삭제)·승인 처리 기록·패스키·복구 코드·문의의 SELECT·DELETE를 더한 묶음(권한 파일 0063, 원장 106).
 */
function retentionAdminRecords(): readonly string[] {
  return Object.freeze(
    [
      ...retentionAuditConsents(),
      ...[
        "admin_signup_approvals",
        "admin_signup_approval_events",
        "admin_passkeys",
        "admin_recovery_codes",
        "admin_inquiries",
      ].flatMap((table) => [`table|${table}|DELETE|*`, `table|${table}|SELECT|*`]),
      "table|admin_signup_approvals|UPDATE|code_encrypted",
      "table|admin_signup_approvals|UPDATE|recipient_email",
    ].sort(),
  );
}

/** Follow-up profiles leave the checksum-pinned installation baseline intact. */
export function requiredMariaDbRuntimeGrants(
  role: unknown,
  profile: unknown,
): readonly string[] | undefined {
  if (
    role === "app" &&
    typeof profile === "string" &&
    Object.hasOwn(teacherLibraryExtendedProfiles, profile)
  )
    return teacherLibraryExtendedProfiles[profile as TeacherLibraryExtendedAppProfile];
  if (
    role === "app" &&
    typeof profile === "string" &&
    Object.hasOwn(pollEditExtendedProfiles, profile)
  )
    return pollEditExtendedProfiles[profile as PollEditExtendedAppProfile];
  if (
    role === "app" &&
    typeof profile === "string" &&
    Object.hasOwn(accessLogExtendedProfiles, profile)
  )
    return accessLogExtendedProfiles[profile as AccessLogExtendedAppProfile];
  if (
    role === "app" &&
    typeof profile === "string" &&
    Object.hasOwn(birthDateExtendedProfiles, profile)
  )
    return birthDateExtendedProfiles[profile as BirthDateExtendedAppProfile];
  if (role === "app" && typeof profile === "string" && Object.hasOwn(authExtendedProfiles, profile))
    return authExtendedProfiles[profile as AuthExtendedAppProfile];
  if (
    role === "app" &&
    typeof profile === "string" &&
    Object.hasOwn(photoExtendedProfiles, profile)
  )
    return photoExtendedProfiles[profile as PhotoExtendedAppProfile];
  if (role === "app" && profile === "app_class_chat_v1") return appClassChat;
  if (role === "app" && profile === "app_profile_photos_v1") return appProfilePhotos;
  if (role === "app" && profile === "app_teacher_library_v1") return appTeacherLibrary;
  if (role === "app" && profile === "app_help_chat_v1") return appHelpChat;
  if (role === "app" && profile === "app_help_requests_v1") return appHelpRequests;
  if (role === "app" && profile === "app_schedule_links_v1") return appScheduleLinks;
  if (role === "app" && profile === "app_push_deliveries_v1") return appPushDeliveries;
  if (role === "app" && profile === "app_push_subscriptions_v1") return appPushSubscriptions;
  if (role === "app" && profile === "app_poll_close_v1") return appPollClose;
  if (role === "app" && profile === "app_mail_management_v1") return appMailManagement;
  if (role === "operator" && profile === "operator_commands_v1") return operatorCommands;
  if (role === "retention" && profile === "retention_mail_logs_v1") return retentionMailLogs();
  if (role === "retention" && profile === "retention_audit_consents_v1")
    return retentionAuditConsents();
  if (role === "retention" && profile === "retention_admin_records_v1")
    return retentionAdminRecords();
  if (
    role === "retention" &&
    ["retention_class_archives_v1", "retention_class_archives_legacy_v1"].includes(String(profile))
  )
    return Object.freeze(
      [
        ...new Set([
          ...retentionAdminRecords(),
          ...classArchiveGrants,
          ...(profile === "retention_class_archives_legacy_v1" ? legacyClassArchiveGrants : []),
        ]),
      ].sort(),
    );
  return baselineGrants(role, profile);
}

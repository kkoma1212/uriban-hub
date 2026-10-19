import { isIP } from "node:net";
import { isAbsolute } from "node:path";
import { assertProductionDatabaseUrl } from "@classhub/db";
import { z } from "zod";
import {
  socialEnvironmentShape,
  validateSocialEnvironment,
} from "../auth/social/social-auth.environment.js";
import { parseVapidKeys } from "../push-subscriptions/web-push-crypto.js";
import { parseMariaDbUrl } from "./mariadb-environment.js";

const DEVELOPMENT_DATABASE_URL =
  "postgresql://classhub_app:local_app_password@127.0.0.1:5432/classhub_dev";
const DEVELOPMENT_EMAIL_HMAC_KEY = "replace-with-at-least-32-random-bytes";
const DEVELOPMENT_PUBLIC_ORIGIN = "http://localhost:5174";
/*
 * 주소 설정의 형식 오류는 각 항목의 .url()이 보고하지만, zod는 그 뒤의 refine·superRefine도
 * 계속 실행한다. 거기서 new URL()이 던지면 Node가 입력값(주소 속 비밀번호 포함)을 오류에 실어
 * 내보내므로, 읽을 수 없는 주소는 값 없이 막고 교차 검사로 넘기지 않는다.
 */
const URL_SETTING_NAMES = [
  "PUBLIC_APP_ORIGIN",
  "PUBLIC_API_ORIGIN",
  "USER_APP_ORIGIN",
  "DATABASE_URL",
  "REDIS_URL",
  "ADMIN_WORKER_PROCESSING_URL",
  "LOCAL_TEST_ADMIN_DATABASE_URL",
  "SOCIAL_AUTH_MOCK_ISSUER",
] as const;

const environmentSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]),
    NATIVE_ASSESSMENT_QA_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    NATIVE_CLASS_ASSESSMENT_QA_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    PUBLIC_PREVIEW_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    API_HOST: z.string().min(1).default("127.0.0.1"),
    API_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    PUBLIC_APP_ORIGIN: z.string().url().default(DEVELOPMENT_PUBLIC_ORIGIN),
    PUBLIC_API_ORIGIN: z.string().url().default(DEVELOPMENT_PUBLIC_ORIGIN),
    /*
     * 실행 범위(T-ADMIN-SPLIT, 2026-10-07 사용자 결정): 한 서버에서 학생·교사 프로그램과 관리자 프로그램을
     * 포트를 나눠 따로 띄운다. all = 둘 다(지금 PC 시범·개발 묶음 그대로), user = 학생·교사만,
     * admin = 관리자만. 같은 코드를 실행 범위만 바꿔 띄우므로 한쪽만 다시 올릴 수 있다.
     */
    API_SURFACE: z.enum(["all", "user", "admin"]).default("all"),
    // 메일 속 링크(비밀번호 재설정·이메일 확인 등)가 가리킬 학생·교사 화면 주소. 관리자 프로그램은
    // PUBLIC_APP_ORIGIN이 관리자 주소라서, 이 값이 없으면 학생에게 관리자 주소 링크가 간다.
    USER_APP_ORIGIN: z.string().url().optional(),
    DATABASE_ENGINE: z.enum(["postgres", "mariadb"]).default("postgres"),
    DATABASE_URL: z.string().url().default(DEVELOPMENT_DATABASE_URL),
    DATABASE_TLS_CA_FILE: z.string().min(1).optional(),
    // 기본은 required(TLS·CA 검증). DB가 같은 서버·같은 내부망에 있어 운영자가 명시적으로 끌 때만
    // disabled로 둔다(2026-10-07 사용자 승인). 꺼도 계정·버전·권한 대조는 그대로 한다.
    DATABASE_TLS_MODE: z.enum(["required", "disabled"]).default("required"),
    // 운영 모드의 rediss:// 강제도 같은 이유로 명시적으로만 끈다.
    REDIS_TLS_MODE: z.enum(["required", "disabled"]).default("required"),
    DATABASE_ACCOUNT_HOST: z
      .string()
      .regex(/^[A-Za-z0-9_.:%/-]+$/u)
      .optional(),
    /*
     * 지정하지 않으면 pg 기본값 10이다. 학급 범위 쓰기가 같은 classes 행을 잡고
     * 줄을 서는 구조라, 한 학급에서 경합이 조금만 생겨도 막힌 트랜잭션이 커넥션을
     * 점유해 무관한 학교 요청까지 굶긴다(2026-08-01 감사 P1-03). 배포 환경이
     * 인스턴스 수와 DB max_connections에 맞춰 명시할 수 있어야 한다.
     */
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(1000).default(10),
    REDIS_URL: z
      .string()
      .url()
      .default("redis://127.0.0.1:6379")
      .refine(
        (value) => URL.canParse(value) && ["redis:", "rediss:"].includes(new URL(value).protocol),
        {
          message: "REDIS_URL은 redis:// 또는 rediss:// URL이어야 합니다.",
        },
      ),
    SMTP_HOST: z.string().min(1).default("127.0.0.1"),
    SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(1025),
    SMTP_SECURE: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    SMTP_REQUIRE_TLS: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    SMTP_USERNAME: z
      .string()
      .refine((value) => value.trim().length > 0)
      .optional(),
    SMTP_PASSWORD: z
      .string()
      .refine((value) => value.trim().length > 0)
      .optional(),
    SMTP_FROM: z.string().email().default("no-reply@classhub.local"),
    NEIS_API_KEY: z
      .string()
      .trim()
      .optional()
      .transform((value) => value || undefined),
    EMAIL_HMAC_KEY: z.string().min(32).default(DEVELOPMENT_EMAIL_HMAC_KEY),
    EMAIL_HMAC_KEY_VERSION: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u)
      .refine((value) => !/[A-Za-z0-9_-]{43}/u.test(value))
      .default("dev-1"),
    TERMS_POLICY_VERSION: z.string().min(1).default("2026-07-11"),
    PRIVACY_POLICY_VERSION: z.string().min(1).default("2026-07-11"),
    AGE_POLICY_VERSION: z.string().min(1).default("2026-07-11"),
    LEGAL_CONSENT_BINDING_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    TRUSTED_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(0),
    TRUSTED_PROXY_ADDRESSES: z
      .string()
      .default("127.0.0.1,::1")
      .refine((value) => value.split(",").every((address) => isIP(address.trim()) !== 0), {
        message: "TRUSTED_PROXY_ADDRESSES는 실제 프록시 IP 주소의 쉼표 구분 목록이어야 합니다.",
      }),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
    ATTENDANCE_NOTIFICATIONS_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    CONTENT_SELECTED_AUDIENCE_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    STUDENT_ASSESSMENTS_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    STUDENT_ASSESSMENT_CLASS_BINDING_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    POLLS_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    ELECTIONS_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    // 반 단체 대화(선생님 관리형, planning/class-chat-20260928). 표(원장 94·95)가 있는 DB에서만 켠다.
    CLASS_CHAT_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    // 통합순7 웹 푸시. 운영 키·고정 주소가 정해지기 전에는 로컬 미리보기·테스트에서만 켠다.
    WEB_PUSH_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    WEB_PUSH_VAPID_PUBLIC_KEY: z
      .string()
      .regex(/^[A-Za-z0-9_-]{87}$/u)
      .optional(),
    WEB_PUSH_VAPID_PRIVATE_KEY: z
      .string()
      .regex(/^[A-Za-z0-9_-]{43}$/u)
      .optional(),
    WEB_PUSH_SUBJECT: z
      .string()
      .regex(/^(?:mailto:[^\s@]+@[^\s@]+|https:\/\/\S+)$/u)
      .optional(),
    PASSWORD_RESET_ENABLED: z
      .enum(["true", "false"])
      .default("true")
      .transform((value) => value === "true"),
    ADMIN_WEB_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    ADMIN_PASSKEYS_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    ADMIN_WEBAUTHN_RP_ID: z.string().min(1).max(253).optional(),
    // 운영 DB에 "설치된" 인증 확장(원장 90·91 패스키, 92·93 소셜). 기능 켜기와 따로 둔다 —
    // 기능을 꺼도 설치된 권한과 API 권한 프로필이 정확히 같아야 기동 검사를 통과한다.
    AUTH_DATABASE_EXTENSIONS: z.enum(["none", "passkeys", "social", "all"]).default("none"),
    // 운영 DB에 반 단체 대화(원장 94·95)가 설치됐는지. CLASS_CHAT_ENABLED와 따로 둔다.
    CLASS_CHAT_DATABASE_INSTALLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    // T-PHOTO 프로필 사진. 화면·API 켜기(ENABLED)와 운영 DB 설치(원장 96·97, INSTALLED)를 따로 둔다 —
    // 끄더라도 설치된 권한과 API 권한 프로필이 같아야 하고, 탈퇴 시 사진 삭제는 설치 여부만 따른다.
    PROFILE_PHOTOS_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    PROFILE_PHOTOS_DATABASE_INSTALLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    ...socialEnvironmentShape,
    // 관리자 운영 상태 화면: 백업·복원 검증 결과 JSON이 있는 폴더(PC는 실행 스크립트가 넘긴다).
    // 없으면 "이 서버에서는 확인할 수 없음"으로 보인다. 폴더 안 고정 파일 두 개만 읽는다.
    ADMIN_OPERATIONS_STATUS_DIR: z
      .string()
      .min(1)
      .refine((value) => isAbsolute(value), "Must be an absolute path.")
      .optional(),
    // 운영 DB에 생년월일 칸(원장 99·100)이 설치됐는지. 켜져 있으면 가입 때 생년월일을 받아 만 14세를
    // 자동 판단하고, 꺼져 있으면 기존 나이 선택 가입을 쓴다. 설치된 권한과 API 권한 프로필이 같아야 한다.
    USER_BIRTH_DATES_DATABASE_INSTALLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    // 운영 DB에 관리자 접속기록 표(원장 101·102)가 설치됐는지. 켜져 있으면 관리자가 개인정보 화면을
    // 볼 때마다 접속기록을 남기고(2026-10-03 사용자 결정), 권한 프로필도 그 표를 포함한 것을 고른다.
    ADMIN_ACCESS_LOGS_DATABASE_INSTALLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    // 자료함 설치 권한(원장 86·87)만 정확히 검사한다. 자료함 기능을 개방하지 않는다.
    TEACHER_LIBRARY_DATABASE_INSTALLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    // 운영 DB에 투표 내용 수정 권한(원장 107·108)이 설치됐는지(2026-10-04 사용자 결정). 켜져 있을 때만
    // 진행 중 투표 수정을 받고, 권한 프로필도 그 권한을 포함한 것을 고른다. 설치 전에 켜면 기동 검사가 실패한다.
    POLL_EDIT_DATABASE_INSTALLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    // 2026-10-02 사용자 결정(P-025②·P-021): 시범 동안 만 14세 미만(보호자 동의) 새 가입을 받지 않는다.
    // 코드는 지우지 않고 이 값으로 닫는다. 기본은 닫힘이고, 보호자 동의 흐름을 시험할 때만 true로 연다.
    UNDER_14_SIGNUP_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    // 운영 DB에 관리자 세션 강제 종료 기록값(원장 98)이 설치됐는지. 꺼져 있으면 목록만 보이고 종료는 막는다.
    ADMIN_SESSION_REVOKE_DATABASE_INSTALLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    // 운영자가 확인을 마친 감사 격리의 마지막 시각(ISO). 이 시각까지 격리된 기록은 '확인한 과거 격리'로
    // 보이고 그 뒤에 새로 격리되면 경고한다. 기록 자체는 지우지 않는다.
    ADMIN_AUDIT_QUARANTINE_REVIEWED_THROUGH: z
      .string()
      .refine((value) => Number.isFinite(Date.parse(value)), "Must be an ISO date-time.")
      .optional(),
    // 작업자 처리 상태(감사 격리 수). 작업자는 이 주소를 루프백에만 열므로 루프백 http만 받는다.
    ADMIN_WORKER_PROCESSING_URL: z
      .string()
      .url()
      .default("http://127.0.0.1:3001/processingz")
      .refine((value) => {
        if (!URL.canParse(value)) return false;
        const url = new URL(value);
        return (
          url.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)
        );
      }, "Must be a loopback http URL."),
    ADMIN_MFA_ENCRYPTION_KEY: z
      .string()
      .regex(/^[A-Za-z0-9_-]{43}$/u)
      .refine((value) => {
        const decoded = Buffer.from(value, "base64url");
        return decoded.length === 32 && decoded.toString("base64url") === value;
      })
      .optional(),
    ADMIN_MFA_KEY_VERSION: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u)
      .optional(),
    LOCAL_TEST_ADMIN_ENABLED: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    LOCAL_TEST_ADMIN_OPERATOR_EMAIL: z.string().email().optional(),
    LOCAL_TEST_ADMIN_DATABASE_URL: z.string().url().optional(),
    LOCAL_TEST_ADMIN_PASSWORD_HASH: z
      .string()
      .regex(/^\$argon2id\$v=19\$m=65536,t=3,p=1\$/u)
      .optional(),
    LOCAL_TEST_ADMIN_USERNAME: z.string().min(1).max(50).optional(),
    SERVE_WEB: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
  })
  .superRefine((environment, context) => {
    const unreadableUrlSettings = URL_SETTING_NAMES.filter((name) => {
      const value = environment[name];
      return value !== undefined && !URL.canParse(value);
    });
    if (unreadableUrlSettings.length > 0) {
      for (const name of unreadableUrlSettings)
        context.addIssue({
          code: "custom",
          path: [name],
          message: `${name}을 주소로 읽을 수 없습니다.`,
        });
      return;
    }
    validateSocialEnvironment(environment, context);
    if (environment.DATABASE_ENGINE === "mariadb") {
      const auth = environment.AUTH_DATABASE_EXTENSIONS;
      if (environment.ADMIN_PASSKEYS_ENABLED && auth !== "passkeys" && auth !== "all")
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["AUTH_DATABASE_EXTENSIONS"],
          message: "Install the approved passkey database/ACL extension before enabling passkeys.",
        });
      if (environment.CLASS_CHAT_ENABLED && !environment.CLASS_CHAT_DATABASE_INSTALLED)
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["CLASS_CHAT_DATABASE_INSTALLED"],
          message: "Install the approved class chat database/ACL extension before enabling it.",
        });
      if (environment.PROFILE_PHOTOS_ENABLED && !environment.PROFILE_PHOTOS_DATABASE_INSTALLED)
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["PROFILE_PHOTOS_DATABASE_INSTALLED"],
          message: "Install the approved profile photo database/ACL extension before enabling it.",
        });
    }
    if (environment.ADMIN_PASSKEYS_ENABLED) {
      const appOrigin = new URL(environment.PUBLIC_APP_ORIGIN);
      if (
        !environment.ADMIN_WEB_ENABLED ||
        environment.ADMIN_WEBAUTHN_RP_ID !== appOrigin.hostname ||
        appOrigin.hostname.endsWith(".trycloudflare.com") ||
        (appOrigin.protocol !== "https:" && appOrigin.hostname !== "localhost")
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["ADMIN_WEBAUTHN_RP_ID"],
          message:
            "Passkeys require administrator routes and an exact stable application hostname (localhost for local tests).",
        });
      }
    }
    const hardenedEnvironment = environment.NODE_ENV !== "development";
    const productionEnvironment = environment.NODE_ENV === "production";
    const appHostname = new URL(environment.PUBLIC_APP_ORIGIN).hostname;
    const apiHostname = new URL(environment.PUBLIC_API_ORIGIN).hostname;
    const smtpUsernameConfigured = environment.SMTP_USERNAME !== undefined;
    const smtpPasswordConfigured = environment.SMTP_PASSWORD !== undefined;
    const quickTunnelOrigin = [appHostname, apiHostname].some((hostname) =>
      hostname.endsWith(".trycloudflare.com"),
    );
    if (quickTunnelOrigin && !environment.PUBLIC_PREVIEW_ENABLED) {
      context.addIssue({
        code: "custom",
        path: ["PUBLIC_PREVIEW_ENABLED"],
        message: "Quick Tunnel requires the explicit PUBLIC_PREVIEW_ENABLED boundary.",
      });
    }
    if (environment.PUBLIC_PREVIEW_ENABLED) {
      const reject = (name: string, message: string) =>
        context.addIssue({ code: "custom", path: [name], message });
      if (environment.NODE_ENV !== "test")
        reject("NODE_ENV", "Public preview requires its explicit test-mode configuration.");
      if (environment.ADMIN_WEB_ENABLED)
        reject("ADMIN_WEB_ENABLED", "Administrator routes are unavailable in public preview.");
      for (const name of ["ADMIN_MFA_ENCRYPTION_KEY", "ADMIN_MFA_KEY_VERSION"] as const) {
        if (environment[name] !== undefined)
          reject(name, "Public preview must not receive administrator credentials.");
      }
      if (!["127.0.0.1", "::1", "localhost"].includes(environment.API_HOST))
        reject("API_HOST", "The preview upstream must bind to loopback.");
      if (environment.TRUSTED_PROXY_HOPS !== 1)
        reject("TRUSTED_PROXY_HOPS", "Public preview expects exactly one local tunnel proxy.");
      if (
        !environment.TRUSTED_PROXY_ADDRESSES.split(",").every((address) =>
          ["127.0.0.1", "::1"].includes(address.trim()),
        )
      )
        reject("TRUSTED_PROXY_ADDRESSES", "Public preview only trusts its local tunnel proxy.");
      if (!environment.SMTP_SECURE && !environment.SMTP_REQUIRE_TLS)
        reject("SMTP_REQUIRE_TLS", "Public preview SMTP requires TLS.");
      if (!smtpUsernameConfigured || !smtpPasswordConfigured)
        reject("SMTP_USERNAME", "Public preview SMTP requires configured credentials.");
      if (
        [DEVELOPMENT_EMAIL_HMAC_KEY, "local-preview-placeholder-not-a-secret-0001"].includes(
          environment.EMAIL_HMAC_KEY,
        )
      )
        reject(
          "EMAIL_HMAC_KEY",
          "Public preview requires the configured shared authentication key.",
        );
    }
    const explicitSyntheticFixture =
      environment.NODE_ENV === "test" ||
      (environment.NODE_ENV === "development" && environment.LOCAL_TEST_ADMIN_ENABLED);
    const nativeMariaDbPreview =
      environment.NODE_ENV === "development" &&
      environment.DATABASE_ENGINE === "mariadb" &&
      URL.canParse(environment.DATABASE_URL) &&
      ["localhost", "127.0.0.1", "[::1]"].includes(new URL(environment.DATABASE_URL).hostname) &&
      ["localhost", "127.0.0.1", "::1"].includes(environment.API_HOST);
    const assessmentQaDatabase = new URL(environment.DATABASE_URL);
    // Dedicated synthetic QA only; this is neither production feature approval nor a schema claim.
    const nativeAssessmentQaBoundary =
      environment.NODE_ENV === "development" &&
      !environment.LOCAL_TEST_ADMIN_ENABLED &&
      !environment.PUBLIC_PREVIEW_ENABLED &&
      environment.API_HOST === "127.0.0.1" &&
      environment.API_PORT === 3010 &&
      environment.PUBLIC_APP_ORIGIN === "http://localhost:5176" &&
      environment.PUBLIC_API_ORIGIN === "http://localhost:5176" &&
      environment.DATABASE_ENGINE === "mariadb" &&
      ["mysql:", "mariadb:"].includes(assessmentQaDatabase.protocol) &&
      assessmentQaDatabase.hostname === "localhost" &&
      assessmentQaDatabase.port === "3309" &&
      assessmentQaDatabase.pathname === "/classhub_mariadb_phase1_dev" &&
      assessmentQaDatabase.search === "" &&
      assessmentQaDatabase.hash === "" &&
      environment.DATABASE_TLS_MODE === "required" &&
      (environment.DATABASE_TLS_CA_FILE?.trim().length ?? 0) > 0 &&
      environment.REDIS_URL === "redis://127.0.0.1:6380/1";
    const nativeAssessmentQa =
      environment.NATIVE_ASSESSMENT_QA_ENABLED &&
      !environment.NATIVE_CLASS_ASSESSMENT_QA_ENABLED &&
      nativeAssessmentQaBoundary &&
      !environment.STUDENT_ASSESSMENT_CLASS_BINDING_ENABLED;
    // This validates configuration only. The launcher must independently attest the active schema.
    const nativeClassAssessmentQa =
      environment.NATIVE_CLASS_ASSESSMENT_QA_ENABLED &&
      !environment.NATIVE_ASSESSMENT_QA_ENABLED &&
      nativeAssessmentQaBoundary &&
      environment.API_SURFACE === "user" &&
      !environment.ADMIN_WEB_ENABLED &&
      environment.STUDENT_ASSESSMENTS_ENABLED &&
      environment.STUDENT_ASSESSMENT_CLASS_BINDING_ENABLED &&
      assessmentQaDatabase.username === "classhub_app" &&
      environment.DATABASE_ACCOUNT_HOST === "%";
    if (environment.NATIVE_CLASS_ASSESSMENT_QA_ENABLED && !nativeClassAssessmentQa) {
      context.addIssue({
        code: "custom",
        path: ["NATIVE_CLASS_ASSESSMENT_QA_ENABLED"],
        message:
          "Native class assessment QA requires the exact isolated user-only development configuration; this is not schema attestation.",
      });
    }
    if (environment.NATIVE_ASSESSMENT_QA_ENABLED && !nativeAssessmentQa) {
      context.addIssue({
        code: "custom",
        path: ["NATIVE_ASSESSMENT_QA_ENABLED"],
        message:
          "Native assessment QA requires the exact isolated personal-assessment development configuration.",
      });
    }

    if (environment.API_SURFACE === "user") {
      // 학생·교사 프로그램은 관리자 기능도, 관리자 비밀값도 갖지 않는다.
      if (environment.ADMIN_WEB_ENABLED) {
        context.addIssue({
          code: "custom",
          path: ["ADMIN_WEB_ENABLED"],
          message: "API_SURFACE=user이면 관리자 기능을 켤 수 없습니다(관리자는 API_SURFACE=admin).",
        });
      }
      for (const name of ["ADMIN_MFA_ENCRYPTION_KEY", "ADMIN_MFA_KEY_VERSION"] as const) {
        if (environment[name] !== undefined) {
          context.addIssue({
            code: "custom",
            path: [name],
            message: "API_SURFACE=user 프로그램에는 관리자 비밀값을 넣지 않습니다.",
          });
        }
      }
    }
    if (environment.API_SURFACE === "admin") {
      if (!environment.ADMIN_WEB_ENABLED) {
        context.addIssue({
          code: "custom",
          path: ["ADMIN_WEB_ENABLED"],
          message: "API_SURFACE=admin이면 ADMIN_WEB_ENABLED=true가 필요합니다.",
        });
      }
      if (environment.USER_APP_ORIGIN === undefined) {
        context.addIssue({
          code: "custom",
          path: ["USER_APP_ORIGIN"],
          message:
            "API_SURFACE=admin이면 메일 링크용 학생·교사 화면 주소 USER_APP_ORIGIN이 필요합니다.",
        });
      }
    }

    if (environment.ADMIN_WEB_ENABLED) {
      if (environment.ADMIN_MFA_ENCRYPTION_KEY === undefined) {
        context.addIssue({
          code: "custom",
          path: ["ADMIN_MFA_ENCRYPTION_KEY"],
          message: "ADMIN_WEB_ENABLED=true이면 32바이트 ADMIN_MFA_ENCRYPTION_KEY가 필요합니다.",
        });
      }
      if (environment.ADMIN_MFA_KEY_VERSION === undefined) {
        context.addIssue({
          code: "custom",
          path: ["ADMIN_MFA_KEY_VERSION"],
          message: "ADMIN_WEB_ENABLED=true이면 ADMIN_MFA_KEY_VERSION이 필요합니다.",
        });
      }
      // 2026-10-08 운영 개방 승인(BACKLOG 28, 주소 admin.uribanhub.com): production 관리자는 관리자 전용
      // 프로그램으로만, 학생·교사 화면과 다른 호스트에서만 켠다. 쿠키는 포트가 아니라 호스트에 묶이므로
      // 호스트가 달라야 학생·교사 화면의 보안 구멍이 관리자 쿠키·API에 닿지 않는다.
      if (productionEnvironment && environment.API_SURFACE !== "admin") {
        context.addIssue({
          code: "custom",
          path: ["ADMIN_WEB_ENABLED"],
          message:
            "production 관리자 웹은 관리자 전용 프로그램(API_SURFACE=admin)으로만 켤 수 있습니다.",
        });
      }
      if (
        productionEnvironment &&
        environment.USER_APP_ORIGIN !== undefined &&
        new URL(environment.USER_APP_ORIGIN).hostname ===
          new URL(environment.PUBLIC_APP_ORIGIN).hostname
      ) {
        context.addIssue({
          code: "custom",
          path: ["PUBLIC_APP_ORIGIN"],
          message:
            "production 관리자 웹은 학생·교사 화면(USER_APP_ORIGIN)과 다른 호스트에서만 켤 수 있습니다.",
        });
      }
    }

    if (environment.WEB_PUSH_ENABLED) {
      const { WEB_PUSH_VAPID_PRIVATE_KEY, WEB_PUSH_VAPID_PUBLIC_KEY, WEB_PUSH_SUBJECT } =
        environment;
      if (!WEB_PUSH_VAPID_PUBLIC_KEY || !WEB_PUSH_VAPID_PRIVATE_KEY || !WEB_PUSH_SUBJECT) {
        context.addIssue({
          code: "custom",
          path: ["WEB_PUSH_ENABLED"],
          message: "WEB_PUSH_ENABLED=true이면 VAPID 공개키·비밀키와 WEB_PUSH_SUBJECT가 필요합니다.",
        });
      } else {
        try {
          parseVapidKeys(WEB_PUSH_VAPID_PUBLIC_KEY, WEB_PUSH_VAPID_PRIVATE_KEY);
        } catch {
          // 키 값은 오류 메시지에 싣지 않는다.
          context.addIssue({
            code: "custom",
            path: ["WEB_PUSH_VAPID_PUBLIC_KEY"],
            message: "VAPID 공개키가 비밀키와 짝이 맞지 않습니다.",
          });
        }
      }
    }

    if (
      environment.STUDENT_ASSESSMENT_CLASS_BINDING_ENABLED &&
      !environment.STUDENT_ASSESSMENTS_ENABLED
    ) {
      context.addIssue({
        code: "custom",
        path: ["STUDENT_ASSESSMENT_CLASS_BINDING_ENABLED"],
        message: "현재 반 연결은 학생 평가 기능을 켠 환경에서만 사용할 수 있습니다.",
      });
    }
    for (const featureName of [
      "ATTENDANCE_NOTIFICATIONS_ENABLED",
      "CLASS_CHAT_ENABLED",
      "CONTENT_SELECTED_AUDIENCE_ENABLED",
      "ELECTIONS_ENABLED",
      "POLLS_ENABLED",
      "STUDENT_ASSESSMENTS_ENABLED",
      "STUDENT_ASSESSMENT_CLASS_BINDING_ENABLED",
      "WEB_PUSH_ENABLED",
    ] as const) {
      if (
        environment.NODE_ENV === "production" &&
        environment[featureName] &&
        featureName !== "CONTENT_SELECTED_AUDIENCE_ENABLED"
      ) {
        context.addIssue({
          code: "custom",
          path: [featureName],
          message: `${featureName}는 승인 전 production 환경에서 활성화할 수 없습니다.`,
        });
      }
      if (
        environment.NODE_ENV !== "production" &&
        environment[featureName] &&
        !explicitSyntheticFixture &&
        !(nativeAssessmentQa && featureName === "STUDENT_ASSESSMENTS_ENABLED") &&
        !(
          nativeClassAssessmentQa &&
          ["STUDENT_ASSESSMENTS_ENABLED", "STUDENT_ASSESSMENT_CLASS_BINDING_ENABLED"].includes(
            featureName,
          )
        ) &&
        !(
          nativeMariaDbPreview &&
          [
            "ATTENDANCE_NOTIFICATIONS_ENABLED",
            "CLASS_CHAT_ENABLED",
            "POLLS_ENABLED",
            "ELECTIONS_ENABLED",
            "WEB_PUSH_ENABLED",
          ].includes(featureName)
        )
      ) {
        context.addIssue({
          code: "custom",
          path: [featureName],
          message: `${featureName} can only be enabled in NODE_ENV=test or an explicit development local-test-admin fixture.`,
        });
      }
    }

    if (smtpUsernameConfigured !== smtpPasswordConfigured) {
      context.addIssue({
        code: "custom",
        path: smtpUsernameConfigured ? ["SMTP_PASSWORD"] : ["SMTP_USERNAME"],
        message: "SMTP_USERNAME과 SMTP_PASSWORD는 함께 설정하거나 모두 생략해야 합니다.",
      });
    }

    if (environment.DATABASE_ENGINE === "mariadb") {
      try {
        parseMariaDbUrl(
          environment.DATABASE_URL,
          productionEnvironment ? "classhub_app" : undefined,
        );
      } catch (error) {
        context.addIssue({
          code: "custom",
          path: ["DATABASE_URL"],
          message: error instanceof Error ? error.message : "MariaDB configuration rejected.",
        });
      }
      const requiredMariaDbNames =
        environment.DATABASE_TLS_MODE === "disabled"
          ? (["DATABASE_ACCOUNT_HOST"] as const)
          : (["DATABASE_TLS_CA_FILE", "DATABASE_ACCOUNT_HOST"] as const);
      for (const name of requiredMariaDbNames) {
        if (environment[name] === undefined) {
          context.addIssue({
            code: "custom",
            path: [name],
            message: `${name} is required for MariaDB.`,
          });
        }
      }
      if (
        environment.DATABASE_TLS_MODE === "disabled" &&
        environment.DATABASE_TLS_CA_FILE !== undefined
      ) {
        context.addIssue({
          code: "custom",
          path: ["DATABASE_TLS_CA_FILE"],
          message: "DATABASE_TLS_CA_FILE must be removed when DATABASE_TLS_MODE=disabled.",
        });
      }
      if (environment.LOCAL_TEST_ADMIN_ENABLED) {
        context.addIssue({
          code: "custom",
          path: ["LOCAL_TEST_ADMIN_ENABLED"],
          message: "The PostgreSQL local-test-admin fixture is unavailable with MariaDB.",
        });
      }
    }

    if (productionEnvironment) {
      try {
        if (environment.DATABASE_ENGINE === "postgres") {
          assertProductionDatabaseUrl(environment.DATABASE_URL, {
            expectedUsername: "classhub_app",
            variableName: "DATABASE_URL",
          });
        }
      } catch (error) {
        context.addIssue({
          code: "custom",
          path: ["DATABASE_URL"],
          message:
            error instanceof Error ? error.message : "DATABASE_URL production validation failed.",
        });
      }

      if (
        environment.REDIS_TLS_MODE !== "disabled" &&
        new URL(environment.REDIS_URL).protocol !== "rediss:"
      ) {
        context.addIssue({
          code: "custom",
          path: ["REDIS_URL"],
          message: "production REDIS_URL은 rediss:// URL이어야 합니다.",
        });
      }

      if (environment.TRUSTED_PROXY_HOPS === 0) {
        context.addIssue({
          code: "custom",
          path: ["TRUSTED_PROXY_HOPS"],
          message:
            "production TRUSTED_PROXY_HOPS는 실제 reverse proxy topology에 맞는 1 이상의 값이어야 합니다.",
        });
      }

      if (!environment.SMTP_SECURE && !environment.SMTP_REQUIRE_TLS) {
        context.addIssue({
          code: "custom",
          path: ["SMTP_REQUIRE_TLS"],
          message: "production SMTP는 SMTP_SECURE 또는 SMTP_REQUIRE_TLS를 활성화해야 합니다.",
        });
      }

      if (!smtpUsernameConfigured) {
        context.addIssue({
          code: "custom",
          path: ["SMTP_USERNAME"],
          message: "production SMTP_USERNAME은 필수입니다.",
        });
      }

      if (!smtpPasswordConfigured) {
        context.addIssue({
          code: "custom",
          path: ["SMTP_PASSWORD"],
          message: "production SMTP_PASSWORD는 필수입니다.",
        });
      }
    }

    if (appHostname !== apiHostname) {
      context.addIssue({
        code: "custom",
        path: ["PUBLIC_API_ORIGIN"],
        message: "PWA와 API의 배포 hostname은 같아야 합니다.",
      });
    }

    for (const name of ["PUBLIC_APP_ORIGIN", "PUBLIC_API_ORIGIN"] as const) {
      const publicOrigin = new URL(environment[name]);

      if (publicOrigin.hostname.includes("*")) {
        context.addIssue({
          code: "custom",
          path: [name],
          message: `${name}에는 wildcard hostname을 사용할 수 없습니다.`,
        });
      }

      if (hardenedEnvironment) {
        if (environment[name] === DEVELOPMENT_PUBLIC_ORIGIN) {
          context.addIssue({
            code: "custom",
            path: [name],
            message: `${name}의 개발 기본값을 development 외 환경에서 사용할 수 없습니다.`,
          });
        } else if (publicOrigin.protocol !== "https:") {
          context.addIssue({
            code: "custom",
            path: [name],
            message: `${name}은 development 외 환경에서 https여야 합니다.`,
          });
        }
      }
    }

    if (hardenedEnvironment && environment.LOCAL_TEST_ADMIN_ENABLED) {
      context.addIssue({
        code: "custom",
        path: ["LOCAL_TEST_ADMIN_ENABLED"],
        message: "로컬 테스트 관리 기능은 development에서만 활성화할 수 있습니다.",
      });
    }

    if (hardenedEnvironment) {
      if (environment.LOCAL_TEST_ADMIN_DATABASE_URL !== undefined) {
        context.addIssue({
          code: "custom",
          path: ["LOCAL_TEST_ADMIN_DATABASE_URL"],
          message: "development 외 환경에는 로컬 테스트 관리자 DB 연결을 설정할 수 없습니다.",
        });
      }

      if (environment.DATABASE_URL === DEVELOPMENT_DATABASE_URL) {
        context.addIssue({
          code: "custom",
          path: ["DATABASE_URL"],
          message: "development 외 환경에서는 DATABASE_URL을 안전한 환경값으로 설정해야 합니다.",
        });
      }

      if (environment.EMAIL_HMAC_KEY === DEVELOPMENT_EMAIL_HMAC_KEY) {
        context.addIssue({
          code: "custom",
          path: ["EMAIL_HMAC_KEY"],
          message: "development 외 환경에서는 EMAIL_HMAC_KEY를 안전한 secret으로 설정해야 합니다.",
        });
      }
    }

    if (environment.LOCAL_TEST_ADMIN_ENABLED) {
      for (const name of [
        "LOCAL_TEST_ADMIN_OPERATOR_EMAIL",
        "LOCAL_TEST_ADMIN_PASSWORD_HASH",
        "LOCAL_TEST_ADMIN_USERNAME",
        "LOCAL_TEST_ADMIN_DATABASE_URL",
      ] as const) {
        if (environment[name] === undefined) {
          context.addIssue({
            code: "custom",
            path: [name],
            message: `${name}은 로컬 테스트 관리자 활성화 시 필수입니다.`,
          });
        }
      }

      if (environment.LOCAL_TEST_ADMIN_DATABASE_URL !== undefined) {
        const localAdminDatabaseUrl = new URL(environment.LOCAL_TEST_ADMIN_DATABASE_URL);
        if (!["postgres:", "postgresql:"].includes(localAdminDatabaseUrl.protocol)) {
          context.addIssue({
            code: "custom",
            path: ["LOCAL_TEST_ADMIN_DATABASE_URL"],
            message: "LOCAL_TEST_ADMIN_DATABASE_URL은 PostgreSQL URL이어야 합니다.",
          });
        }
        if (localAdminDatabaseUrl.username !== "classhub_local_admin") {
          context.addIssue({
            code: "custom",
            path: ["LOCAL_TEST_ADMIN_DATABASE_URL"],
            message: "로컬 테스트 관리자는 classhub_local_admin DB role을 사용해야 합니다.",
          });
        }
        if (environment.LOCAL_TEST_ADMIN_DATABASE_URL === environment.DATABASE_URL) {
          context.addIssue({
            code: "custom",
            path: ["LOCAL_TEST_ADMIN_DATABASE_URL"],
            message: "로컬 테스트 관리자 DB 연결은 앱 DB 연결과 분리해야 합니다.",
          });
        }
      }
    }
  });

export type AppEnvironment = z.infer<typeof environmentSchema>;

/** API가 읽는 설정 이름 전부. 공개 미리보기는 이 목록 밖의 값(다른 역할의 DB 비밀번호 등)을 넘기지 않는다. */
export const APP_ENVIRONMENT_KEYS: readonly string[] = Object.freeze(
  Object.keys(environmentSchema.shape),
);

export function loadEnvironment(input: Record<string, unknown>): AppEnvironment {
  return environmentSchema.parse(input);
}

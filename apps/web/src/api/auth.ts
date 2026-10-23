import type { components } from "@classhub/api-client";
import type { LegalConsentSnapshot } from "../features/legal/legal-api";

import {
  beginNavigationCapabilitiesRequest,
  clearNavigationCapabilities,
  rememberNavigationCapabilities,
} from "../lib/navigation-capabilities";
import { clearAuthenticatedClientState } from "../lib/authenticated-client-state";
import { unsubscribeBrowserQuietly } from "../lib/push-notifications";
import {
  beginSessionPrivacyObservation,
  rememberSessionPrivacyObservation,
} from "../lib/authenticated-session-privacy";
import { rememberRequestCooldown, rememberRequestLimitHeaders } from "../lib/request-cooldown";

type ApiSchemas = components["schemas"];

export type AgeRoute = "over_14" | "guardian_consent";

interface SignUpRequestBase {
  legal_documents?: LegalConsentSnapshot;
  approval_code?: string;
  /** YYYY-MM-DD. 서버가 생년월일을 받는 환경(getSignUpOptions)에서만 보낸다. */
  birth_date?: string;
  consents: {
    privacy: true;
    terms: true;
  };
  display_name: string;
  email: string;
  password: string;
  role: "student" | "teacher";
}

export type SignUpRequest =
  | (SignUpRequestBase & { age_route: "over_14" })
  | (SignUpRequestBase & {
      age_route: "guardian_consent";
      guardian_consent: {
        completion_token: string;
        request_id: string;
      };
    });

export interface SignUpResponse {
  next_action: "LOGIN";
  request_accepted: true;
}

export interface GuardianConsentRequestResponse {
  completion_token: string;
  consent_delivery_status: "failed" | "sent";
  expires_at: string;
  request_id: string;
}

export interface GuardianConsentStatusResponse {
  status: "approved" | "expired" | "pending";
}

export interface GuardianConsentConfirmationResponse {
  guardian_consent: true;
}

export interface ConfirmEmailResponse {
  email_verified: true;
  next_action: "LOGIN";
}

export interface ResendEmailResponse {
  verification_delivery_status: "failed" | "sent";
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface LoginResponse {
  next_action: "BOOTSTRAP";
}

export interface ChangePasswordRequest {
  current_password: string;
  new_password: string;
}

export interface ChangePasswordResponse {
  next_action: "LOGIN";
  password_changed: true;
}

export interface UpdateAccountProfileRequest {
  display_name: string;
}

export interface UpdateAccountProfileResponse {
  display_name: string;
  profile_updated: boolean;
  updated_at: string;
}

export interface DeleteAccountRequest {
  confirmation: "탈퇴";
  current_password: string;
}

export interface DeleteAccountResponse {
  account_deleted: true;
  next_action: "LOGIN";
}

export interface ArchiveCurrentClassRequest {
  expected_class_id: string;
  expected_row_version: string;
  class_name_confirmation: string;
}

export interface ArchiveCurrentClassResponse {
  archived_at: string;
  class_id: string;
  next_action: "CREATE_CLASS";
  row_version: string;
}

export type BootstrapDestination =
  | "TEACHER_REVOKED"
  | "CHANGE_TEMPORARY_PASSWORD"
  | "VERIFY_EMAIL"
  | "SIGNUP_APPROVAL_REQUIRED"
  | "HOME"
  | "CLASS_SUSPENDED"
  | "MEMBERSHIP_PENDING"
  | "CREATE_CLASS"
  | "ENTER_INVITE_CODE";

export type BootstrapAllowedAction =
  | "RESEND_EMAIL"
  | "CONFIRM_EMAIL"
  | "CONFIRM_SIGNUP_APPROVAL"
  | "CHANGE_PASSWORD"
  | "LOGOUT"
  | "DELETE_ACCOUNT"
  | "CREATE_CLASS"
  | "ENTER_INVITE_CODE"
  | "CANCEL_MEMBERSHIP_REQUEST"
  | "LEAVE_CLASS"
  | "VIEW_CLASS"
  | "MANAGE_CLASS"
  | "MANAGE_ATTENDANCE_NOTIFICATIONS"
  | "MANAGE_OWN_ATTENDANCE_NOTIFICATION"
  | "MANAGE_OWN_ASSESSMENTS"
  | "MANAGE_POLLS"
  | "EDIT_POLLS"
  | "VOTE_IN_POLLS"
  | "MANAGE_ELECTIONS"
  | "VOTE_IN_ELECTIONS"
  | "USE_CLASS_CHAT"
  | "USE_PROFILE_PHOTOS";

export interface BootstrapResponse {
  /** Optional only for compatibility with a server that has not rolled forward yet. */
  session_context?: string;
  account: {
    display_name: string;
    /** 본인 메일의 앞 두 글자만 보이게 가린 값(예: st***@example.com). */
    email_masked?: string;
    email_verified: boolean;
    is_active: boolean;
    signup_role?: "student" | "teacher" | null;
  };
  allowed_actions: BootstrapAllowedAction[];
  current_class: null | {
    id: string;
    name: string;
    school_address?: string | null;
    school_homepage_url?: string | null;
    school_name?: string;
    school_phone_number?: string | null;
    status: "active" | "suspended";
  };
  current_membership: null | {
    class_id: string;
    display_name_in_class: string | null;
    id: string;
    role: "student" | "teacher";
    student_number: number | null;
    status: "approved" | "pending";
  };
  destination: BootstrapDestination;
  last_membership_status: string | null;
  last_status_reason: string | null;
  server_today: string;
  teacher_profile: null | {
    status: "active" | "revoked";
    temporary_password_must_change: boolean;
  };
}

export interface CreateMembershipRequestResponse {
  email_delivery_status?: "sent" | "failed";
  teacher_notification_delivery_status?: "sent" | "failed";
  class_id: string;
  membership_id: string;
  next_action: "BOOTSTRAP";
  row_version: string;
  status: "pending";
}

export interface OwnMembershipTransitionResponse {
  class_id: string;
  membership_id: string;
  next_action: "BOOTSTRAP";
  row_version: string;
  status: "canceled" | "left";
  status_changed_at: string;
}

export type ManageableMemberStatus = "pending" | "approved" | "removed" | "rejoin_allowed";

export interface MemberListItem {
  /** 생년월일을 받는 환경에서만 — 담임의 가입 승인 확인용. */
  birth_date?: string | null;
  account_state: "active" | "inactive";
  display_name: string;
  display_name_in_class: string | null;
  email_masked?: string;
  /** 지금 사진을 받을 수 있는지(2026-10-23~). false면 사진을 요청하지 않는다. */
  has_profile_photo?: boolean;
  id: string;
  requested_at: string | null;
  row_version: string;
  status: ManageableMemberStatus;
  status_changed_at: string;
  student_number: number | null;
}

export interface ListMembersResponse {
  members: MemberListItem[];
}

export interface ApproveMemberResponse {
  email_delivery_status?: "sent" | "failed";
  member: MemberListItem;
  warnings: Array<"EXPECTED_STUDENT_COUNT_EXCEEDED">;
}

export interface GetMemberProfileResponse {
  member: MemberListItem;
}

export type UpdateMemberProfileRequest =
  | { display_name_in_class: string | null; student_number?: number | null }
  | { display_name_in_class?: string | null; student_number: number | null };

export interface UpdateMemberProfileResponse {
  member: MemberListItem;
  profile_updated: boolean;
}

export type MemberTransitionStatus = "rejected" | "removed" | "rejoin_allowed";

export interface MemberTransitionResponse {
  email_delivery_status?: "sent" | "failed";
  member: {
    id: string;
    reason: string | null;
    row_version: string;
    status: MemberTransitionStatus;
    status_changed_at: string;
  };
}

export type HomeNotice = ApiSchemas["HomeNoticeResponseDto"];
export type HomePoll = ApiSchemas["HomePollResponseDto"];
export type HomeReminder = ApiSchemas["HomeReminderResponseDto"];
export type HomeSupply = ApiSchemas["HomeSupplyResponseDto"];

export type HomeResponse = ApiSchemas["HomeResponseDto"];

export interface CurrentClassResponse {
  academic_year: number;
  active_student_count: number;
  expected_student_count?: number;
  grade: number;
  id: string;
  name: string;
  role: "student" | "teacher";
  row_version: string;
  school_address: string | null;
  school_homepage_url: string | null;
  school_name: string;
  school_phone_number: string | null;
  status: "active";
  teacher_display_name: string;
}

export interface InviteCodeResponse {
  class_id: string;
  invite_code: {
    code: string;
    created_at: string;
    expires_at: string;
    id: string;
    status: "active" | "expired";
  };
}

export interface SchoolSearchItem {
  edu_office_code: string;
  edu_office_name: string;
  region_name: string;
  school_code: string;
  school_kind: "elementary" | "high" | "middle";
  school_name: string;
}

export interface SearchSchoolsResponse {
  schools: SchoolSearchItem[];
}

export interface CreateClassRequest {
  academic_year: number;
  edu_office_code: string;
  expected_student_count: number;
  grade: number;
  name: string;
  school_code: string;
}

export interface CreateClassResponse {
  class: {
    academic_year: number;
    expected_student_count: number;
    grade: number;
    id: string;
    name: string;
    row_version: string;
    school_name: string;
    status: "active";
  };
  invite_code: InviteCodeResponse["invite_code"];
  next_action: "HOME";
  teacher_membership_id: string;
}

export interface UpdateCurrentClassRequest {
  expected_student_count?: number;
  name?: string;
}

interface ErrorEnvelope {
  error?: {
    code?: string;
    details?: Record<string, unknown>;
    message?: string;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readErrorEnvelope(body: unknown): ErrorEnvelope["error"] | undefined {
  const error = isRecord(body) ? body.error : undefined;
  if (!isRecord(error)) return undefined;

  const parsedError: NonNullable<ErrorEnvelope["error"]> = {};
  if (typeof error.code === "string") parsedError.code = error.code;
  if (isRecord(error.details)) parsedError.details = error.details;
  if (typeof error.message === "string") parsedError.message = error.message;
  return parsedError;
}

export class ApiRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
  }
}

/*
 * If-Match 에 보낼 강한 ETag 를 만든다.
 *
 * ⚠️ 응답의 ETag 헤더를 그대로 쓰면 안 된다. 사이에 낀 프록시가 응답을 다시 압축하면
 * 강한 ETag("1")를 약한 것(W/"1")으로 바꿔 놓는데, 서버는 약한 값을 거절한다.
 * 2026-08-12에 터널로 접속한 실사용에서 후보 등록이 이것으로 다섯 번 막혔다
 * (터널 없이 도는 브라우저 QA 는 통과해서 못 잡았다).
 *
 * row_version 은 응답 본문에 늘 들어 있고 서버가 ETag 를 만들 때 쓰는 바로 그 값이라,
 * 헤더를 거치지 않는 편이 언제나 맞다.
 */
export function entityEtag(rowVersion: string, headerValue?: string | null): string {
  /*
   * 서버가 준 강한 ETag 는 그대로 쓴다(기존 계약). 다만 W/"1" 처럼 약한 값이면
   * 버리고 row_version 으로 만든다 — 서버가 약한 값을 거절하기 때문이다.
   */
  if (headerValue !== undefined && headerValue !== null && /^"[^"]+"$/u.test(headerValue)) {
    return headerValue;
  }
  return `"${rowVersion}"`;
}

export async function parseResponse<T>(response: Response): Promise<T> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new ApiRequestError(
      "UNEXPECTED_RESPONSE",
      "요청을 처리하지 못했어요. 잠시 뒤 다시 시도해 주세요.",
      response.status,
    );
  }

  if (!response.ok) {
    const error = readErrorEnvelope(body);
    const details = { ...error?.details };
    if (response.status === 429) {
      const retryAfter = Number(response.headers.get("Retry-After"));
      if (typeof details.retry_after_seconds !== "number" && retryAfter > 0)
        details.retry_after_seconds = retryAfter;
      if (!response.headers.has("X-RateLimit-Limit")) rememberRequestCooldown(details);
    }
    const unsupportedMediaType =
      response.status === 415 || error?.code === "UNSUPPORTED_MEDIA_TYPE";
    throw new ApiRequestError(
      unsupportedMediaType ? "UNSUPPORTED_MEDIA_TYPE" : (error?.code ?? "UNKNOWN_ERROR"),
      unsupportedMediaType
        ? "요청 형식을 처리할 수 없어요. 화면을 새로고침한 뒤 다시 시도해 주세요."
        : (error?.message ?? "요청을 처리하지 못했습니다."),
      response.status,
      Object.keys(details).length === 0 ? undefined : details,
    );
  }

  return body as T;
}

export const NETWORK_ERROR_CODE = "NETWORK_ERROR";
export const REQUEST_ABORTED_CODE = "REQUEST_ABORTED";
export const REQUEST_TIMEOUT_CODE = "REQUEST_TIMEOUT";
const NETWORK_ERROR_MESSAGE =
  "서버에 연결하지 못했습니다. 네트워크 상태를 확인한 뒤 다시 시도해 주세요.";
const REQUEST_ABORTED_MESSAGE = "요청이 취소되었습니다. 다시 시도해 주세요.";
const REQUEST_TIMEOUT_MESSAGE =
  "요청 시간이 초과되어 결과를 확인하지 못했습니다. 현재 상태를 확인한 뒤 다시 시도해 주세요.";
const DEFAULT_API_REQUEST_DEADLINE_MS = 20_000;
const API_REQUEST_BUDGET_BRAND = Symbol("classhub.api-request-budget");

interface ApiRequestBudget {
  readonly [API_REQUEST_BUDGET_BRAND]: true;
  readonly callerSignals: Set<AbortSignal>;
  readonly deadline: number;
}

interface CsrfRecoveryRequestContext {
  apiFetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  csrfToken: string;
}

function createApiRequestBudget(): ApiRequestBudget {
  return Object.freeze({
    [API_REQUEST_BUDGET_BRAND]: true as const,
    callerSignals: new Set<AbortSignal>(),
    deadline: performance.now() + DEFAULT_API_REQUEST_DEADLINE_MS,
  });
}

function requestAbortedError(): ApiRequestError {
  return new ApiRequestError(REQUEST_ABORTED_CODE, REQUEST_ABORTED_MESSAGE, 0);
}

function requestTimeoutError(): ApiRequestError {
  return new ApiRequestError(REQUEST_TIMEOUT_CODE, REQUEST_TIMEOUT_MESSAGE, 0);
}

function waitForApiRequestBudget<T>(candidate: Promise<T>, budget: ApiRequestBudget): Promise<T> {
  const callerSignals = [...budget.callerSignals];
  if (callerSignals.some((signal) => signal.aborted)) {
    return Promise.reject(requestAbortedError());
  }

  const remaining = budget.deadline - performance.now();
  if (remaining <= 0) return Promise.reject(requestTimeoutError());

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const callerListeners: Array<{ listener: () => void; signal: AbortSignal }> = [];
    const finish = (settle: () => void): void => {
      if (settled) return;
      settled = true;
      globalThis.clearTimeout(timeout);
      for (const { listener, signal } of callerListeners) {
        signal.removeEventListener("abort", listener);
      }
      settle();
    };
    const timeout = globalThis.setTimeout(
      () => finish(() => reject(requestTimeoutError())),
      remaining,
    );
    for (const signal of callerSignals) {
      const listener = (): void => finish(() => reject(requestAbortedError()));
      signal.addEventListener("abort", listener, { once: true });
      callerListeners.push({ listener, signal });
    }
    void candidate.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

/**
 * fetch가 응답 없이 실패하면(TypeError) 브라우저 영문 메시지가 그대로 화면에
 * 노출된다. 모든 API 호출은 이 래퍼를 거쳐 한국어 메시지를 가진
 * `ApiRequestError`(NETWORK_ERROR, status 0)로 정규화한다.
 * 결과를 알 수 없는 실패이므로 `isMutationOutcomeUnknown`은 이 코드를
 * 반드시 "미확정"으로 판정해야 한다. 그래야 멱등 재시도 보호가 유지된다.
 */
export async function apiFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
  providedBudget?: ApiRequestBudget,
): Promise<Response> {
  const budget =
    providedBudget?.[API_REQUEST_BUDGET_BRAND] === true ? providedBudget : createApiRequestBudget();
  const requestSignal =
    typeof Request !== "undefined" && input instanceof Request ? input.signal : undefined;
  const callerSignals = [...new Set([requestSignal, init?.signal])].filter(
    (signal): signal is AbortSignal => signal !== undefined && signal !== null,
  );
  for (const signal of callerSignals) budget.callerSignals.add(signal);
  if (callerSignals.some((signal) => signal.aborted)) throw requestAbortedError();

  const remaining = budget.deadline - performance.now();
  if (remaining <= 0) throw requestTimeoutError();

  const controller = new AbortController();
  const requestPathname = window.location.pathname;
  let abortCause: "caller" | "timeout" | undefined;
  let rejectCancellation!: () => void;
  const cancellation = new Promise<never>((_resolve, reject) => {
    rejectCancellation = () => reject(new Error("API_REQUEST_CANCELED"));
  });
  const cancel = (cause: "caller" | "timeout"): void => {
    if (abortCause !== undefined) return;
    abortCause = cause;
    controller.abort();
    rejectCancellation();
  };
  const callerListeners = callerSignals.map((signal) => {
    const listener = (): void => cancel("caller");
    signal.addEventListener("abort", listener, { once: true });
    return { listener, signal };
  });
  const timeout = globalThis.setTimeout(() => cancel("timeout"), remaining);

  try {
    const response = await Promise.race([
      fetch(input, { ...init, signal: controller.signal }),
      cancellation,
    ]);
    // No endpoint currently streams. Buffering a clone keeps the same Response contract while
    // ensuring a stalled response body consumes the same deadline as its headers.
    await Promise.race([response.clone().arrayBuffer(), cancellation]);
    rememberRequestLimitHeaders(response.headers, requestPathname);
    return response;
  } catch {
    if (abortCause === "caller") throw requestAbortedError();
    if (abortCause === "timeout") throw requestTimeoutError();
    throw new ApiRequestError(NETWORK_ERROR_CODE, NETWORK_ERROR_MESSAGE, 0);
  } finally {
    globalThis.clearTimeout(timeout);
    for (const { listener, signal } of callerListeners) {
      signal.removeEventListener("abort", listener);
    }
  }
}

const CSRF_COOKIE_NAME = "__Host-classhub_csrf";

interface CsrfRefreshFlight {
  readonly controller: AbortController;
  failure: unknown;
  readonly ordinal: 0 | 1;
  readonly promise: Promise<void>;
  settled: boolean;
  successor: CsrfRefreshFlight | undefined;
  waiters: number;
}

let csrfRefreshInFlight: CsrfRefreshFlight | null = null;

function readCookie(name: string): string | undefined {
  const prefix = `${name}=`;
  const value = document.cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(prefix))
    ?.slice(prefix.length);
  return value === "" ? undefined : value;
}

/** 로그인한 화면에만 있는 위조 방지 값. 없으면 undefined(로그인 전) — 화면 오류 보고가 쓴다. */
export function readCsrfCookie(): string | undefined {
  return readCookie(CSRF_COOKIE_NAME);
}

function requireCsrfCookie(): string {
  const value = readCookie(CSRF_COOKIE_NAME);
  if (value === undefined) {
    throw new Error("요청 보안 정보를 찾을 수 없습니다. 다시 로그인해 주세요.");
  }
  return value;
}

async function refreshCsrfCookie(budget: ApiRequestBudget, signal: AbortSignal): Promise<void> {
  const response = await apiFetch(
    "/api/v1/auth/csrf-token",
    {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: "{}",
      signal,
    },
    budget,
  );
  await parseResponse<{ csrf_refreshed: true }>(response);
}

function assertApiRequestBudgetAvailable(budget: ApiRequestBudget): void {
  if ([...budget.callerSignals].some((signal) => signal.aborted)) throw requestAbortedError();
  if (budget.deadline - performance.now() <= 0) throw requestTimeoutError();
}

function createCsrfRefreshFlight(ordinal: 0 | 1): CsrfRefreshFlight {
  const controller = new AbortController();
  const promise = refreshCsrfCookie(createApiRequestBudget(), controller.signal);
  const flight: CsrfRefreshFlight = {
    controller,
    failure: undefined,
    ordinal,
    promise,
    settled: false,
    successor: undefined,
    waiters: 0,
  };
  const settle = (failure: unknown): void => {
    flight.failure = failure;
    flight.settled = true;
    if (csrfRefreshInFlight === flight) csrfRefreshInFlight = null;
  };
  void promise.then(
    () => settle(undefined),
    (error: unknown) => settle(error),
  );
  return flight;
}

function acquireCsrfRefreshFlight(): CsrfRefreshFlight {
  const current = csrfRefreshInFlight;
  if (current !== null && !current.settled) return current;
  const flight = createCsrfRefreshFlight(0);
  csrfRefreshInFlight = flight;
  return flight;
}

function acquireCsrfRefreshSuccessor(failed: CsrfRefreshFlight): CsrfRefreshFlight {
  if (failed.successor !== undefined) return failed.successor;
  if (failed.ordinal !== 0) throw failed.failure;

  const current = csrfRefreshInFlight;
  if (current !== null && !current.settled) {
    failed.successor = current;
    return current;
  }
  const successor = createCsrfRefreshFlight(1);
  failed.successor = successor;
  csrfRefreshInFlight = successor;
  return successor;
}

async function waitForCsrfRefreshFlight(
  flight: CsrfRefreshFlight,
  budget: ApiRequestBudget,
): Promise<void> {
  flight.waiters += 1;
  try {
    await waitForApiRequestBudget(flight.promise, budget);
  } finally {
    flight.waiters -= 1;
    if (flight.waiters === 0 && !flight.settled) {
      if (csrfRefreshInFlight === flight) csrfRefreshInFlight = null;
      flight.controller.abort();
    }
  }
}

function isBoundedFlightTimeout(error: unknown, flight: CsrfRefreshFlight): boolean {
  return (
    flight.settled &&
    flight.failure === error &&
    error instanceof ApiRequestError &&
    error.code === REQUEST_TIMEOUT_CODE
  );
}

async function refreshCsrfCookieSingleFlight(budget: ApiRequestBudget): Promise<void> {
  let flight = acquireCsrfRefreshFlight();
  try {
    await waitForCsrfRefreshFlight(flight, budget);
    return;
  } catch (error) {
    if (!isBoundedFlightTimeout(error, flight) || flight.ordinal !== 0) throw error;
  }

  // A waiter whose own operation budget is already exhausted must not acquire the successor.
  assertApiRequestBudgetAvailable(budget);
  flight = acquireCsrfRefreshSuccessor(flight);
  await waitForCsrfRefreshFlight(flight, budget);
}

export async function withCsrfRecovery<T>(
  send: (context: CsrfRecoveryRequestContext) => Promise<Response>,
  parser: (response: Response) => Promise<T> = parseResponse<T>,
): Promise<T> {
  const budget = createApiRequestBudget();
  const sendWithBudget = (csrfToken: string): Promise<Response> =>
    send({
      apiFetch: (input, init) => apiFetch(input, init, budget),
      csrfToken,
    });
  let csrfToken = readCookie(CSRF_COOKIE_NAME);
  let participatedInRefresh = false;

  if (csrfToken === undefined) {
    await refreshCsrfCookieSingleFlight(budget);
    participatedInRefresh = true;
    csrfToken = requireCsrfCookie();
  }

  try {
    return await parser(await sendWithBudget(csrfToken));
  } catch (error) {
    if (
      !(error instanceof ApiRequestError) ||
      error.status !== 403 ||
      error.code !== "CSRF_INVALID"
    ) {
      throw error;
    }

    let retryToken = readCookie(CSRF_COOKIE_NAME);
    if (retryToken === undefined || retryToken === csrfToken) {
      if (participatedInRefresh) throw error;
      await refreshCsrfCookieSingleFlight(budget);
      participatedInRefresh = true;
      retryToken = requireCsrfCookie();
    }

    return parser(await sendWithBudget(retryToken));
  }
}

export interface SignUpOptions {
  /** 생년월일을 (선택으로) 받을 수 있는 환경인지. 없으면 예전 서버(birth_date_required로 판단). */
  birth_date_collected?: boolean;
  birth_date_required: boolean;
  /** false면 만 14세 미만(보호자 동의) 새 가입을 받지 않는다(시범 운영 P-021·P-025). */
  under_14_signup?: boolean;
}

export async function getSignUpOptions(signal?: AbortSignal): Promise<SignUpOptions> {
  return parseResponse<SignUpOptions>(
    await apiFetch("/api/v1/auth/sign-up-options", { signal: signal ?? null }),
  );
}

export async function signUp(request: SignUpRequest): Promise<SignUpResponse> {
  const response = await apiFetch("/api/v1/auth/sign-up", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });

  return parseResponse<SignUpResponse>(response);
}

export async function createGuardianConsentRequest(
  guardianEmail: string,
  documents?: LegalConsentSnapshot,
): Promise<GuardianConsentRequestResponse> {
  const response = await apiFetch("/api/v1/auth/guardian-consent-requests", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      guardian_email: guardianEmail,
      ...(documents ? { legal_documents: documents } : {}),
    }),
  });

  return parseResponse<GuardianConsentRequestResponse>(response);
}

export async function getGuardianConsentRequestStatus(request: {
  completion_token: string;
  request_id: string;
}): Promise<GuardianConsentStatusResponse> {
  const response = await apiFetch("/api/v1/auth/guardian-consent-requests/status", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });

  return parseResponse<GuardianConsentStatusResponse>(response);
}

export async function confirmGuardianConsent(
  token: string,
  documents?: LegalConsentSnapshot,
): Promise<GuardianConsentConfirmationResponse> {
  const response = await apiFetch("/api/v1/auth/guardian-consents/confirm", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, ...(documents ? { legal_documents: documents } : {}) }),
  });

  return parseResponse<GuardianConsentConfirmationResponse>(response);
}

export async function confirmEmail(token: string): Promise<ConfirmEmailResponse> {
  const response = await apiFetch("/api/v1/auth/email-verifications/confirm", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });

  return parseResponse<ConfirmEmailResponse>(response);
}

export async function resendVerificationEmail(): Promise<ResendEmailResponse> {
  return withCsrfRecovery<ResendEmailResponse>(({ apiFetch, csrfToken }) =>
    apiFetch("/api/v1/auth/email-verifications/resend", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
      body: "{}",
    }),
  );
}

export async function resendSignupApproval(): Promise<{
  email_delivery_status: "sent" | "failed";
  expires_at: string;
}> {
  return withCsrfRecovery(({ apiFetch, csrfToken }) =>
    apiFetch("/api/v1/auth/signup-approval/resend", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
      body: "{}",
    }),
  );
}

export async function confirmSignupApproval(
  approvalCode: string,
): Promise<{ signup_approved: boolean; next_action: "BOOTSTRAP" }> {
  return withCsrfRecovery(({ apiFetch, csrfToken }) =>
    apiFetch("/api/v1/auth/signup-approval/confirm", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
      body: JSON.stringify({ approval_code: approvalCode }),
    }),
  );
}

export async function confirmSignupRole(
  role: "student" | "teacher",
): Promise<{ signup_role: "student" | "teacher" }> {
  return withCsrfRecovery(({ apiFetch, csrfToken }) =>
    apiFetch("/api/v1/auth/signup-approval/role", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
      body: JSON.stringify({ role }),
    }),
  );
}

export async function login(request: LoginRequest): Promise<LoginResponse> {
  const response = await apiFetch("/api/v1/auth/login", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });

  const result = await parseResponse<LoginResponse>(response);
  clearAuthenticatedClientState();
  return result;
}

export async function changePassword(
  request: ChangePasswordRequest,
): Promise<ChangePasswordResponse> {
  const body = JSON.stringify(request);
  const result = await withCsrfRecovery<ChangePasswordResponse>(({ apiFetch, csrfToken }) =>
    apiFetch("/api/v1/account/password", {
      method: "PATCH",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": csrfToken,
      },
      body,
    }),
  );
  clearAuthenticatedClientState();
  return result;
}

export async function updateAccountProfile(
  request: UpdateAccountProfileRequest,
): Promise<UpdateAccountProfileResponse> {
  const body = JSON.stringify(request);
  return withCsrfRecovery<UpdateAccountProfileResponse>(({ apiFetch, csrfToken }) =>
    apiFetch("/api/v1/account/profile", {
      method: "PATCH",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": csrfToken,
      },
      body,
    }),
  );
}

export async function deleteAccount(request: DeleteAccountRequest): Promise<DeleteAccountResponse> {
  const body = JSON.stringify(request);
  return withCsrfRecovery<DeleteAccountResponse>(({ apiFetch, csrfToken }) =>
    apiFetch("/api/v1/account/deletion", {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": csrfToken,
      },
      body,
    }),
  );
}

export async function getBootstrap(): Promise<BootstrapResponse> {
  const navigationRequestEpoch = beginNavigationCapabilitiesRequest();
  const privacyRequest = beginSessionPrivacyObservation();
  try {
    const response = await apiFetch("/api/v1/bootstrap", {
      credentials: "include",
      cache: "no-store",
    });
    const bootstrap = await parseResponse<BootstrapResponse>(response);
    rememberSessionPrivacyObservation(privacyRequest, bootstrap);
    rememberNavigationCapabilities(navigationRequestEpoch, bootstrap);
    return bootstrap;
  } catch (error) {
    clearNavigationCapabilities(navigationRequestEpoch);
    throw error;
  }
}

export async function getHome(): Promise<HomeResponse> {
  const response = await apiFetch("/api/v1/home", { credentials: "include" });
  return parseResponse<HomeResponse>(response);
}

export async function getCurrentClass(): Promise<CurrentClassResponse> {
  const response = await apiFetch("/api/v1/classes/current", { credentials: "include" });
  return parseResponse<CurrentClassResponse>(response);
}

export async function archiveCurrentClass(
  request: ArchiveCurrentClassRequest,
): Promise<ArchiveCurrentClassResponse> {
  const body = JSON.stringify(request);
  return withCsrfRecovery<ArchiveCurrentClassResponse>(({ apiFetch, csrfToken }) =>
    apiFetch("/api/v1/classes/current/archive", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
      body,
    }),
  );
}

export async function getCurrentInviteCode(): Promise<InviteCodeResponse> {
  const response = await apiFetch("/api/v1/classes/current/invite-code", {
    credentials: "include",
  });
  return parseResponse<InviteCodeResponse>(response);
}

export async function rotateCurrentInviteCode(idempotencyKey: string): Promise<InviteCodeResponse> {
  return withCsrfRecovery<InviteCodeResponse>(({ apiFetch, csrfToken }) =>
    apiFetch("/api/v1/classes/current/invite-code/rotate", {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
        "X-CSRF-Token": csrfToken,
      },
      body: "{}",
    }),
  );
}

export async function searchSchools(query: string): Promise<SearchSchoolsResponse> {
  const response = await apiFetch(`/api/v1/schools?q=${encodeURIComponent(query.trim())}`, {
    credentials: "include",
  });
  return parseResponse<SearchSchoolsResponse>(response);
}

export async function createClass(
  request: CreateClassRequest,
  idempotencyKey: string,
): Promise<CreateClassResponse> {
  const body = JSON.stringify(request);
  return withCsrfRecovery<CreateClassResponse>(({ apiFetch, csrfToken }) =>
    apiFetch("/api/v1/classes", {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
        "X-CSRF-Token": csrfToken,
      },
      body,
    }),
  );
}

export async function updateCurrentClass(
  request: UpdateCurrentClassRequest,
  rowVersion: string,
): Promise<CurrentClassResponse> {
  const body = JSON.stringify(request);
  const ifMatch = `"${rowVersion}"`;
  return withCsrfRecovery<CurrentClassResponse>(({ apiFetch, csrfToken }) =>
    apiFetch("/api/v1/classes/current", {
      method: "PATCH",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        "If-Match": ifMatch,
        "X-CSRF-Token": csrfToken,
      },
      body,
    }),
  );
}

export async function logout(): Promise<void> {
  // 공용 기기에서 다음 사람에게 이전 계정의 알림이 가지 않도록 먼저 구독을 끊는다.
  await unsubscribeBrowserQuietly();
  const response = await apiFetch("/api/v1/auth/logout", {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  await parseResponse<{ logged_out: true }>(response);
  clearAuthenticatedClientState();
}

export async function listMembers(status = "pending,approved"): Promise<ListMembersResponse> {
  const response = await apiFetch(`/api/v1/members?status=${encodeURIComponent(status)}`, {
    credentials: "include",
  });
  return parseResponse<ListMembersResponse>(response);
}

export async function getMemberProfile(memberId: string): Promise<GetMemberProfileResponse> {
  const response = await apiFetch(`/api/v1/members/${memberId}/profile`, {
    credentials: "include",
  });
  return parseResponse<GetMemberProfileResponse>(response);
}

export async function approveMember(
  memberId: string,
  request: { display_name_in_class: string | null; student_number: number | null },
): Promise<ApproveMemberResponse> {
  const body = JSON.stringify(request);
  return withCsrfRecovery<ApproveMemberResponse>(({ apiFetch, csrfToken }) =>
    apiFetch(`/api/v1/members/${memberId}/approve`, {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": csrfToken,
      },
      body,
    }),
  );
}

export async function updateMemberProfile(
  memberId: string,
  request: UpdateMemberProfileRequest,
  rowVersion: string,
): Promise<UpdateMemberProfileResponse> {
  const body = JSON.stringify(request);
  return withCsrfRecovery<UpdateMemberProfileResponse>(({ apiFetch, csrfToken }) =>
    apiFetch(`/api/v1/members/${memberId}/profile`, {
      method: "PATCH",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        "If-Match": `"${rowVersion}"`,
        "X-CSRF-Token": csrfToken,
      },
      body,
    }),
  );
}

async function transitionMember(
  memberId: string,
  action: "allow-rejoin" | "reject" | "remove",
  reason?: string | null,
): Promise<MemberTransitionResponse> {
  const body = action === "allow-rejoin" ? "{}" : JSON.stringify({ reason: reason ?? null });
  return withCsrfRecovery<MemberTransitionResponse>(({ apiFetch, csrfToken }) =>
    apiFetch(`/api/v1/members/${memberId}/${action}`, {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": csrfToken,
      },
      body,
    }),
  );
}

export function rejectMember(
  memberId: string,
  reason: string | null,
): Promise<MemberTransitionResponse> {
  return transitionMember(memberId, "reject", reason);
}

export function removeMember(
  memberId: string,
  reason: string | null,
): Promise<MemberTransitionResponse> {
  return transitionMember(memberId, "remove", reason);
}

export async function createMembershipRequest(
  inviteCode: string,
): Promise<CreateMembershipRequestResponse> {
  const body = JSON.stringify({ invite_code: inviteCode });
  return withCsrfRecovery<CreateMembershipRequestResponse>(({ apiFetch, csrfToken }) =>
    apiFetch("/api/v1/membership-requests", {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": csrfToken,
      },
      body,
    }),
  );
}

async function transitionOwnMembership(
  path: "/api/v1/membership-requests/current/cancel" | "/api/v1/memberships/current/leave",
): Promise<OwnMembershipTransitionResponse> {
  const result = await withCsrfRecovery<OwnMembershipTransitionResponse>(
    ({ apiFetch, csrfToken }) =>
      apiFetch(path, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
        body: "{}",
      }),
  );
  clearAuthenticatedClientState();
  return result;
}

export function cancelMembershipRequest(): Promise<OwnMembershipTransitionResponse> {
  return transitionOwnMembership("/api/v1/membership-requests/current/cancel");
}

export function leaveCurrentClass(): Promise<OwnMembershipTransitionResponse> {
  return transitionOwnMembership("/api/v1/memberships/current/leave");
}

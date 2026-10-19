import { readCsrfCookie } from "../api/auth";

/*
 * 휴대폰 화면 오류 모으기(T-CLIENT-ERRORS, 2026-10-05 사용자 결정: 로그인한 사람만).
 * 화면 모양(/notices/:id)·오류 이름(TypeError)·역할·기기만 보낸다. 오류 문장·코드 위치·입력 내용은
 * 개인 내용이 섞일 수 있어 보내지 않는다. 보고가 실패해도 화면에는 아무 영향이 없어야 한다.
 */
export type ClientErrorSource = "render" | "script" | "promise" | "chunk";

const ENDPOINT = "/api/v1/client-errors";
/** 한 화면(새로고침 전까지)에서 보내는 최대 건수 — 같은 오류가 반복돼도 서버를 두드리지 않게. */
const MAX_REPORTS_PER_PAGE = 10;
const MAX_PLAIN_SEGMENT = 24;
const ROUTE_PATTERN = /^\/[a-z0-9\-/:]{0,79}$/u;
const ERROR_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,39}$/u;
/** 새 배포 뒤 옛 화면이 사라진 파일을 부를 때 브라우저마다 다른 문장 — 분류에만 쓰고 보내지 않는다. */
const CHUNK_FAILURE =
  /dynamically imported module|Importing a module script failed|error loading dynamically imported module|Unable to preload CSS/iu;

const sentKeys = new Set<string>();
let sentCount = 0;
let disabled = false;

/** 숫자·긴 조각(글 번호·토큰)을 :id로 바꾼 화면 모양. 규칙에 안 맞으면 "/"로 줄인다. */
export function clientErrorRoute(pathname: string): string {
  const route = pathname
    .toLowerCase()
    .split("/")
    .map((segment) =>
      /^[0-9]+$/u.test(segment) ||
      segment.length > MAX_PLAIN_SEGMENT ||
      !/^[a-z0-9-]*$/u.test(segment)
        ? ":id"
        : segment,
    )
    .join("/");
  return ROUTE_PATTERN.test(route) ? route : "/";
}

function errorName(error: unknown): string {
  if (error instanceof Error) return ERROR_NAME_PATTERN.test(error.name) ? error.name : "Error";
  return "NonError";
}

function errorSource(error: unknown, fallback: ClientErrorSource): ClientErrorSource {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return CHUNK_FAILURE.test(message) || errorName(error) === "ChunkLoadError" ? "chunk" : fallback;
}

function currentRole(): "student" | "teacher" | "unknown" {
  const role = document.querySelector("[data-app-role]")?.getAttribute("data-app-role");
  return role === "student" || role === "teacher" ? role : "unknown";
}

function currentDevice(): "phone" | "desktop" {
  const coarse = window.matchMedia?.("(pointer: coarse)").matches ?? false;
  return coarse || window.innerWidth < 768 ? "phone" : "desktop";
}

export function reportClientError(error: unknown, source: ClientErrorSource): void {
  try {
    if (disabled || sentCount >= MAX_REPORTS_PER_PAGE) return;
    const csrf = readCsrfCookie();
    if (csrf === undefined) return; // 로그인 전 화면은 모으지 않는다(사용자 결정).
    const report = {
      device: currentDevice(),
      name: errorName(error),
      role: currentRole(),
      route: clientErrorRoute(window.location.pathname),
      source: errorSource(error, source),
    };
    const key = [report.source, report.name, report.route].join("|");
    if (sentKeys.has(key)) return;
    sentKeys.add(key);
    sentCount += 1;
    void fetch(ENDPOINT, {
      body: JSON.stringify(report),
      credentials: "include",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
      keepalive: true,
      method: "POST",
    })
      .then((response) => {
        // 로그인이 끝났거나 막혔으면 이 화면에서는 더 보내지 않는다.
        if (response.status === 401 || response.status === 403) disabled = true;
      })
      .catch(() => undefined);
  } catch {
    // 보고 자체의 실패는 무시한다 — 오류 보고가 새 오류를 만들면 안 된다.
  }
}

function isOwnScript(filename: string | undefined): boolean {
  return filename === undefined || filename === "" || filename.startsWith(window.location.origin);
}

export function installClientErrorReporter(): void {
  window.addEventListener("error", (event) => {
    // 브라우저 확장·외부 스크립트 오류와 무해한 ResizeObserver 경고는 우리 화면 결함이 아니다.
    if (!isOwnScript(event.filename) || /ResizeObserver loop/u.test(event.message)) return;
    reportClientError(event.error ?? new Error(event.message), "script");
  });
  window.addEventListener("unhandledrejection", (event) => {
    reportClientError(event.reason, "promise");
  });
}

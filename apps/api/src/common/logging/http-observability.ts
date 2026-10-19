const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const METHOD_PATTERN = /^[A-Z]{1,16}$/u;
const FAILURE_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/u;
const CANONICAL_ROUTE_PATTERN = /^\/[A-Za-z0-9_:/.*-]*$/u;
const MEDIA_TYPE_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/u;
const UNKNOWN_ROUTE = "/unknown";

export type HttpRequestOutcome = "denied" | "failed" | "rejected" | "success";
export type HttpUserImpact = "access_denied" | "none" | "request_failed" | "request_rejected";

export interface HttpRequestLogInput {
  readonly headers?: {
    readonly [name: string]: unknown;
    readonly "content-type"?: unknown;
  };
  readonly id?: unknown;
  readonly method?: unknown;
  readonly raw?: unknown;
  readonly routeOptions?: {
    readonly url?: unknown;
  };
  readonly url?: unknown;
}

export interface HttpResponseLogInput {
  readonly statusCode?: unknown;
}

export interface HttpCompletionValue {
  readonly responseTime?: unknown;
}

export interface HttpRequestCompletionLog {
  readonly action: "http.request.completed";
  readonly content_type?: string;
  readonly duration_ms: number;
  readonly failure_code: string | null;
  readonly method: string;
  readonly outcome: HttpRequestOutcome;
  readonly route: string;
  readonly status_code: number;
  readonly user_impact: HttpUserImpact;
}

interface RequestLogMetadata {
  readonly contentType?: string;
  readonly failureCode?: string;
  readonly route?: string;
}

const requestMetadata = new WeakMap<object, RequestLogMetadata>();

function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

function relatedRequestObjects(request: HttpRequestLogInput): readonly object[] {
  const objects: object[] = [request];
  if (isObject(request.raw) && request.raw !== request) objects.push(request.raw);
  return objects;
}

function updateRequestMetadata(request: HttpRequestLogInput, update: RequestLogMetadata): void {
  for (const requestObject of relatedRequestObjects(request)) {
    requestMetadata.set(requestObject, {
      ...requestMetadata.get(requestObject),
      ...update,
    });
  }
}

function readRequestMetadata(request: HttpRequestLogInput): RequestLogMetadata {
  for (const requestObject of relatedRequestObjects(request)) {
    const metadata = requestMetadata.get(requestObject);
    if (metadata !== undefined) return metadata;
  }
  return {};
}

export function canonicalRouteForLog(value: unknown): string {
  if (typeof value !== "string") return UNKNOWN_ROUTE;

  const queryStart = value.indexOf("?");
  const fragmentStart = value.indexOf("#");
  const cutoff = Math.min(
    queryStart === -1 ? value.length : queryStart,
    fragmentStart === -1 ? value.length : fragmentStart,
  );
  const route = value.slice(0, cutoff);

  return route.length > 0 && route.length <= 2_048 && CANONICAL_ROUTE_PATTERN.test(route)
    ? route
    : UNKNOWN_ROUTE;
}

export function registerHttpRequestForLog(request: HttpRequestLogInput): void {
  updateRequestMetadata(request, {
    route: canonicalRouteForLog(request.routeOptions?.url),
  });
}

export function recordHttpRequestFailureForLog(
  request: HttpRequestLogInput,
  failureCode: unknown,
): void {
  const safeFailureCode =
    typeof failureCode === "string" && FAILURE_CODE_PATTERN.test(failureCode)
      ? failureCode
      : "INTERNAL_ERROR";
  const contentType =
    safeFailureCode === "UNSUPPORTED_MEDIA_TYPE"
      ? baseMediaTypeForLog(request.headers?.["content-type"])
      : undefined;
  updateRequestMetadata(request, {
    ...(contentType === undefined ? {} : { contentType }),
    failureCode: safeFailureCode,
  });
}

function baseMediaTypeForLog(value: unknown): string {
  if (typeof value !== "string" || value.length > 512) return "unknown";
  const mediaType = value.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return MEDIA_TYPE_PATTERN.test(mediaType) ? mediaType : "unknown";
}

export function requestIdForLog(value: unknown): string {
  return typeof value === "string" && UUID_PATTERN.test(value) ? value : "unknown";
}

function safeMethod(value: unknown): string {
  if (typeof value !== "string") return "UNKNOWN";
  const method = value.toUpperCase();
  return METHOD_PATTERN.test(method) ? method : "UNKNOWN";
}

function safeStatusCode(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599
    ? value
    : 500;
}

function safeDuration(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : 0;
}

export function classifyHttpRequest(statusCode: number): {
  outcome: HttpRequestOutcome;
  userImpact: HttpUserImpact;
} {
  if (statusCode < 400) return { outcome: "success", userImpact: "none" };
  if (statusCode === 401 || statusCode === 403) {
    return { outcome: "denied", userImpact: "access_denied" };
  }
  if (statusCode < 500) {
    return { outcome: "rejected", userImpact: "request_rejected" };
  }
  return { outcome: "failed", userImpact: "request_failed" };
}

export function createHttpRequestCompletionLog(
  request: HttpRequestLogInput,
  response: HttpResponseLogInput,
  value: HttpCompletionValue,
): HttpRequestCompletionLog {
  const statusCode = safeStatusCode(response.statusCode);
  const classification = classifyHttpRequest(statusCode);
  const metadata = readRequestMetadata(request);

  return {
    action: "http.request.completed",
    ...(statusCode === 415 && metadata.contentType !== undefined
      ? { content_type: metadata.contentType }
      : {}),
    duration_ms: safeDuration(value.responseTime),
    failure_code: statusCode >= 400 ? (metadata.failureCode ?? null) : null,
    method: safeMethod(request.method),
    outcome: classification.outcome,
    route: metadata.route ?? UNKNOWN_ROUTE,
    status_code: statusCode,
    user_impact: classification.userImpact,
  };
}

export function httpRequestLogLevel(
  _request: HttpRequestLogInput,
  response: HttpResponseLogInput,
  error?: Error,
): "error" | "info" | "warn" {
  const statusCode = safeStatusCode(response.statusCode);
  if (error !== undefined || statusCode >= 500) return "error";
  if (statusCode >= 400) return "warn";
  return "info";
}

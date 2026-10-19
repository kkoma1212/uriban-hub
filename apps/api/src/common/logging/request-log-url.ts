import {
  createHttpRequestCompletionLog,
  type HttpRequestLogInput,
  requestIdForLog,
} from "./http-observability.js";

const REQUEST_BASE_URL = "http://request.invalid";

export function requestPathForLog(requestUrl: unknown): string {
  if (typeof requestUrl !== "string" || requestUrl.length === 0) {
    return "/";
  }

  if (requestUrl === "*") {
    return requestUrl;
  }

  try {
    const url = new URL(requestUrl, REQUEST_BASE_URL);
    return url.pathname.length === 0 ? "/" : url.pathname;
  } catch {
    const queryStart = requestUrl.indexOf("?");
    const fragmentStart = requestUrl.indexOf("#");
    const boundaries = [queryStart, fragmentStart].filter((index) => index >= 0);
    const boundary = boundaries.length === 0 ? requestUrl.length : Math.min(...boundaries);
    const pathname = requestUrl.slice(0, boundary);

    return pathname.startsWith("/") && pathname.length > 0 ? pathname : "/";
  }
}

export function serializeRequestForLog(
  request: HttpRequestLogInput,
): Readonly<Record<string, unknown>> {
  const completion = createHttpRequestCompletionLog(request, { statusCode: 200 }, {});
  return {
    method: completion.method,
    request_id: requestIdForLog(request.id),
    route: completion.route,
  };
}

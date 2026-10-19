import { ApiRequestError, apiFetch, parseResponse } from "./auth";

type StepUpHandler = (options: { allowRecovery: boolean }) => Promise<boolean>;
let handler: StepUpHandler | undefined;
let pending:
  { owner: StepUpHandler; allowRecovery: boolean; promise: Promise<boolean> } | undefined;

export function registerAdminStepUpHandler(next: StepUpHandler): () => void {
  handler = next;
  return () => {
    if (handler === next) handler = undefined;
  };
}

/** Replay only a request the server explicitly rejected before its handler ran. */
export async function adminFetch(path: string, init?: RequestInit): Promise<Response> {
  init = init === undefined ? undefined : { ...init, headers: new Headers(init.headers) };
  const response = await apiFetch(path, init);
  if (![401, 403].includes(response.status) || handler === undefined) return response;
  let allowRecovery = true;
  try {
    await parseResponse(response.clone());
    return response;
  } catch (error) {
    if (
      !(error instanceof ApiRequestError) ||
      !["ADMIN_STEP_UP_REQUIRED", "ADMIN_STRONG_STEP_UP_REQUIRED"].includes(error.code)
    ) {
      return response;
    }
    allowRecovery = error.code !== "ADMIN_STRONG_STEP_UP_REQUIRED";
  }
  if (!path.startsWith("/api/v1/admin/") || (init?.body != null && typeof init.body !== "string")) {
    return response;
  }
  const owner = handler;
  if (owner === undefined) return response;
  for (;;) {
    if (handler !== owner || init?.signal?.aborted) throw aborted();
    if (pending?.owner !== owner) {
      // Publish the flight before invoking the handler, including synchronous
      // reentry and throws. Clear it before waking requests waiting for it.
      const current = {
        owner,
        allowRecovery,
        promise: Promise.resolve(false),
      };
      current.promise = Promise.resolve()
        .then(() => owner({ allowRecovery }))
        .finally(() => {
          if (pending === current) pending = undefined;
        });
      pending = current;
    }
    const current = pending;
    const accepted = await current.promise;
    if (!accepted || handler !== owner || init?.signal?.aborted) throw aborted();
    // A recovery-capable flight cannot satisfy a strong request. Wait for it
    // to finish before starting or joining the subsequent strong flight.
    if (!allowRecovery && current.allowRecovery) continue;
    break;
  }
  // Exactly one retry, with the same URL, method and serialized body. Network or
  // business failures never enter this path; a second 401 is returned to the caller.
  return apiFetch(path, init);
}

function aborted(): ApiRequestError {
  return new ApiRequestError(
    "REQUEST_ABORTED",
    "보안 확인을 취소했습니다. 작성한 내용을 확인한 뒤 다시 시도해 주세요.",
    0,
  );
}

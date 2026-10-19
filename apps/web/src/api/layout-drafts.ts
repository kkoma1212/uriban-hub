import { apiFetch, ApiRequestError, parseResponse, withCsrfRecovery } from "./auth";

export type LayoutDraftKind = "seat_draw" | "team_draw";

export interface LayoutDraftItem {
  kind: LayoutDraftKind;
  payload: unknown;
  row_version: string;
  updated_at: string;
}

/**
 * 만들던 내용을 이어받는다. **없으면 `undefined`** 를 돌려준다 — 임시저장이 없는 것은
 * 정상이고(처음 만드는 경우) 오류로 다루면 화면이 쓸데없이 빨개진다.
 */
export async function getLayoutDraft(kind: LayoutDraftKind): Promise<LayoutDraftItem | undefined> {
  try {
    const response = await apiFetch(`/api/v1/layout-drafts/${kind}`, { credentials: "include" });
    return await parseResponse<LayoutDraftItem>(response);
  } catch (error) {
    if (error instanceof ApiRequestError && error.status === 404) return undefined;
    throw error;
  }
}

export async function saveLayoutDraft(
  kind: LayoutDraftKind,
  payload: unknown,
): Promise<LayoutDraftItem> {
  const body = JSON.stringify({ payload });
  return withCsrfRecovery<LayoutDraftItem>(({ apiFetch, csrfToken }) =>
    apiFetch(`/api/v1/layout-drafts/${kind}`, {
      body,
      credentials: "include",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken },
      method: "PUT",
    }),
  );
}

/** 비우기는 204를 준다 — 본문이 없으므로 실패일 때만 오류를 읽는다. */
async function parseEmptyResponse(response: Response): Promise<void> {
  if (response.ok) return;
  await parseResponse<never>(response);
}

export async function clearLayoutDraft(kind: LayoutDraftKind): Promise<void> {
  await withCsrfRecovery<void>(
    ({ apiFetch, csrfToken }) =>
      apiFetch(`/api/v1/layout-drafts/${kind}`, {
        credentials: "include",
        headers: { "X-CSRF-Token": csrfToken },
        method: "DELETE",
      }),
    parseEmptyResponse,
  );
}

/*
 * **임시저장 요청을 한 줄로 세운다.**
 *
 * 예전에는 800ms 뒤에 그냥 쏘고 잊었다(`void saveLayoutDraft(...)`). 그래서 두 가지가
 * 어긋날 수 있었다(2026-08-22 감사 BLUE-11, T-HUB-45):
 * - 먼저 보낸 저장이 **늦게 도착**하면 서버가 옛 내용으로 덮는다 — 짜던 자리가 눈앞에서
 *   되돌아간다.
 * - 다 만들고 나서 임시저장을 지웠는데 **이미 나간 저장이 뒤늦게 도착**하면 지운 것이
 *   되살아난다.
 *
 * 그래서 한 번에 하나만 보낸다. 보내는 중에 값이 또 바뀌면 **가장 최신 값 하나로 합쳐**
 * 뒤이어 보낸다(중간 값들은 보낼 이유가 없다 — 어차피 최신 것이 이긴다). 지우기도 같은
 * 줄에 세우므로 항상 앞의 저장이 끝난 뒤에 실행된다.
 *
 * ⚠️ 실패는 삼킨다 — 임시저장 때문에 만들던 작업을 막지 않는다는 기존 계약 그대로다.
 * 다음 변경 때 어차피 최신 값으로 다시 보낸다.
 */
export interface LayoutDraftQueue {
  /** 앞의 저장이 끝난 뒤 지운다. 만들기를 마친 뒤 부르는 쪽이 기다릴 수 있게 Promise 를 준다. */
  clear: () => Promise<void>;
  /** 보내는 중이면 값만 갈아 끼운다 — 요청이 쌓이지 않는다. */
  save: (payload: unknown) => void;
}

/*
 * 실제로 보내는 두 함수를 인자로 받는다 — 기본값이 있어 부르는 쪽은 그대로다.
 * 같은 파일 안의 호출은 밖에서 가로챌 수 없어서, 이렇게 열어 두지 않으면 "늦게 도착한
 * 저장이 최신 것을 덮지 않는다"를 시험으로 잴 방법이 없다.
 */
export function createLayoutDraftQueue(
  kind: LayoutDraftKind,
  io: {
    clear: (kind: LayoutDraftKind) => Promise<void>;
    save: (kind: LayoutDraftKind, payload: unknown) => Promise<LayoutDraftItem>;
  } = { clear: clearLayoutDraft, save: saveLayoutDraft },
): LayoutDraftQueue {
  let chain: Promise<unknown> = Promise.resolve();
  let latestPayload: unknown;
  let saveWaiting = false;

  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    /* 앞 요청이 실패해도 줄은 계속 흘러야 한다 — 성공·실패 양쪽에 이어 붙인다. */
    const next = chain.then(task, task);
    chain = next.catch(() => undefined);
    return next;
  }

  return {
    clear: () => enqueue(() => io.clear(kind).catch(() => undefined)),
    save(payload) {
      latestPayload = payload;
      if (saveWaiting) return;
      saveWaiting = true;
      void enqueue(() => {
        saveWaiting = false;
        return io.save(kind, latestPayload).catch(() => undefined);
      });
    },
  };
}

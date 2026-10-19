import { describe, expect, it, vi } from "vitest";

import {
  createLayoutDraftQueue,
  type LayoutDraftItem,
  type LayoutDraftKind,
} from "./layout-drafts";

/*
 * 임시저장 요청을 한 줄로 세우는 장치(T-HUB-45 / 2026-08-22 감사 BLUE-11).
 *
 * 예전에는 800ms 뒤에 그냥 쏘고 잊어서 두 가지가 어긋날 수 있었다: 먼저 보낸 저장이
 * **늦게 도착**해 최신 내용을 덮는 것, 그리고 다 만든 뒤 지운 임시저장이 뒤늦게 도착한
 * 저장으로 **되살아나는** 것. 여기서 그 두 경우를 실제로 만들어 막히는지 본다.
 */

/** 사람이 원하는 순간에 끝내는 요청 — 도착 순서를 뒤집어 보려면 이게 필요하다. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

function item(payload: unknown): LayoutDraftItem {
  return { kind: "seat_draw", payload, row_version: "1", updated_at: "" };
}

describe("createLayoutDraftQueue", () => {
  it("sends one at a time and folds waiting saves into the latest value", async () => {
    const inFlight = deferred();
    const sent: unknown[] = [];
    const save = vi.fn(async (_kind: LayoutDraftKind, payload: unknown) => {
      sent.push(payload);
      if (sent.length === 1) await inFlight.promise;
      return item(payload);
    });

    const queue = createLayoutDraftQueue("seat_draw", {
      clear: vi.fn(async () => undefined),
      save,
    });
    queue.save({ step: 1 });
    /* 줄에 세운 요청은 다음 틱에 나간다 — 실제로 나가는 것을 보고 나서 값을 바꾼다. */
    await vi.waitFor(() => expect(sent).toHaveLength(1));

    /* 첫 요청이 아직 안 끝난 사이에 값이 두 번 더 바뀐다. */
    queue.save({ step: 2 });
    queue.save({ step: 3 });
    expect(sent).toHaveLength(1);

    inFlight.resolve();
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    /* 중간 값(step 2)은 보낼 이유가 없다 — 어차피 최신 것이 이긴다. */
    expect(sent).toEqual([{ step: 1 }, { step: 3 }]);
  });

  it("clears only after the save already in flight finishes", async () => {
    const inFlight = deferred();
    const order: string[] = [];
    const save = vi.fn(async (_kind: LayoutDraftKind, payload: unknown) => {
      order.push("save");
      await inFlight.promise;
      return item(payload);
    });
    const clear = vi.fn(async () => {
      order.push("clear");
    });

    const queue = createLayoutDraftQueue("team_draw", { clear, save });
    queue.save({ step: 1 });
    await vi.waitFor(() => expect(order).toEqual(["save"]));

    const cleared = queue.clear();
    /* 아직 저장이 안 끝났으므로 지우기는 시작조차 하면 안 된다 — 시작하면 되살아난다. */
    await Promise.resolve();
    expect(order).toEqual(["save"]);

    inFlight.resolve();
    await cleared;
    expect(order).toEqual(["save", "clear"]);
  });

  it("keeps the queue moving when a save fails", async () => {
    const order: string[] = [];
    const save = vi.fn(async () => {
      order.push("save");
      throw new Error("네트워크가 끊겼다");
    });
    const clear = vi.fn(async () => {
      order.push("clear");
    });

    const queue = createLayoutDraftQueue("seat_draw", { clear, save });
    queue.save({ step: 1 });
    /* 저장이 실패해도 줄이 멈추면 안 된다 — 만들기를 마친 뒤 지우기가 영영 안 돈다. */
    await expect(queue.clear()).resolves.toBeUndefined();
    expect(order).toEqual(["save", "clear"]);
  });
});

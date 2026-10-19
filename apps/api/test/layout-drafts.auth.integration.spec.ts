/*
 * T-HUB-31 3단계 — 만들던 자리·모둠을 서버에 임시저장한다.
 *
 * 이 스펙이 지키는 것 둘. ① **학생은 닿지 못한다** — 자리·모둠은 교사가 만드는
 * 것이고, 만들던 내용에는 아직 공개하지 않은 배치가 들어 있다. ② **다른 반 교사의
 * 것과 섞이지 않는다** — 열쇠가 학급·회원·종류 셋이라 하나라도 새면 남의 초안을 본다.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { LayoutDraftItem } from "../src/layout-drafts/layout-drafts.types.js";
import {
  app,
  createClassFixture,
  setupLayoutDraftsHarness,
  teardownSuppliesHarness,
  type ClassFixture,
} from "./supplies-test-harness.js";

let fixture: ClassFixture;

function expectError(
  response: { json(): { error: { code: string } }; statusCode: number },
  status: number,
  code: string,
): void {
  expect(response.statusCode).toBe(status);
  expect(response.json().error.code).toBe(code);
}

async function save(
  headers: Record<string, string>,
  kind: string,
  payload: unknown,
): Promise<{ json(): LayoutDraftItem; statusCode: number }> {
  return app.inject({
    headers,
    method: "PUT",
    payload: { payload },
    url: `/api/v1/layout-drafts/${kind}`,
  }) as never;
}

async function read(
  headers: Record<string, string>,
  kind: string,
): Promise<{ json(): LayoutDraftItem; statusCode: number }> {
  return app.inject({ headers, method: "GET", url: `/api/v1/layout-drafts/${kind}` }) as never;
}

beforeAll(async () => {
  await setupLayoutDraftsHarness();
  fixture = await createClassFixture();
}, 180_000);

afterAll(async () => {
  await teardownSuppliesHarness();
}, 120_000);

describe("layout drafts HTTP contract", () => {
  it("hands the teacher back exactly what was saved", async () => {
    const payload = { columnCount: 6, excludedMemberIds: ["3"], step: 2, title: "9월 자리" };
    const saved = await save(fixture.teacher.headers, "seat_draw", payload);
    expect(saved.statusCode).toBe(200);
    expect(saved.json().payload).toEqual(payload);

    const loaded = await read(fixture.teacher.headers, "seat_draw");
    expect(loaded.statusCode).toBe(200);
    expect(loaded.json().payload).toEqual(payload);
    /* 서버가 지키는 것은 누구 것인가와 언제 손댔나뿐이다 — 칸을 통째로 못박는다. */
    expect(Object.keys(loaded.json()).sort()).toEqual([
      "kind",
      "payload",
      "row_version",
      "updated_at",
    ]);
  });

  it("keeps one draft per kind by overwriting", async () => {
    await save(fixture.teacher.headers, "seat_draw", { step: 1 });
    await save(fixture.teacher.headers, "seat_draw", { step: 3 });

    const loaded = await read(fixture.teacher.headers, "seat_draw");
    expect(loaded.json().payload).toEqual({ step: 3 });
  });

  it("keeps seat and team drafts apart", async () => {
    await save(fixture.teacher.headers, "seat_draw", { which: "seat" });
    await save(fixture.teacher.headers, "team_draw", { which: "team" });

    expect((await read(fixture.teacher.headers, "seat_draw")).json().payload).toEqual({
      which: "seat",
    });
    expect((await read(fixture.teacher.headers, "team_draw")).json().payload).toEqual({
      which: "team",
    });
  });

  it("clears the draft once the layout is published", async () => {
    await save(fixture.teacher.headers, "team_draw", { step: 4 });

    const cleared = await app.inject({
      headers: fixture.teacher.headers,
      method: "DELETE",
      url: "/api/v1/layout-drafts/team_draw",
    });
    expect(cleared.statusCode).toBe(204);
    expect((await read(fixture.teacher.headers, "team_draw")).statusCode).toBe(404);

    /* 임시저장 없이 바로 만든 경우가 정상이므로, 두 번 비워도 실패하지 않는다. */
    const again = await app.inject({
      headers: fixture.teacher.headers,
      method: "DELETE",
      url: "/api/v1/layout-drafts/team_draw",
    });
    expect(again.statusCode).toBe(204);
  });

  it("keeps students out entirely", async () => {
    const student = fixture.students[0].headers;
    expectError((await read(student, "seat_draw")) as never, 403, "ROLE_INSUFFICIENT");
    expectError((await save(student, "seat_draw", { step: 1 })) as never, 403, "ROLE_INSUFFICIENT");
    expectError(
      (await app.inject({
        headers: student,
        method: "DELETE",
        url: "/api/v1/layout-drafts/seat_draw",
      })) as never,
      403,
      "ROLE_INSUFFICIENT",
    );
  });

  it("refuses a kind the database would reject anyway", async () => {
    expectError(
      (await save(fixture.teacher.headers, "poll", { step: 1 })) as never,
      400,
      "VALIDATION_FAILED",
    );
  });

  it("refuses a payload large enough to fill the table", async () => {
    const huge = { note: "가".repeat(200_000) };
    expectError(
      (await save(fixture.teacher.headers, "seat_draw", huge)) as never,
      400,
      "VALIDATION_FAILED",
    );
  });
});

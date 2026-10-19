/*
 * 교실 배치 템플릿 — 자리 만들기 1단계의 책상 배치를 이름 붙여 저장해 두고 불러 쓴다.
 *
 * 이 스펙이 지키는 것 셋. ① **학생은 닿지 못한다** — 교사가 쓰는 도구다.
 * ② **다른 반·다른 교사의 것과 섞이지 않는다** — 열쇠가 학급·회원 둘이라 하나라도
 * 새면 남의 목록을 본다. ③ **같은 이름은 덮어쓴다** — 목록에 같은 이름이 둘 있으면
 * 사람이 어느 것을 부를지 알 수 없다.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type {
  LayoutTemplateItem,
  LayoutTemplateListResult,
} from "../src/layout-templates/layout-templates.types.js";
import {
  app,
  createClassFixture,
  database,
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
  name: string,
  payload: unknown,
): Promise<{ json(): LayoutTemplateItem; statusCode: number }> {
  return app.inject({
    headers,
    method: "PUT",
    payload: { name, payload },
    url: "/api/v1/layout-templates",
  }) as never;
}

async function list(
  headers: Record<string, string>,
): Promise<{ json(): LayoutTemplateListResult; statusCode: number }> {
  return app.inject({ headers, method: "GET", url: "/api/v1/layout-templates" }) as never;
}

async function remove(
  headers: Record<string, string>,
  templateId: string,
): Promise<{ json(): { error: { code: string } }; statusCode: number }> {
  return app.inject({
    headers,
    method: "DELETE",
    url: `/api/v1/layout-templates/${templateId}`,
  }) as never;
}

const LAYOUT = { columnCount: 6, presetId: "class", rowCount: 5, unavailable: ["1:1"] };

beforeAll(async () => {
  await setupLayoutDraftsHarness();
  fixture = await createClassFixture();
}, 180_000);

afterAll(async () => {
  await teardownSuppliesHarness();
}, 120_000);

describe("layout templates HTTP contract", () => {
  it("hands the teacher back exactly what was saved", async () => {
    const saved = await save(fixture.teacher.headers, "우리 교실 기본형", LAYOUT);
    expect(saved.statusCode, JSON.stringify(saved.json())).toBe(200);
    expect(saved.json().payload).toEqual(LAYOUT);
    expect(saved.json().name).toBe("우리 교실 기본형");
    /* 돌려주는 칸을 통째로 못박는다 — 여기 없는 것이 조용히 새어 나가지 않게. */
    expect(Object.keys(saved.json()).sort()).toEqual([
      "created_at",
      "id",
      "name",
      "payload",
      "updated_at",
    ]);

    const listed = await list(fixture.teacher.headers);
    expect(listed.statusCode).toBe(200);
    expect(listed.json().items).toHaveLength(1);
    expect(listed.json().items[0]!.payload).toEqual(LAYOUT);
  });

  it("overwrites the same name instead of stacking duplicates", async () => {
    const first = await save(fixture.teacher.headers, "시험 대형", { rowCount: 4 });
    const second = await save(fixture.teacher.headers, "시험 대형", { rowCount: 7 });
    expect(second.json().id).toBe(first.json().id);

    const items = (await list(fixture.teacher.headers)).json().items;
    expect(items.filter(({ name }) => name === "시험 대형")).toHaveLength(1);
    expect(items.find(({ name }) => name === "시험 대형")?.payload).toEqual({ rowCount: 7 });
  });

  it("keeps another teacher's templates out of the list", async () => {
    const otherClass = await createClassFixture();
    await save(otherClass.teacher.headers, "남의 반 배치", { rowCount: 9 });

    const mine = (await list(fixture.teacher.headers)).json().items;
    expect(mine.some(({ name }) => name === "남의 반 배치")).toBe(false);

    /* 남의 것은 id 를 알아도 지울 수 없다 — 없는 것처럼 답한다. */
    const theirs = (await list(otherClass.teacher.headers)).json().items[0]!;
    expectError(await remove(fixture.teacher.headers, theirs.id), 404, "NOT_FOUND");
    expect((await list(otherClass.teacher.headers)).json().items).toHaveLength(1);
  });

  it("refuses names the database would reject anyway", async () => {
    for (const name of ["   ", "가".repeat(41)]) {
      expectError(
        (await save(fixture.teacher.headers, name, LAYOUT)) as never,
        400,
        "VALIDATION_FAILED",
      );
    }
    expectError(
      (await save(fixture.teacher.headers, `줄바꿈\n이름`, LAYOUT)) as never,
      400,
      "VALIDATION_FAILED",
    );
  });

  it("refuses a payload large enough to fill the table", async () => {
    expectError(
      (await save(fixture.teacher.headers, "너무 큰 배치", {
        note: "가".repeat(40_000),
      })) as never,
      400,
      "VALIDATION_FAILED",
    );
  });

  it("stops at the saved-layout limit but still allows editing what is already there", async () => {
    const limited = await createClassFixture();
    for (let index = 0; index < 20; index += 1) {
      const response = await save(limited.teacher.headers, `배치 ${index}`, { rowCount: index });
      expect(response.statusCode, `배치 ${index}`).toBe(200);
    }
    expectError(
      (await save(limited.teacher.headers, "스물한 번째", LAYOUT)) as never,
      409,
      "CONFLICT",
    );
    /* 상한은 **새 이름일 때만** 본다 — 꽉 찼다고 기존 배치 수정까지 막으면 갇힌다. */
    const edited = await save(limited.teacher.headers, "배치 0", { rowCount: 99 });
    expect(edited.statusCode).toBe(200);
    expect((await list(limited.teacher.headers)).json().items).toHaveLength(20);
  });

  /*
   * 상한 검사가 **없는 행을 잠그려** 하고 있었다. 새 이름 둘을 동시에 저장하면 서로
   * 잠글 행이 없어 둘 다 `count = 19` 를 읽고 둘 다 들어갔다 — DB 에는 21개가 되고
   * 목록은 `LIMIT 20` 이라 **하나가 조용히 숨었다.** 숨은 것은 화면에서 찾아 지울 수도
   * 없다(2026-08-22 감사 BLUE-04).
   *
   * ⚠️ **이 시험이 통과한다고 경합이 막혔다는 뜻은 아니다.** `Promise.all` 로 보내도 두
   * 트랜잭션이 실제로 겹친다는 보장이 없어서, 잠금을 빼고 돌려도 그냥 통과했다(2026-08-22
   * 실측). 그러니 이 시험은 **상한이 지켜지는 것**까지만 잰다.
   *
   * 잠금이 정말 직렬화하는지는 **DB 로 직접 확인했다** — 두 연결이 같은 키를 잡게 하면
   * 뒤엣것이 앞엣것을 기다린다. 여기를 고칠 사람은 그 확인을 다시 해 볼 것:
   *   BEGIN; SELECT pg_advisory_xact_lock(hashtextextended('classroom_layout_templates:<id>', 0));
   * 를 두 연결에서 걸어 보면 된다.
   */
  it("holds the limit when two new names are saved at the same moment", async () => {
    const racing = await createClassFixture();
    for (let index = 0; index < 19; index += 1) {
      const response = await save(racing.teacher.headers, `배치 ${index}`, { rowCount: index });
      expect(response.statusCode, `배치 ${index}`).toBe(200);
    }

    /* 열아홉 개인 상태에서 **서로 다른 이름 둘**을 동시에 보낸다 — 하나만 살아야 한다. */
    const [first, second] = await Promise.all([
      save(racing.teacher.headers, "동시 저장 가", { rowCount: 1 }),
      save(racing.teacher.headers, "동시 저장 나", { rowCount: 2 }),
    ]);

    const accepted = [first, second].filter((response) => response.statusCode === 200);
    const rejected = [first, second].filter((response) => response.statusCode === 409);
    expect(accepted, "둘 다 저장돼 상한이 뚫렸다").toHaveLength(1);
    expect(rejected, "거절이 409(CONFLICT)로 오지 않았다").toHaveLength(1);

    /* DB 에 21개가 생기면 목록(LIMIT 20)에서 하나가 숨는다 — 그것까지 확인한다. */
    const items = (await list(racing.teacher.headers)).json().items;
    expect(items, "목록이 상한을 넘었다").toHaveLength(20);
    const stored = await database
      .selectFrom("classroom_layout_templates")
      .select(({ fn }) => fn.countAll<string>().as("count"))
      .where("member_id", "=", racing.teacher.memberId!)
      .executeTakeFirstOrThrow();
    expect(stored.count, "목록에는 안 보이는 행이 DB 에 남았다").toBe("20");
  });

  it("deletes only once and answers 404 afterwards", async () => {
    const saved = await save(fixture.teacher.headers, "지울 배치", LAYOUT);
    expect((await remove(fixture.teacher.headers, saved.json().id)).statusCode).toBe(204);
    expectError(await remove(fixture.teacher.headers, saved.json().id), 404, "NOT_FOUND");
    expectError(await remove(fixture.teacher.headers, "999999"), 404, "NOT_FOUND");
  });

  it("keeps students out entirely", async () => {
    const student = fixture.students[0].headers;
    expectError((await list(student)) as never, 403, "ROLE_INSUFFICIENT");
    expectError((await save(student, "학생 배치", LAYOUT)) as never, 403, "ROLE_INSUFFICIENT");
    expectError(await remove(student, "1"), 403, "ROLE_INSUFFICIENT");
  });
});

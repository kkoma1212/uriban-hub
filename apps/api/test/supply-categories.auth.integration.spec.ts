import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { addCalendarDays, kstDate } from "../src/common/date/kst-date.js";
import {
  app,
  type ClassFixture,
  createClassFixture,
  database,
  setupSuppliesHarness,
  teardownSuppliesHarness,
} from "./supplies-test-harness.js";

/*
 * 숙제는 준비물 표에 종류 값으로 얹혀 있다(T-HUB-17). 기존 준비물 계약은
 * supplies.auth.integration.spec.ts 가 이미 775줄로 덮고 있어서, 종류에 얽힌
 * 계약만 여기로 갈랐다 — 한 파일에 밀어 넣으면 800줄 규칙을 넘긴다.
 */

interface SupplyItem {
  category: "general" | "homework";
  content_revision: string;
  id: string;
  row_version: string;
  title: string;
}

interface SupplyList {
  items: SupplyItem[];
  next_cursor: null | string;
}

let fixture: ClassFixture;

async function createSupply(
  payload: Record<string, unknown>,
): Promise<{ item: SupplyItem; statusCode: number }> {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/supplies",
    headers: { ...fixture.teacher.headers, "idempotency-key": randomUUID() },
    payload,
  });
  return { item: response.json() as SupplyItem, statusCode: response.statusCode };
}

async function listSupplies(query: string, headers: Record<string, string>): Promise<SupplyList> {
  const response = await app.inject({ method: "GET", url: `/api/v1/supplies?${query}`, headers });
  expect(response.statusCode).toBe(200);
  return response.json() as SupplyList;
}

beforeAll(setupSuppliesHarness, 120_000);

beforeEach(async () => {
  fixture = await createClassFixture();
});

afterAll(teardownSuppliesHarness, 120_000);

describe("supply categories", () => {
  it("treats an unlabelled supply as an ordinary supply", async () => {
    const created = await createSupply({
      needed_on: addCalendarDays(kstDate(new Date()), 1),
      title: "종류 없이 등록",
    });

    expect(created.statusCode).toBe(201);
    expect(created.item.category).toBe("general");
  });

  it("stores homework as homework and hands it back that way", async () => {
    const created = await createSupply({
      category: "homework",
      needed_on: addCalendarDays(kstDate(new Date()), 1),
      title: "수학 익힘책 12-15쪽",
    });

    expect(created.statusCode).toBe(201);
    expect(created.item.category).toBe("homework");

    const stored = await database
      .selectFrom("supplies")
      .select("category")
      .where("id", "=", created.item.id)
      .executeTakeFirstOrThrow();
    expect(stored.category).toBe("homework");
  });

  it("rejects a category the product has not defined", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/supplies",
      headers: { ...fixture.teacher.headers, "idempotency-key": randomUUID() },
      payload: {
        category: "quiz",
        needed_on: addCalendarDays(kstDate(new Date()), 1),
        title: "정의되지 않은 종류",
      },
    });

    expect(response.statusCode).toBe(400);
  });

  /*
   * 걸러내기를 화면에서 하면 한 페이지가 통째로 걸러져 "더 없음"으로 보인다.
   * 그래서 서버가 거르고, 거르지 않으면 둘 다 준다 — 학생 화면이 그렇게 쓴다.
   */
  it("filters by category on the server and mixes both when asked for neither", async () => {
    const tomorrow = addCalendarDays(kstDate(new Date()), 1);
    await createSupply({ needed_on: tomorrow, title: "색연필" });
    await createSupply({ category: "homework", needed_on: tomorrow, title: "국어 독후감" });

    const everything = await listSupplies("scope=upcoming", fixture.teacher.headers);
    expect(everything.items.map(({ title }) => title).sort()).toEqual(["국어 독후감", "색연필"]);

    const homeworkOnly = await listSupplies(
      "scope=upcoming&category=homework",
      fixture.teacher.headers,
    );
    expect(homeworkOnly.items.map(({ title }) => title)).toEqual(["국어 독후감"]);

    const suppliesOnly = await listSupplies(
      "scope=upcoming&category=general",
      fixture.teacher.headers,
    );
    expect(suppliesOnly.items.map(({ title }) => title)).toEqual(["색연필"]);
  });

  it("rejects a list filter the product has not defined", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/supplies?scope=upcoming&category=quiz",
      headers: fixture.teacher.headers,
    });

    expect(response.statusCode).toBe(400);
  });

  it("lets the student list stay filtered too", async () => {
    const tomorrow = addCalendarDays(kstDate(new Date()), 1);
    await createSupply({ needed_on: tomorrow, title: "학생용 색연필" });
    await createSupply({ category: "homework", needed_on: tomorrow, title: "학생용 독후감" });

    const homeworkOnly = await listSupplies(
      "scope=upcoming&category=homework",
      fixture.students[0].headers,
    );
    expect(homeworkOnly.items.map(({ title }) => title)).toEqual(["학생용 독후감"]);
  });

  /*
   * 종류를 고치면 제목·날짜와 똑같이 content_revision 이 올라간다. 준비물이 숙제가
   * 되는 것은 해야 할 일이 달라지는 변화라 확인해 둔 학생이 다시 확인해야 한다.
   *
   * 감사 JSON 에는 종류를 남기지 않는다 — audit_logs 키 허용목록 CHECK 가 supply.%
   * 에 다섯 키만 허용하고, 지금 코드도 description 변경을 남기지 않는다. 남는 것은
   * "무언가 바뀌어 content_revision 이 올랐다"까지다.
   */
  it("bumps the revision when the category changes and still writes an update audit row", async () => {
    const created = await createSupply({
      needed_on: addCalendarDays(kstDate(new Date()), 1),
      title: "숙제로 바꿀 항목",
    });
    expect(created.item.category).toBe("general");

    const updated = await app.inject({
      method: "PATCH",
      url: `/api/v1/supplies/${created.item.id}`,
      headers: { ...fixture.teacher.headers, "if-match": `"${created.item.row_version}"` },
      payload: { category: "homework" },
    });

    expect(updated.statusCode).toBe(200);
    const item = updated.json() as SupplyItem;
    expect(item.category).toBe("homework");
    expect(Number(item.content_revision)).toBe(Number(created.item.content_revision) + 1);

    const audit = await database
      .selectFrom("audit_logs")
      .select(["after_json", "before_json"])
      .where("class_id", "=", fixture.classId)
      .where("action", "=", "supply.updated")
      .where("target_id", "=", created.item.id)
      .executeTakeFirstOrThrow();
    expect(audit.before_json).toEqual({ content_revision: created.item.content_revision });
    expect(audit.after_json).toEqual({ content_revision: item.content_revision });
  });

  it("leaves the revision alone when the category is resent unchanged", async () => {
    const created = await createSupply({
      category: "homework",
      needed_on: addCalendarDays(kstDate(new Date()), 1),
      title: "같은 종류 재전송",
    });

    const updated = await app.inject({
      method: "PATCH",
      url: `/api/v1/supplies/${created.item.id}`,
      headers: { ...fixture.teacher.headers, "if-match": `"${created.item.row_version}"` },
      payload: { category: "homework" },
    });

    expect(updated.statusCode).toBe(200);
    const item = updated.json() as SupplyItem;
    expect(item.content_revision).toBe(created.item.content_revision);
    expect(item.row_version).toBe(created.item.row_version);
  });

  it("keeps the category out of a student's reach", async () => {
    const created = await createSupply({
      needed_on: addCalendarDays(kstDate(new Date()), 1),
      title: "학생이 바꿔 볼 항목",
    });

    const response = await app.inject({
      method: "PATCH",
      url: `/api/v1/supplies/${created.item.id}`,
      headers: { ...fixture.students[0].headers, "if-match": `"${created.item.row_version}"` },
      payload: { category: "homework" },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("ROLE_INSUFFICIENT");
  });
});

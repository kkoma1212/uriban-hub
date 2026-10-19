import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "kysely";

import { addCalendarDays, kstDate } from "../src/common/date/kst-date.js";
import { HomeService } from "../src/home/home.service.js";
import {
  app,
  type ClassFixture,
  createClassFixture,
  database,
  setupSuppliesHarness,
  teardownSuppliesHarness,
} from "./supplies-test-harness.js";

/*
 * 홈이 준비물과 숙제를 다른 기간으로 싣는다는 계약. 준비물은 "내일 가져올 것"이라
 * 오늘·내일이면 되지만, 숙제는 **날짜 상한 없이** 다가오는 것부터 싣는다
 * (2026-08-10 Hex 결정 — 학생이 홈만 보고는 마감 하루 전에야 알던 것을 고쳤다).
 *
 * 처음엔 7일로 잘랐다가 걷어냈다. 방학 중에 개학 다음 날 숙제를 올리는 실제 사용이
 * 9일 뒤라 창 밖이었다 — 어떤 숫자를 골라도 언젠가 빗나간다.
 *
 * 이 검사가 없으면 "숙제도 오늘·내일만"으로 조용히 되돌아가도 아무도 모른다.
 */

let fixture: ClassFixture;

async function seedAt(owner: ClassFixture, category: string, neededOn: string, title: string) {
  return database
    .insertInto("supplies")
    .values({
      category,
      class_id: owner.classId,
      created_by_member_id: owner.teacher.memberId!,
      needed_on: sql<Date>`${neededOn}::date`,
      title,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
}

beforeAll(async () => {
  await setupSuppliesHarness();
  fixture = await createClassFixture();
}, 180_000);

afterAll(teardownSuppliesHarness);

describe("home supplies window", () => {
  it("carries far-off homework but keeps plain supplies to today and tomorrow", async () => {
    const today = kstDate(new Date());
    /* Hex 가 실제로 만든 것과 같은 모양 — 방학 중에 개학 다음 날 숙제를 올린 경우다. */
    const farAhead = addCalendarDays(today, 9);

    const [homeworkAhead, supplyAhead, supplyToday] = await Promise.all([
      seedAt(fixture, "homework", farAhead, "아흐레 뒤 숙제"),
      seedAt(fixture, "general", farAhead, "아흐레 뒤 준비물"),
      seedAt(fixture, "general", today, "오늘 준비물"),
    ]);

    const home = await app.get(HomeService).getForUser(fixture.students[0]!.userId);
    expect(home.supplies.status).not.toBe("error");
    const titles = (home.supplies.data ?? []).map((supply) => supply.title);

    expect(titles).toContain("오늘 준비물");
    expect(titles).toContain("아흐레 뒤 숙제");
    /*
     * 준비물까지 넓히면 "내일 가져올 것"의 급한 느낌이 흐려진다. 같은 날짜인데
     * 종류만 다른 두 행을 함께 심어, 날짜가 아니라 종류로 갈리는 것을 못박는다.
     */
    expect(titles).not.toContain("아흐레 뒤 준비물");
    // 가까운 것이 먼저 온다 — 홈은 몇 건만 싣기 때문에 순서가 곧 무엇이 잘리느냐다.
    expect(titles.indexOf("오늘 준비물")).toBeLessThan(titles.indexOf("아흐레 뒤 숙제"));

    await database
      .deleteFrom("supplies")
      .where("id", "in", [homeworkAhead.id, supplyAhead.id, supplyToday.id])
      .execute();
  });

  it("leaves homework behind once its day has passed", async () => {
    const yesterday = addCalendarDays(kstDate(new Date()), -1);
    const homework = await seedAt(fixture, "homework", yesterday, "어제까지였던 숙제");

    const home = await app.get(HomeService).getForUser(fixture.students[0]!.userId);
    expect((home.supplies.data ?? []).map((supply) => supply.title)).not.toContain(
      "어제까지였던 숙제",
    );

    await database.deleteFrom("supplies").where("id", "=", homework.id).execute();
  });
});

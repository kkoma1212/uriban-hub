import { ConfigService } from "@nestjs/config";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { AdminReconfirmReportService } from "../src/admin-management/admin-reconfirm-report.service.js";
import { readDatabaseKstToday } from "../src/common/date/database-kst-clock.js";
import { addCalendarDays } from "../src/common/date/kst-date.js";
import type { AppEnvironment } from "../src/config/environment.js";
import {
  app,
  type ActorFixture,
  type ClassFixture,
  createClassFixture,
  database,
  seedSupply,
  setupSuppliesHarness,
  teardownSuppliesHarness,
} from "./supplies-test-harness.js";

// 시범 판정 지표(2026-10-22): 실제 확인·수정 요청이 남긴 기록으로 센다(PostgreSQL 시험 DB).
let fixture: ClassFixture;
let today: string;

const service = () =>
  new AdminReconfirmReportService(
    database,
    new ConfigService({ DATABASE_ENGINE: "postgres" }) as ConfigService<AppEnvironment, true>,
  );

const report = () => service().report({ from: today, to: today });

// 공지와 준비물은 번호가 겹칠 수 있어 종류까지 함께 거른다.
const eventsFor = async (kind: "notice" | "supply", itemId: string) =>
  (await report()).events.filter((event) => event.kind === kind && event.item_id === itemId);

const classRow = async () => (await report()).classes.find((row) => row.id === fixture.classId);

async function revisedAt(action: string, targetId: string, revision: string): Promise<Date> {
  const rows = await database
    .selectFrom("audit_logs")
    .select(["created_at", "after_json"])
    .where("action", "=", action)
    .where("target_id", "=", targetId)
    .execute();
  const row = rows.find(
    (candidate) =>
      (candidate.after_json as { content_revision?: string } | null)?.content_revision === revision,
  );
  if (row === undefined) throw new Error("revision audit row missing");
  return new Date(row.created_at as unknown as string);
}

beforeAll(setupSuppliesHarness, 120_000);
beforeEach(async () => {
  fixture = await createClassFixture();
  today = await readDatabaseKstToday(database, "postgres");
});
afterAll(teardownSuppliesHarness, 120_000);

describe("admin reconfirm report", () => {
  it("counts students who confirmed before a notice revision and reconfirmed within 24 hours", async () => {
    const notice = await database
      .insertInto("notices")
      .values({
        class_id: fixture.classId,
        content: "내일 체육복을 챙겨 오세요.",
        created_by_member_id: fixture.teacher.memberId!,
        title: "체육 준비",
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    const confirm = (student: ActorFixture, revision: number) =>
      app.inject({
        method: "PUT",
        url: `/api/v1/notices/${notice.id}/confirmation`,
        headers: student.headers,
        payload: { content_revision: revision },
      });
    const patch = (rowVersion: number, payload: Record<string, unknown>) =>
      app.inject({
        method: "PATCH",
        url: `/api/v1/notices/${notice.id}`,
        headers: { ...fixture.teacher.headers, "if-match": `"${rowVersion}"` },
        payload,
      });
    const [first, second, third] = fixture.students;
    expect((await confirm(first!, 1)).statusCode).toBe(200);
    expect((await confirm(second!, 1)).statusCode).toBe(200);
    // 셋째 학생은 수정 전에 확인하지 않아 대상이 아니다.
    expect((await patch(1, { content: "모레 체육복을 챙겨 오세요." })).statusCode).toBe(200);
    expect((await confirm(first!, 2)).statusCode).toBe(200);
    expect((await confirm(third!, 2)).statusCode).toBe(200);

    expect(await eventsFor("notice", notice.id)).toEqual([
      expect.objectContaining({
        class_id: fixture.classId,
        kind: "notice",
        revision: "2",
        eligible: 2,
        reconfirmed_within_window: 1,
        reconfirmed_total: 1,
      }),
    ]);

    // 24시간이 지난 재확인은 '지금까지'에만 든다.
    const revisionTime = await revisedAt("notice.updated", notice.id, "2");
    await database
      .updateTable("notice_reads")
      .set({ confirmed_at: new Date(revisionTime.getTime() + 25 * 3_600_000) })
      .where("notice_id", "=", notice.id)
      .where("member_id", "=", first!.memberId!)
      .execute();
    expect(await eventsFor("notice", notice.id)).toEqual([
      expect.objectContaining({ eligible: 2, reconfirmed_within_window: 0, reconfirmed_total: 1 }),
    ]);

    // 오타 수정은 판이 오르지 않아 새 수정으로 세지 않는다.
    expect(
      (await patch(2, { content: "모레 체육복을 챙겨 오세요!", minor_edit: true })).statusCode,
    ).toBe(200);
    expect(await classRow()).toMatchObject({ revisions: 1, earlier_revisions_excluded: 0 });

    // 다시 판을 올리면 마지막 수정(3)만 세고 앞선 수정(2)은 제외 수로만 남는다.
    expect((await patch(3, { content: "글피 체육복을 챙겨 오세요!" })).statusCode).toBe(200);
    expect(await eventsFor("notice", notice.id)).toEqual([
      expect.objectContaining({ revision: "3", eligible: 3, reconfirmed_within_window: 0 }),
    ]);
    expect(await classRow()).toMatchObject({
      revisions: 1,
      earlier_revisions_excluded: 1,
      eligible: 3,
      school_name: expect.any(String),
    });
  });

  it("counts supply re-checks on the new revision", async () => {
    const supply = await seedSupply(fixture, { title: "실내화", description: "실내화 챙기기" });
    const check = (student: ActorFixture, revision: number) =>
      app.inject({
        method: "PUT",
        url: `/api/v1/supplies/${supply.id}/check`,
        headers: student.headers,
        payload: { content_revision: revision, is_checked: true },
      });
    const [first, second] = fixture.students;
    expect((await check(first!, 1)).statusCode).toBe(200);
    expect((await check(second!, 1)).statusCode).toBe(200);
    const revised = await app.inject({
      method: "PATCH",
      url: `/api/v1/supplies/${supply.id}`,
      headers: { ...fixture.teacher.headers, "if-match": '"1"' },
      payload: { description: "실내화와 물통 챙기기" },
    });
    expect(revised.statusCode).toBe(200);
    expect((await check(second!, 2)).statusCode).toBe(200);

    expect(await eventsFor("supply", supply.id)).toEqual([
      expect.objectContaining({
        kind: "supply",
        revision: "2",
        eligible: 2,
        reconfirmed_within_window: 1,
        reconfirmed_total: 1,
      }),
    ]);
  });

  it("refuses a reversed or too long period", async () => {
    await expect(
      service().report({ from: today, to: addCalendarDays(today, -1) }),
    ).rejects.toMatchObject({ message: "ADMIN_REPORT_PERIOD_INVALID" });
    await expect(
      service().report({ from: addCalendarDays(today, -120), to: today }),
    ).rejects.toMatchObject({ message: "ADMIN_REPORT_PERIOD_INVALID" });
    await expect(service().report({ from: "2026-02-30", to: today })).rejects.toMatchObject({
      message: "ADMIN_REPORT_PERIOD_INVALID",
    });
    await expect(
      service().report({ from: addCalendarDays(today, -119), to: today }),
    ).resolves.toMatchObject({ window_hours: 24 });
  });
});

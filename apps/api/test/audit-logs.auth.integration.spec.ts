import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";

import { CLASS_AUDIT_ACTIONS } from "../src/audit-logs/audit-logs.types.js";
import {
  app,
  type ClassFixture,
  createClassFixture,
  database,
  setupSuppliesHarness,
  teardownSuppliesHarness,
} from "./supplies-test-harness.js";

interface AuditLogResponse {
  items: Array<{
    action: string;
    actor: { display_name: string; role: string };
    after: Record<string, unknown> | null;
    before: Record<string, unknown> | null;
    created_at: string;
    reason: string | null;
    target: { id: string; snapshot: Record<string, unknown> | null; type: string };
  }>;
  next_cursor: string | null;
}

type SeedAction = "class.updated" | "notice.updated";

let fixture: ClassFixture;

function expectError(
  response: { json(): { error: { code: string } }; statusCode: number },
  status: number,
  code: string,
): void {
  expect(response.statusCode).toBe(status);
  expect(response.json().error.code).toBe(code);
}

async function databaseAuditTimestamp(): Promise<string> {
  const row = await database
    .selectNoFrom(
      sql<string>`to_char(
        (CURRENT_TIMESTAMP - INTERVAL '1 hour') AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      )`.as("audit_timestamp"),
    )
    .executeTakeFirstOrThrow();
  return row.audit_timestamp;
}

async function seedClassAudit(
  owner: ClassFixture,
  targetId: string,
  options: {
    action?: SeedAction;
    ageMinutes?: number;
    createdAt?: string;
  } = {},
): Promise<void> {
  const action = options.action ?? "class.updated";
  const isNotice = action === "notice.updated";
  const before = isNotice
    ? { notice_id: targetId, title: `이전 ${targetId}` }
    : { class_id: owner.classId, name: `이전 ${targetId}` };
  const after = isNotice
    ? { notice_id: targetId, title: `변경 ${targetId}` }
    : { class_id: owner.classId, name: `변경 ${targetId}` };
  const createdAt =
    options.createdAt === undefined
      ? sql<Date>`CURRENT_TIMESTAMP - (${options.ageMinutes ?? 0}::integer * INTERVAL '1 minute')`
      : sql<Date>`${options.createdAt}::timestamptz`;

  await database
    .insertInto("audit_logs")
    .values({
      action,
      actor_display_name_snapshot: "감사 교사",
      actor_member_id: owner.teacher.memberId,
      actor_role_snapshot: "teacher",
      actor_user_id: owner.teacher.userId,
      after_json: after,
      before_json: before,
      class_id: owner.classId,
      created_at: createdAt,
      reason: null,
      request_id: randomUUID(),
      target_id: targetId,
      target_snapshot: null,
      target_type: isNotice ? "notice" : "class",
    })
    .execute();
}

async function getAuditLogs(
  owner: ClassFixture,
  query = "",
): Promise<Awaited<ReturnType<typeof app.inject>>> {
  return app.inject({
    headers: owner.teacher.headers,
    method: "GET",
    url: `/api/v1/audit-logs${query}`,
  });
}

async function suspendClass(owner: ClassFixture, reason: string): Promise<void> {
  await database
    .updateTable("classes")
    .set({
      status: "suspended",
      suspended_at: sql<Date>`clock_timestamp()`,
      suspended_by_operator_id: owner.operatorId,
      suspended_reason: reason,
    })
    .where("id", "=", owner.classId)
    .execute();
}

beforeAll(setupSuppliesHarness, 120_000);

beforeEach(async () => {
  fixture = await createClassFixture();
});

afterAll(teardownSuppliesHarness, 120_000);

describe("audit logs HTTP contract", () => {
  it("allows only an active approved homeroom teacher in an active class", async () => {
    expectError(
      await app.inject({ method: "GET", url: "/api/v1/audit-logs" }),
      401,
      "UNAUTHENTICATED",
    );
    expectError(
      await app.inject({
        headers: fixture.students[0].headers,
        method: "GET",
        url: "/api/v1/audit-logs",
      }),
      403,
      "ROLE_INSUFFICIENT",
    );
    expectError(
      await app.inject({
        headers: fixture.outsider.headers,
        method: "GET",
        url: "/api/v1/audit-logs",
      }),
      404,
      "NOT_FOUND",
    );

    await database
      .updateTable("teacher_profiles")
      .set({
        temporary_password_expires_at: sql<Date>`clock_timestamp() + INTERVAL '1 day'`,
        temporary_password_must_change: true,
      })
      .where("user_id", "=", fixture.teacher.userId)
      .execute();
    expectError(await getAuditLogs(fixture), 403, "ROLE_INSUFFICIENT");

    const suspended = await createClassFixture();
    await suspendClass(suspended, "감사 로그 정지 테스트");
    expectError(await getAuditLogs(suspended), 423, "CLASS_SUSPENDED");

    const revoked = await createClassFixture();
    await suspendClass(revoked, "교사 권한 회수 테스트");
    await database
      .updateTable("teacher_profiles")
      .set({
        revoke_reason: "감사 로그 권한 테스트",
        revoked_at: sql<Date>`clock_timestamp()`,
        revoked_by_operator_id: revoked.operatorId,
        status: "revoked",
      })
      .where("user_id", "=", revoked.teacher.userId)
      .execute();
    expectError(await getAuditLogs(revoked), 403, "ROLE_INSUFFICIENT");

    const inactive = await createClassFixture();
    await suspendClass(inactive, "비활성 계정 테스트");
    await database
      .updateTable("users")
      .set({ is_active: false })
      .where("id", "=", inactive.teacher.userId)
      .execute();
    expectError(await getAuditLogs(inactive), 401, "UNAUTHENTICATED");

    const deleted = await createClassFixture();
    await suspendClass(deleted, "삭제 계정 테스트");
    await database
      .updateTable("users")
      .set({ deleted_at: sql<Date>`clock_timestamp()` })
      .where("id", "=", deleted.teacher.userId)
      .execute();
    expectError(await getAuditLogs(deleted), 401, "UNAUTHENTICATED");
  });

  it("returns only current-class safe fields and excludes security/operator audit", async () => {
    const other = await createClassFixture();
    await seedClassAudit(fixture, "101");
    await seedClassAudit(other, "202");
    await database
      .insertInto("security_audit_logs")
      .values({
        action: "authz.denied",
        actor_class_id: fixture.classId,
        actor_email_hmac: null,
        actor_ip: "127.0.0.1",
        actor_user_id: fixture.teacher.userId,
        deny_reason: "fixture",
        event_id: randomUUID(),
        failure_code: "ROLE_INSUFFICIENT",
        hmac_key_version: null,
        method: "GET",
        request_id: randomUUID(),
        resource: "audit-logs",
        sanitized_path: "/api/v1/audit-logs",
        target_class_id: fixture.classId,
        user_agent: "fixture",
      })
      .execute();
    await database
      .insertInto("operator_audit_logs")
      .values({
        action: "operator.created",
        actor_type: "operator",
        after_json: { operator_id: fixture.operatorId, status: "active" },
        before_json: null,
        checksum: null,
        operator_id: fixture.operatorId,
        run_id: randomUUID(),
        target_id: fixture.operatorId,
        target_type: "operator",
      })
      .execute();

    const response = await getAuditLogs(fixture);
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json<AuditLogResponse>();
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toEqual({
      action: "class.updated",
      actor: { display_name: "감사 교사", role: "teacher" },
      after: { class_id: fixture.classId, name: "변경 101" },
      before: { class_id: fixture.classId, name: "이전 101" },
      created_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u),
      reason: null,
      target: { id: "101", snapshot: null, type: "class" },
    });
    expect(JSON.stringify(body)).not.toContain("변경 202");
    expect(JSON.stringify(body)).not.toContain("authz.denied");
    expect(JSON.stringify(body)).not.toContain("operator.created");
    expect(Object.keys(body.items[0]!).sort()).toEqual([
      "action",
      "actor",
      "after",
      "before",
      "created_at",
      "reason",
      "target",
    ]);
  });

  it("keeps the DB action constraint synchronized and returns current extension actions", async () => {
    /*
     * action 목록이 CHECK에서 참조 표로 옮겨졌다(T-HUB-21). 제약 정의 문자열을
     * 정규식으로 뜯어 값을 뽑던 것이 표를 그대로 읽는 것으로 바뀌었다 —
     * 옮긴 김에 얻은 이득이라 되돌리지 않는다.
     */
    const catalog = await sql<{ action: string }>`
      SELECT action FROM audit_log_actions ORDER BY action
    `.execute(database);
    const databaseActions = catalog.rows.map((row) => row.action);
    expect(databaseActions).toEqual([...CLASS_AUDIT_ACTIONS].sort());

    const actions = [
      {
        action: "notice.reminder_created",
        after: {
          content_revision: "3",
          cooldown_suppressed_count: 1,
          created_count: 2,
          current_unresolved_count: 4,
          reminder_batch_id: randomUUID(),
        },
        reason: null,
        targetId: "901",
        targetType: "notice",
      },
      {
        action: "supply.reminder_created",
        after: {
          content_revision: "2",
          cooldown_suppressed_count: 0,
          created_count: 3,
          current_unresolved_count: 3,
          reminder_batch_id: randomUUID(),
        },
        reason: null,
        targetId: "902",
        targetType: "supply",
      },
      {
        action: "seat_draw.adjusted",
        after: {
          assigned_student_count: 28,
          excluded_student_count: 2,
          row_count: 6,
          seat_draw_id: "903",
          status: "draft",
        },
        reason: "teacher_swap_assignments",
        targetId: "903",
        targetType: "seat_draw",
      },
      {
        action: "team_draw.adjusted",
        after: {
          assigned_student_count: 28,
          excluded_student_count: 2,
          group_count: 7,
          status: "draft",
          team_draw_id: "904",
        },
        reason: "teacher_swap_assignments",
        targetId: "904",
        targetType: "team_draw",
      },
      // 투표 수정(poll-edit.ts)이 남기는 모양. 종류 목록에 빠지면 반 감사 화면 전체가 500이 된다.
      {
        action: "poll.updated",
        after: {
          closes_at: "2026-10-20T08:00:00.000Z",
          deleted_at: null,
          option_count: 3,
          poll_id: "905",
          title: "체험학습 장소",
          vote_count: 0,
        },
        reason: null,
        targetId: "905",
        targetType: "poll",
      },
    ] as const;

    await database
      .insertInto("audit_logs")
      .values(
        actions.map((item) => ({
          action: item.action,
          actor_display_name_snapshot: "감사 교사",
          actor_member_id: fixture.teacher.memberId,
          actor_role_snapshot: "teacher",
          actor_user_id: fixture.teacher.userId,
          after_json: item.after,
          before_json: null,
          class_id: fixture.classId,
          reason: item.reason,
          request_id: randomUUID(),
          target_id: item.targetId,
          target_snapshot: null,
          target_type: item.targetType,
        })),
      )
      .execute();

    const response = await getAuditLogs(fixture);
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json<AuditLogResponse>();
    expect(body.items.map((item) => item.action).sort()).toEqual(
      actions.map((item) => item.action).sort(),
    );
    expect(JSON.stringify(body)).not.toContain("student_name");
    expect(JSON.stringify(body)).not.toContain("student_number");
    expect(JSON.stringify(body)).not.toContain("member_id");

    for (const item of actions) {
      const filtered = await getAuditLogs(fixture, `?days=90&action=${item.action}`);
      expect(filtered.statusCode, filtered.body).toBe(200);
      expect(filtered.json<AuditLogResponse>().items).toMatchObject([
        {
          action: item.action,
          target: { id: item.targetId, type: item.targetType },
        },
      ]);
    }
  });

  // 이관 CLI가 남긴 기록을 교사가 실제로 보는지 확인한다. DB에 남기만 하고 API가
  // 안 내보내면 "담임이 언제 누구에게 넘어갔는지 앱에서 볼 수 없다"는 문제가 그대로다.
  it("shows the teacher a handover written by the operator, without an actor member", async () => {
    await database
      .insertInto("audit_logs")
      .values({
        action: "class.teacher_transferred",
        // 운영자는 학급 구성원이 아니다. 이관 CLI가 쓰는 모양 그대로 넣는다.
        actor_display_name_snapshot: "운영자",
        actor_member_id: null,
        actor_role_snapshot: "operator",
        actor_user_id: null,
        after_json: { member_id: "777", role: "teacher", status: "approved" },
        before_json: { member_id: "776", role: "teacher", status: "transferred" },
        class_id: fixture.classId,
        reason: "휴직 대체",
        request_id: randomUUID(),
        target_id: "777",
        target_snapshot: null,
        target_type: "member",
      })
      .execute();

    const response = await getAuditLogs(fixture, "?days=90&action=class.teacher_transferred");
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<AuditLogResponse>().items).toMatchObject([
      {
        action: "class.teacher_transferred",
        // "언제 누구에게"의 누가에 해당한다 — 교사가 운영자 조치였음을 알아야 한다.
        actor: { display_name: "운영자", role: "operator" },
        reason: "휴직 대체",
        target: { id: "777", type: "member" },
      },
    ]);
  });

  it("uses exact action filtering and the DB clock for 7, 30, and 90 day windows", async () => {
    const day = 24 * 60;
    await seedClassAudit(fixture, "701", { ageMinutes: 7 * day - 60 });
    await seedClassAudit(fixture, "702", { ageMinutes: 7 * day + 60 });
    await seedClassAudit(fixture, "703", {
      action: "notice.updated",
      ageMinutes: 30 * day - 60,
    });
    await seedClassAudit(fixture, "704", { ageMinutes: 30 * day + 60 });
    await seedClassAudit(fixture, "705", {
      action: "notice.updated",
      ageMinutes: 90 * day - 60,
    });
    await seedClassAudit(fixture, "706", { ageMinutes: 90 * day + 60 });
    // 90일 창으로는 닿지 않던 구간. 학년 중간에 부임한 담임이 전임 시절 기록을
    // 못 보던 것이 여기였다(T-HUB-13).
    await seedClassAudit(fixture, "707", { ageMinutes: 180 * day - 60 });
    await seedClassAudit(fixture, "708", { ageMinutes: 180 * day + 60 });
    await seedClassAudit(fixture, "709", { ageMinutes: 365 * day - 60 });
    // 보관기간 밖. 조회 상한을 보관기간에 맞췄으므로 이건 끝까지 안 나와야 한다.
    await seedClassAudit(fixture, "710", { ageMinutes: 365 * day + 60 });

    const seven = await getAuditLogs(fixture, "?days=7");
    expect(seven.statusCode, seven.body).toBe(200);
    expect(seven.json<AuditLogResponse>().items.map((item) => item.target.id)).toEqual(["701"]);

    const thirty = await getAuditLogs(fixture, "?days=30");
    expect(thirty.statusCode, thirty.body).toBe(200);
    expect(thirty.json<AuditLogResponse>().items.map((item) => item.target.id)).toEqual([
      "701",
      "702",
      "703",
    ]);

    const ninety = await getAuditLogs(fixture, "?days=90");
    expect(ninety.statusCode, ninety.body).toBe(200);
    expect(ninety.json<AuditLogResponse>().items.map((item) => item.target.id)).toEqual([
      "701",
      "702",
      "703",
      "704",
      "705",
    ]);

    const halfYear = await getAuditLogs(fixture, "?days=180");
    expect(halfYear.statusCode, halfYear.body).toBe(200);
    expect(halfYear.json<AuditLogResponse>().items.map((item) => item.target.id)).toEqual([
      "701",
      "702",
      "703",
      "704",
      "705",
      "706",
      "707",
    ]);

    const wholeYear = await getAuditLogs(fixture, "?days=365");
    expect(wholeYear.statusCode, wholeYear.body).toBe(200);
    expect(wholeYear.json<AuditLogResponse>().items.map((item) => item.target.id)).toEqual([
      "701",
      "702",
      "703",
      "704",
      "705",
      "706",
      "707",
      "708",
      "709",
    ]);

    const noticeOnly = await getAuditLogs(fixture, "?action=notice.updated&days=90");
    expect(noticeOnly.statusCode, noticeOnly.body).toBe(200);
    expect(noticeOnly.json<AuditLogResponse>().items.map((item) => item.target.id)).toEqual([
      "703",
      "705",
    ]);

    for (const query of [
      "?action=notice.unapproved",
      "?action=security.authz.denied",
      "?days=0",
      "?days=8",
      "?days=090",
      // 보관기간 밖은 열지 않는다.
      "?days=366",
      "?days=730",
    ]) {
      expectError(await getAuditLogs(fixture, query), 400, "VALIDATION_FAILED");
    }
  });

  it("paginates 20 at a time by the exact created_at and id tuple", async () => {
    const createdAt = await databaseAuditTimestamp();
    for (let index = 1; index <= 21; index += 1) {
      await seedClassAudit(fixture, String(index), { createdAt });
    }

    const first = await getAuditLogs(fixture);
    expect(first.statusCode, first.body).toBe(200);
    const firstBody = first.json<AuditLogResponse>();
    expect(firstBody.items).toHaveLength(20);
    expect(firstBody.items.map((item) => item.target.id)).toEqual(
      Array.from({ length: 20 }, (_value, index) => String(21 - index)),
    );
    expect(firstBody.items.every((item) => item.created_at === createdAt)).toBe(true);
    expect(firstBody.next_cursor).toEqual(expect.any(String));

    const decoded = JSON.parse(
      Buffer.from(firstBody.next_cursor!, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    expect(Object.keys(decoded).sort()).toEqual([
      "action",
      "class_id",
      "created_at",
      "days",
      "id",
      "kind",
      "v",
    ]);
    expect(decoded).toMatchObject({
      action: null,
      class_id: fixture.classId,
      created_at: createdAt,
      days: 90,
      id: expect.stringMatching(/^[1-9][0-9]*$/u),
      kind: "audit_logs",
      v: 2,
    });

    const second = await getAuditLogs(
      fixture,
      `?cursor=${encodeURIComponent(firstBody.next_cursor!)}`,
    );
    expect(second.statusCode, second.body).toBe(200);
    expect(second.json<AuditLogResponse>()).toMatchObject({
      items: [{ target: { id: "1" } }],
      next_cursor: null,
    });
  });

  it("rejects cross-class, cross-filter, malformed, and structurally tampered cursors", async () => {
    const createdAt = await databaseAuditTimestamp();
    const other = await createClassFixture();
    for (let index = 1; index <= 21; index += 1) {
      await seedClassAudit(fixture, String(index), { createdAt });
      await seedClassAudit(other, String(index), { createdAt });
    }

    const first = await getAuditLogs(fixture);
    const cursor = first.json<AuditLogResponse>().next_cursor!;
    const otherFirst = await getAuditLogs(other);
    const otherCursor = otherFirst.json<AuditLogResponse>().next_cursor!;
    const structurallyTampered = Buffer.from(
      JSON.stringify({
        action: null,
        class_id: fixture.classId,
        created_at: createdAt,
        days: 90,
        extra: "tampered",
        id: "1",
        kind: "audit_logs",
        v: 2,
      }),
      "utf8",
    ).toString("base64url");

    for (const query of [
      "?cursor=not-a-cursor",
      `?cursor=${encodeURIComponent(otherCursor)}`,
      `?cursor=${encodeURIComponent(structurallyTampered)}`,
      `?days=30&cursor=${encodeURIComponent(cursor)}`,
      `?action=class.updated&days=90&cursor=${encodeURIComponent(cursor)}`,
    ]) {
      expectError(await getAuditLogs(fixture, query), 400, "INVALID_CURSOR");
    }
  });

  it("fails closed instead of exposing a corrupted action-target envelope", async () => {
    await database
      .insertInto("audit_logs")
      .values({
        action: "class.updated",
        actor_display_name_snapshot: "감사 교사",
        actor_member_id: fixture.teacher.memberId,
        actor_role_snapshot: "teacher",
        actor_user_id: fixture.teacher.userId,
        after_json: { class_id: fixture.classId, name: "손상 데이터" },
        before_json: { class_id: fixture.classId, name: "이전 데이터" },
        class_id: fixture.classId,
        reason: null,
        request_id: randomUUID(),
        target_id: "10",
        target_snapshot: null,
        target_type: "security_event",
      })
      .execute();

    const response = await getAuditLogs(fixture);
    expectError(response, 503, "INTERNAL_ERROR");
    expect(response.body).not.toContain("손상 데이터");
    expect(response.body).not.toContain("security_event");
  });

  /*
   * 종류 목록에는 있는데 봉투 매핑이 없으면 **그 행 하나가 목록 전체를 500 으로** 만든다.
   * 2026-08-22 감사(BLUE-03)에서 실제로 그랬다 — 교사가 선거나 당번을 한 번만 써도
   * 최신 감사 화면이 안 열렸다. 기존 시험들은 목록과 종류 **계약**만 비교해서 이걸
   * 못 잡았다. 실제로 조회되는 행을 만들어야 잡힌다.
   */
  it("keeps the list open for duty and election audit rows", async () => {
    const rows = [
      { action: "election.created", json: null, targetType: "election" },
      {
        action: "duty_roster.created",
        json: { assigned_student_count: 3, duty_roster_id: "7", role_count: 2, title: "이번 주" },
        targetType: "duty_roster",
      },
      {
        action: "duty_role.created",
        json: { duty_role_id: "5", name: "칠판 지우기", required_count: 1, sort_index: 1 },
        targetType: "duty_role",
      },
    ] as const;

    for (const [index, row] of rows.entries()) {
      await database
        .insertInto("audit_logs")
        .values({
          action: row.action,
          actor_display_name_snapshot: "감사 교사",
          actor_member_id: fixture.teacher.memberId,
          actor_role_snapshot: "teacher",
          actor_user_id: fixture.teacher.userId,
          after_json: row.json,
          before_json: null,
          class_id: fixture.classId,
          reason: null,
          request_id: randomUUID(),
          target_id: String(index + 1),
          target_snapshot: null,
          target_type: row.targetType,
        })
        .execute();

      const response = await getAuditLogs(fixture);
      expect(response.statusCode, `${row.action} 때문에 목록이 열리지 않았다`).toBe(200);
      expect(response.body).toContain(row.action);
    }

    /* 당번 감사에 담기는 값은 사람 수·제목·역할 이름뿐이다 — 이름·학생번호가 새면 안 된다. */
    const listed = await getAuditLogs(fixture);
    expect(listed.body).toContain("칠판 지우기");
    expect(listed.body).not.toContain("student_number");
  });
});

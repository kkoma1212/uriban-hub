import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";

import { AttendanceNotificationsCommandService } from "../src/attendance-notifications/attendance-notifications-command.service.js";
import type { AttendanceMutationItem } from "../src/attendance-notifications/attendance-notifications-command.types.js";
import {
  app,
  type ActorFixture,
  type ClassFixture,
  createClassFixture,
  database,
  publicOrigin,
  setupSuppliesHarness,
  teardownSuppliesHarness,
} from "./supplies-test-harness.js";

const VALID_BODY = { expected_time: "08:30", notification_type: "late" } as const;
const ITEM_KEYS = [
  "acknowledged_at",
  "expected_time",
  "id",
  "notification_type",
  "row_version",
  "status",
  "submitted_at",
  "updated_at",
];

let fixture: ClassFixture;

function expectError(
  response: { json(): { error: { code: string } }; statusCode: number },
  status: number,
  code: string,
): void {
  expect(response.statusCode).toBe(status);
  expect(response.json().error.code).toBe(code);
}

async function databaseToday(): Promise<string> {
  const row = await database
    .selectNoFrom(
      sql<string>`to_char(
        (clock_timestamp() AT TIME ZONE 'Asia/Seoul')::date,
        'YYYY-MM-DD'
      )`.as("server_today"),
    )
    .executeTakeFirstOrThrow();
  return row.server_today;
}

function mutationHeaders(
  actor: ActorFixture,
  serverToday: string,
  values: { idempotencyKey?: string; ifMatch?: string } = {},
): Record<string, string> {
  return {
    ...actor.headers,
    ...(values.idempotencyKey === undefined ? {} : { "idempotency-key": values.idempotencyKey }),
    ...(values.ifMatch === undefined ? {} : { "if-match": values.ifMatch }),
    "x-server-today": serverToday,
  };
}

async function createAttendance(
  actor: ActorFixture,
  serverToday: string,
  values: {
    body?: { expected_time: string | null; notification_type: "absent" | "early" | "late" };
    idempotencyKey?: string;
  } = {},
) {
  return app.inject({
    headers: mutationHeaders(actor, serverToday, {
      idempotencyKey: values.idempotencyKey ?? randomUUID(),
    }),
    method: "POST",
    payload: values.body ?? VALID_BODY,
    url: "/api/v1/attendance-notifications",
  });
}

async function seedAttendance(
  owner: ClassFixture,
  memberId: string,
  values: {
    date?: string;
    status?: "acknowledged" | "canceled" | "pending";
    type?: "absent" | "early" | "late";
  } = {},
) {
  const notificationDate = values.date ?? (await databaseToday());
  const status = values.status ?? "pending";
  const type = values.type ?? "late";
  return database
    .insertInto("attendance_notifications")
    .values({
      acknowledged_at: status === "acknowledged" ? sql<Date>`clock_timestamp()` : null,
      acknowledged_by_member_id: status === "acknowledged" ? owner.teacher.memberId : null,
      class_id: owner.classId,
      expected_time: type === "absent" ? null : "08:30:00",
      member_id: memberId,
      notification_date: sql<Date>`${notificationDate}::date`,
      notification_type: type,
      status,
    })
    .returning([
      "acknowledged_at",
      "expected_time",
      "id",
      "notification_type",
      "row_version",
      "status",
      "submitted_at",
      "updated_at",
    ])
    .executeTakeFirstOrThrow();
}

async function attendanceRow(id: string) {
  return database
    .selectFrom("attendance_notifications")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirstOrThrow();
}

async function attendanceAudits(id: string) {
  return database
    .selectFrom("audit_logs")
    .select(["action", "after_json", "before_json", "reason", "target_snapshot"])
    .where("target_type", "=", "attendance_notification")
    .where("target_id", "=", id)
    .orderBy("id", "asc")
    .execute();
}

async function withShiftedNodeClock<T>(
  offsetMilliseconds: number,
  action: () => Promise<T>,
): Promise<T> {
  const RealDate = globalThis.Date;
  const realNow = RealDate.now.bind(RealDate);
  const shiftedDate = new Proxy(RealDate, {
    construct(target, argumentsList) {
      return Reflect.construct(
        target,
        argumentsList.length === 0 ? [realNow() + offsetMilliseconds] : argumentsList,
      );
    },
    get(target, property, receiver) {
      if (property === "now") return (): number => realNow() + offsetMilliseconds;
      return Reflect.get(target, property, receiver);
    },
  });
  globalThis.Date = shiftedDate as DateConstructor;
  try {
    return await action();
  } finally {
    globalThis.Date = RealDate;
  }
}

beforeAll(setupSuppliesHarness, 120_000);

beforeEach(async () => {
  fixture = await createClassFixture();
});

afterAll(teardownSuppliesHarness, 120_000);

describe("attendance mutation HTTP contract", () => {
  it("enforces auth, CSRF, exact headers/body, roles, cross-class hiding, and suspension", async () => {
    const today = await databaseToday();
    expectError(
      await app.inject({
        headers: {
          "idempotency-key": randomUUID(),
          origin: publicOrigin,
          "x-csrf-token": "missing-session",
          "x-server-today": today,
        },
        method: "POST",
        payload: VALID_BODY,
        url: "/api/v1/attendance-notifications",
      }),
      401,
      "UNAUTHENTICATED",
    );

    const { "x-csrf-token": _csrf, ...withoutCsrf } = fixture.students[0].headers;
    expectError(
      await app.inject({
        headers: {
          ...withoutCsrf,
          "idempotency-key": randomUUID(),
          "x-server-today": today,
        },
        method: "POST",
        payload: VALID_BODY,
        url: "/api/v1/attendance-notifications",
      }),
      403,
      "CSRF_INVALID",
    );

    expectError(
      await app.inject({
        headers: {
          ...fixture.students[0].headers,
          "idempotency-key": randomUUID(),
        },
        method: "POST",
        payload: VALID_BODY,
        url: "/api/v1/attendance-notifications",
      }),
      400,
      "SERVER_TODAY_REQUIRED",
    );
    expectError(
      await app.inject({
        headers: mutationHeaders(fixture.students[0], today),
        method: "POST",
        payload: VALID_BODY,
        url: "/api/v1/attendance-notifications",
      }),
      400,
      "IDEMPOTENCY_KEY_REQUIRED",
    );
    expectError(
      await app.inject({
        headers: mutationHeaders(fixture.students[0], today, {
          idempotencyKey: "not-a-uuid",
        }),
        method: "POST",
        payload: VALID_BODY,
        url: "/api/v1/attendance-notifications",
      }),
      400,
      "INVALID_IDEMPOTENCY_KEY",
    );
    for (const invalidToday of ["0000-01-01", "2026-02-30", "2026-7-18", "2026-07-18T00:00:00Z"]) {
      expectError(
        await createAttendance(fixture.students[0], invalidToday),
        400,
        "INVALID_SERVER_TODAY",
      );
    }
    expectError(
      await createAttendance(fixture.students[0], "2000-01-01"),
      409,
      "ATTENDANCE_NOTIFICATION_DATE_CHANGED",
    );

    for (const body of [
      { expected_time: null, notification_type: "late" },
      { expected_time: "08:30", notification_type: "absent" },
      { expected_time: "08:30:00", notification_type: "early" },
      { expected_time: null, notification_type: "vacation" },
      { expected_time: null, notification_type: "absent", reason: "건강 문제" },
    ]) {
      const response = await app.inject({
        headers: mutationHeaders(fixture.students[0], today, { idempotencyKey: randomUUID() }),
        method: "POST",
        payload: body,
        url: "/api/v1/attendance-notifications",
      });
      expectError(response, 400, "VALIDATION_FAILED");
    }
    expectError(await createAttendance(fixture.teacher, today), 403, "ROLE_INSUFFICIENT");

    const ownRow = await seedAttendance(fixture, fixture.students[0].memberId!);
    expectError(
      await app.inject({
        headers: mutationHeaders(fixture.students[0], today, { ifMatch: '"1"' }),
        method: "POST",
        payload: { reason: "x" },
        url: `/api/v1/attendance-notifications/${ownRow.id}/cancel`,
      }),
      400,
      "VALIDATION_FAILED",
    );
    expectError(
      await app.inject({
        headers: mutationHeaders(fixture.teacher, today, { ifMatch: '"1"' }),
        method: "POST",
        payload: { reason: "x" },
        url: `/api/v1/attendance-notifications/${ownRow.id}/acknowledge`,
      }),
      400,
      "VALIDATION_FAILED",
    );

    await database
      .updateTable("users")
      .set({ email_verified_at: null })
      .where("id", "=", fixture.students[2].userId)
      .execute();
    expectError(await createAttendance(fixture.students[2], today), 403, "EMAIL_NOT_VERIFIED");
    await expect(
      app.get(AttendanceNotificationsCommandService).create({
        actorUserId: fixture.students[2].userId,
        expectedTime: "08:30",
        idempotencyKey: randomUUID(),
        notificationType: "late",
        requestId: randomUUID(),
        serverToday: today,
      }),
    ).rejects.toMatchObject({
      response: { code: "EMAIL_NOT_VERIFIED" },
      status: 403,
    });

    const other = await createClassFixture();
    const otherRow = await seedAttendance(other, other.students[0].memberId!);
    expectError(
      await app.inject({
        headers: mutationHeaders(fixture.students[0], today, { ifMatch: '"1"' }),
        method: "PATCH",
        payload: VALID_BODY,
        url: `/api/v1/attendance-notifications/${otherRow.id}`,
      }),
      404,
      "NOT_FOUND",
    );

    await database
      .updateTable("classes")
      .set({
        status: "suspended",
        suspended_at: sql<Date>`clock_timestamp()`,
        suspended_by_operator_id: fixture.operatorId,
        suspended_reason: "출결 mutation 정지 테스트",
      })
      .where("id", "=", fixture.classId)
      .execute();
    expectError(await createAttendance(fixture.students[0], today), 423, "CLASS_SUSPENDED");
  });

  it("creates and replays atomically, gives stale date precedence, and reuses only canceled rows with a new key", async () => {
    const today = await databaseToday();
    const firstKey = randomUUID();
    const first = await createAttendance(fixture.students[0], today, { idempotencyKey: firstKey });
    expect(first.statusCode).toBe(201);
    const firstBody = first.json() as AttendanceMutationItem;
    expect(Object.keys(firstBody).sort()).toEqual([...ITEM_KEYS].sort());
    expect(firstBody).toMatchObject({
      acknowledged_at: null,
      expected_time: "08:30",
      notification_type: "late",
      row_version: "1",
      status: "pending",
    });
    expect(first.headers.etag).toBe('"1"');

    const storedFirst = await attendanceRow(firstBody.id);
    expect(storedFirst.notification_date).toBeInstanceOf(Date);
    expect(storedFirst.submitted_at.toISOString()).toBe(firstBody.submitted_at);
    expect(storedFirst.updated_at.toISOString()).toBe(firstBody.updated_at);
    const createdAudit = await attendanceAudits(firstBody.id);
    expect(createdAudit).toHaveLength(1);
    expect(createdAudit[0]).toEqual({
      action: "attendance_notification.created",
      after_json: {
        attendance_notification_id: firstBody.id,
        notification_date: today,
        notification_type: "late",
        status: "pending",
      },
      before_json: null,
      reason: null,
      target_snapshot: null,
    });
    expect(JSON.stringify(createdAudit)).not.toContain("expected_time");

    const replay = await createAttendance(fixture.students[0], today, {
      idempotencyKey: firstKey,
    });
    expect(replay.statusCode).toBe(201);
    expect(replay.json()).toEqual(firstBody);
    expect(await attendanceAudits(firstBody.id)).toHaveLength(1);

    const changedBody = { expected_time: null, notification_type: "absent" } as const;
    expectError(
      await createAttendance(fixture.students[0], today, {
        body: changedBody,
        idempotencyKey: firstKey,
      }),
      409,
      "IDEMPOTENCY_KEY_REUSED",
    );
    for (const body of [VALID_BODY, changedBody]) {
      expectError(
        await createAttendance(fixture.students[0], "2000-01-01", {
          body,
          idempotencyKey: firstKey,
        }),
        409,
        "ATTENDANCE_NOTIFICATION_DATE_CHANGED",
      );
    }
    expectError(await createAttendance(fixture.students[0], today), 409, "CONFLICT");

    const concurrentKey = randomUUID();
    const concurrent = await Promise.all(
      Array.from({ length: 8 }, () =>
        createAttendance(fixture.students[1], today, { idempotencyKey: concurrentKey }),
      ),
    );
    expect(new Set(concurrent.map((response) => response.statusCode))).toEqual(new Set([201]));
    const concurrentBodies = concurrent.map((response) => response.json());
    for (const body of concurrentBodies) expect(body).toEqual(concurrentBodies[0]);
    const concurrentBody = concurrentBodies[0] as AttendanceMutationItem;
    expect(await attendanceAudits(concurrentBody.id)).toHaveLength(1);

    const canceled = await app.inject({
      headers: mutationHeaders(fixture.students[0], today, { ifMatch: '"1"' }),
      method: "POST",
      url: `/api/v1/attendance-notifications/${firstBody.id}/cancel`,
    });
    expect(canceled.statusCode).toBe(200);
    expect(canceled.json()).toMatchObject({
      id: firstBody.id,
      row_version: "2",
      status: "canceled",
    });

    const oldReplay = await createAttendance(fixture.students[0], today, {
      idempotencyKey: firstKey,
    });
    expect(oldReplay.statusCode).toBe(201);
    expect(oldReplay.json()).toEqual(firstBody);
    expect((await attendanceRow(firstBody.id)).status).toBe("canceled");

    const canceledSubmittedAt = (await attendanceRow(firstBody.id)).submitted_at;
    const resubmitKey = randomUUID();
    const resubmitted = await createAttendance(fixture.students[0], today, {
      body: { expected_time: "09:10", notification_type: "early" },
      idempotencyKey: resubmitKey,
    });
    expect(resubmitted.statusCode).toBe(200);
    const resubmittedBody = resubmitted.json() as AttendanceMutationItem;
    expect(resubmittedBody).toMatchObject({
      id: firstBody.id,
      notification_type: "early",
      row_version: "3",
      status: "pending",
    });
    expect(new Date(resubmittedBody.submitted_at).getTime()).toBeGreaterThan(
      canceledSubmittedAt.getTime(),
    );
    const resubmitReplay = await createAttendance(fixture.students[0], today, {
      body: { expected_time: "09:10", notification_type: "early" },
      idempotencyKey: resubmitKey,
    });
    expect(resubmitReplay.statusCode).toBe(200);
    expect(resubmitReplay.json()).toEqual(resubmittedBody);
    expect((await attendanceAudits(firstBody.id)).map((audit) => audit.action)).toEqual([
      "attendance_notification.created",
      "attendance_notification.canceled",
      "attendance_notification.created",
    ]);
  });

  it("preserves no-op invariants and serializes update/cancel on the same ETag", async () => {
    const today = await databaseToday();
    const created = await createAttendance(fixture.students[0], today);
    const initial = created.json() as AttendanceMutationItem;

    expectError(
      await app.inject({
        headers: mutationHeaders(fixture.students[0], today),
        method: "PATCH",
        payload: VALID_BODY,
        url: `/api/v1/attendance-notifications/${initial.id}`,
      }),
      428,
      "IF_MATCH_REQUIRED",
    );
    for (const ifMatch of ["1", 'W/"1"', "*"]) {
      expectError(
        await app.inject({
          headers: mutationHeaders(fixture.students[0], today, { ifMatch }),
          method: "PATCH",
          payload: VALID_BODY,
          url: `/api/v1/attendance-notifications/${initial.id}`,
        }),
        400,
        "INVALID_IF_MATCH",
      );
    }

    const noOp = await app.inject({
      headers: mutationHeaders(fixture.students[0], today, { ifMatch: '"1"' }),
      method: "PATCH",
      payload: VALID_BODY,
      url: `/api/v1/attendance-notifications/${initial.id}`,
    });
    expect(noOp.statusCode).toBe(200);
    expect(noOp.json()).toEqual(initial);
    expect(await attendanceAudits(initial.id)).toHaveLength(1);

    const changed = await app.inject({
      headers: mutationHeaders(fixture.students[0], today, { ifMatch: '"1"' }),
      method: "PATCH",
      payload: { expected_time: null, notification_type: "absent" },
      url: `/api/v1/attendance-notifications/${initial.id}`,
    });
    expect(changed.statusCode).toBe(200);
    const changedBody = changed.json() as AttendanceMutationItem;
    expect(changedBody).toMatchObject({
      expected_time: null,
      row_version: "2",
      status: "pending",
      submitted_at: initial.submitted_at,
    });
    expect(new Date(changedBody.updated_at).getTime()).toBeGreaterThan(
      new Date(initial.updated_at).getTime(),
    );
    const updateAudit = (await attendanceAudits(initial.id))[1]!;
    expect(updateAudit.action).toBe("attendance_notification.updated");
    expect(Object.keys(updateAudit.before_json as object).sort()).toEqual([
      "attendance_notification_id",
      "notification_date",
      "notification_type",
      "status",
    ]);
    expect(JSON.stringify(updateAudit)).not.toContain("expected_time");

    expectError(
      await app.inject({
        headers: mutationHeaders(fixture.students[0], today, { ifMatch: '"1"' }),
        method: "PATCH",
        payload: VALID_BODY,
        url: `/api/v1/attendance-notifications/${initial.id}`,
      }),
      409,
      "RESOURCE_VERSION_CHANGED",
    );

    const race = await Promise.all([
      app.inject({
        headers: mutationHeaders(fixture.students[0], today, { ifMatch: '"2"' }),
        method: "PATCH",
        payload: { expected_time: "08:45", notification_type: "late" },
        url: `/api/v1/attendance-notifications/${initial.id}`,
      }),
      app.inject({
        headers: mutationHeaders(fixture.students[0], today, { ifMatch: '"2"' }),
        method: "POST",
        url: `/api/v1/attendance-notifications/${initial.id}/cancel`,
      }),
    ]);
    expect(race.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    let current = await attendanceRow(initial.id);
    expect(current.row_version).toBe("3");

    if (current.status === "pending") {
      const cancel = await app.inject({
        headers: mutationHeaders(fixture.students[0], today, { ifMatch: '"3"' }),
        method: "POST",
        url: `/api/v1/attendance-notifications/${initial.id}/cancel`,
      });
      expect(cancel.statusCode).toBe(200);
      expect(cancel.json()).toMatchObject({ row_version: "4", status: "canceled" });
      current = await attendanceRow(initial.id);
    }
    expect(current.status).toBe("canceled");

    const getAfterCancel = await app.inject({
      headers: fixture.students[0].headers,
      method: "GET",
      url: "/api/v1/attendance-notifications/today",
    });
    expect(getAfterCancel.json()).toMatchObject({ notification: null, role: "student" });

    const oldRow = await seedAttendance(fixture, fixture.students[1].memberId!, {
      date: "2000-01-01",
    });
    expectError(
      await app.inject({
        headers: mutationHeaders(fixture.students[1], today, { ifMatch: '"1"' }),
        method: "POST",
        url: `/api/v1/attendance-notifications/${oldRow.id}/cancel`,
      }),
      409,
      "ATTENDANCE_NOTIFICATION_DATE_CHANGED",
    );
    expect((await attendanceRow(oldRow.id)).row_version).toBe("1");
  });

  it("acknowledges once, records the teacher atomically, and then blocks student mutation", async () => {
    const today = await databaseToday();
    const created = await createAttendance(fixture.students[0], today);
    const item = created.json() as AttendanceMutationItem;

    expectError(
      await app.inject({
        headers: mutationHeaders(fixture.students[0], today, { ifMatch: '"1"' }),
        method: "POST",
        url: `/api/v1/attendance-notifications/${item.id}/acknowledge`,
      }),
      403,
      "ROLE_INSUFFICIENT",
    );
    expectError(
      await app.inject({
        headers: mutationHeaders(fixture.teacher, today, { ifMatch: '"1"' }),
        method: "PATCH",
        payload: VALID_BODY,
        url: `/api/v1/attendance-notifications/${item.id}`,
      }),
      403,
      "ROLE_INSUFFICIENT",
    );
    expectError(
      await app.inject({
        headers: mutationHeaders(fixture.teacher, today, { ifMatch: '"1"' }),
        method: "POST",
        url: `/api/v1/attendance-notifications/${item.id}/cancel`,
      }),
      403,
      "ROLE_INSUFFICIENT",
    );
    expect(await attendanceRow(item.id)).toMatchObject({
      row_version: "1",
      status: "pending",
    });
    expect(await attendanceAudits(item.id)).toHaveLength(1);

    const race = await Promise.all(
      Array.from({ length: 2 }, () =>
        app.inject({
          headers: mutationHeaders(fixture.teacher, today, { ifMatch: '"1"' }),
          method: "POST",
          url: `/api/v1/attendance-notifications/${item.id}/acknowledge`,
        }),
      ),
    );
    expect(race.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    const success = race.find((response) => response.statusCode === 200)!;
    expect(success.json()).toMatchObject({
      acknowledged_at: expect.any(String),
      id: item.id,
      row_version: "2",
      status: "acknowledged",
      submitted_at: item.submitted_at,
    });
    const stored = await attendanceRow(item.id);
    expect(stored).toMatchObject({
      acknowledged_by_member_id: fixture.teacher.memberId,
      row_version: "2",
      status: "acknowledged",
    });
    expect(stored.acknowledged_at?.toISOString()).toBe(stored.updated_at.toISOString());

    const audit = (await attendanceAudits(item.id)).at(-1)!;
    expect(audit.action).toBe("attendance_notification.acknowledged");
    expect(JSON.stringify(audit)).not.toContain("expected_time");
    expect(audit.reason).toBeNull();

    for (const path of ["", "/cancel"]) {
      expectError(
        await app.inject({
          headers: mutationHeaders(fixture.students[0], today, { ifMatch: '"2"' }),
          method: path === "" ? "PATCH" : "POST",
          ...(path === "" ? { payload: VALID_BODY } : {}),
          url: `/api/v1/attendance-notifications/${item.id}${path}`,
        }),
        409,
        "ATTENDANCE_NOTIFICATION_ALREADY_ACKNOWLEDGED",
      );
    }
    expectError(
      await app.inject({
        headers: mutationHeaders(fixture.teacher, today, { ifMatch: '"2"' }),
        method: "POST",
        url: `/api/v1/attendance-notifications/${item.id}/acknowledge`,
      }),
      409,
      "CONFLICT",
    );

    const other = await createClassFixture();
    const otherRow = await seedAttendance(other, other.students[0].memberId!);
    expectError(
      await app.inject({
        headers: mutationHeaders(fixture.teacher, today, { ifMatch: '"1"' }),
        method: "POST",
        url: `/api/v1/attendance-notifications/${otherRow.id}/acknowledge`,
      }),
      404,
      "NOT_FOUND",
    );
  });

  it("lets the active teacher acknowledge inactive, left, removed, and deleted historical targets", async () => {
    const today = await databaseToday();
    const actors = [
      fixture.students[0],
      fixture.students[1],
      fixture.students[2],
      fixture.inactive,
    ];
    const rows = [];
    for (const actor of actors) rows.push(await seedAttendance(fixture, actor.memberId!));

    await database
      .updateTable("users")
      .set({ is_active: false })
      .where("id", "=", fixture.students[0].userId)
      .execute();
    await database
      .updateTable("class_members")
      .set({
        status: "left",
        status_changed_at: sql<Date>`clock_timestamp()`,
        student_number: null,
      })
      .where("id", "=", fixture.students[1].memberId!)
      .execute();
    await database
      .updateTable("class_members")
      .set({
        status: "removed",
        status_changed_at: sql<Date>`clock_timestamp()`,
        student_number: null,
      })
      .where("id", "=", fixture.students[2].memberId!)
      .execute();
    await database
      .updateTable("class_members")
      .set({
        display_name_in_class: null,
        status: "account_deleted",
        status_changed_at: sql<Date>`clock_timestamp()`,
        student_number: null,
      })
      .where("id", "=", fixture.inactive.memberId!)
      .execute();
    await database
      .updateTable("users")
      .set({
        anonymized_at: sql<Date>`clock_timestamp()`,
        deleted_at: sql<Date>`clock_timestamp()`,
        display_name: "탈퇴한 사용자",
        email_normalized: `deleted-attendance-${fixture.inactive.userId}@invalid.local`,
        is_active: false,
      })
      .where("id", "=", fixture.inactive.userId)
      .execute();

    for (const row of rows) {
      const response = await app.inject({
        headers: mutationHeaders(fixture.teacher, today, { ifMatch: '"1"' }),
        method: "POST",
        url: `/api/v1/attendance-notifications/${row.id}/acknowledge`,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ id: row.id, status: "acknowledged" });
    }
    expect(
      await database
        .selectFrom("attendance_notifications")
        .select((expression) => expression.fn.countAll<string>().as("count"))
        .where(
          "id",
          "in",
          rows.map((row) => row.id),
        )
        .where("status", "=", "acknowledged")
        .executeTakeFirstOrThrow(),
    ).toEqual({ count: "4" });
  });

  it("uses only DB clock values when the Node clock shifts by plus or minus 24 hours", async () => {
    const today = await databaseToday();
    const service = app.get(AttendanceNotificationsCommandService);
    for (const [index, offset] of [-24, 24].entries()) {
      const actor = fixture.students[index]!;
      const result = await withShiftedNodeClock(offset * 60 * 60 * 1000, () =>
        service.create({
          actorUserId: actor.userId,
          expectedTime: "08:30",
          idempotencyKey: randomUUID(),
          notificationType: "late",
          requestId: randomUUID(),
          serverToday: today,
        }),
      );
      expect(result.statusCode).toBe(201);
      expect(result.item.status).toBe("pending");
      const stored = await attendanceRow(result.item.id);
      expect(stored.submitted_at.toISOString()).toBe(result.item.submitted_at);
      expect(stored.updated_at.toISOString()).toBe(result.item.updated_at);
    }
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";

import { AttendanceNotificationsService } from "../src/attendance-notifications/attendance-notifications.service.js";
import type {
  AttendanceCounts,
  AttendanceNotificationStatus,
  AttendanceNotificationType,
  AttendanceStudentHistoryResult,
  AttendanceStudentTodayResult,
  AttendanceTeacherItem,
  AttendanceTeacherTodayResult,
} from "../src/attendance-notifications/attendance-notifications.types.js";
import { addCalendarDays } from "../src/common/date/kst-date.js";
import {
  app,
  type ClassFixture,
  createClassFixture,
  database,
  setupSuppliesHarness,
  teardownSuppliesHarness,
} from "./supplies-test-harness.js";

interface AddedStudent {
  memberId: string;
  userId: string;
}

interface SeedAttendanceOptions {
  expectedTime?: string | null;
  notificationDate?: string;
  status?: AttendanceNotificationStatus | "canceled";
  type: AttendanceNotificationType;
}

let fixture: ClassFixture;
let syntheticSequence = 0;

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

async function addStudent(
  owner: ClassFixture,
  values: {
    accountDisplayName: string;
    displayNameInClass: string | null;
    studentNumber: number | null;
  },
): Promise<AddedStudent> {
  const sequence = ++syntheticSequence;
  return database.transaction().execute(async (transaction) => {
    const user = await transaction
      .insertInto("users")
      .values({
        display_name: values.accountDisplayName,
        email_normalized: `attendance-${sequence}@example.com`,
        email_verified_at: sql<Date>`clock_timestamp()`,
        password_hash: "fixture-password-hash",
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    const member = await transaction
      .insertInto("class_members")
      .values({
        class_id: owner.classId,
        display_name_in_class: values.displayNameInClass,
        role: "student",
        status: "approved",
        student_number: values.studentNumber,
        user_id: user.id,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    return { memberId: member.id, userId: user.id };
  });
}

async function seedAttendance(
  owner: ClassFixture,
  memberId: string,
  values: SeedAttendanceOptions,
): Promise<{ id: string }> {
  const status = values.status ?? "pending";
  const acknowledged = status === "acknowledged";
  const notificationDate = values.notificationDate ?? (await databaseToday());
  return database
    .insertInto("attendance_notifications")
    .values({
      acknowledged_at: acknowledged ? sql<Date>`clock_timestamp()` : null,
      acknowledged_by_member_id: acknowledged ? owner.teacher.memberId : null,
      class_id: owner.classId,
      expected_time:
        values.expectedTime === undefined
          ? values.type === "absent"
            ? null
            : "08:30:00"
          : values.expectedTime,
      member_id: memberId,
      notification_date: sql<Date>`${notificationDate}::date`,
      notification_type: values.type,
      status,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
}

async function getTeacherToday(
  owner: ClassFixture,
  query = "",
): Promise<{
  body: AttendanceTeacherTodayResult;
  response: Awaited<ReturnType<typeof app.inject>>;
}> {
  const response = await app.inject({
    headers: owner.teacher.headers,
    method: "GET",
    url: `/api/v1/attendance-notifications/today${query}`,
  });
  return { body: response.json() as AttendanceTeacherTodayResult, response };
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

describe("GET /attendance-notifications/history", () => {
  it("returns only the signed-in student's non-canceled history and type counts", async () => {
    const today = await databaseToday();
    const yesterday = addCalendarDays(today, -1);
    const twoDaysAgo = addCalendarDays(today, -2);
    const from = addCalendarDays(today, -10);

    await seedAttendance(fixture, fixture.students[0].memberId!, {
      notificationDate: twoDaysAgo,
      status: "acknowledged",
      type: "early",
    });
    await seedAttendance(fixture, fixture.students[0].memberId!, {
      notificationDate: yesterday,
      type: "absent",
    });
    await seedAttendance(fixture, fixture.students[0].memberId!, {
      expectedTime: "08:45:00",
      notificationDate: today,
      type: "late",
    });
    await seedAttendance(fixture, fixture.students[1].memberId!, {
      notificationDate: today,
      type: "absent",
    });
    await seedAttendance(fixture, fixture.students[0].memberId!, {
      notificationDate: addCalendarDays(today, -3),
      status: "canceled",
      type: "late",
    });

    const response = await app.inject({
      headers: fixture.students[0].headers,
      method: "GET",
      url: `/api/v1/attendance-notifications/history?from=${from}&to=${today}`,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as AttendanceStudentHistoryResult;
    expect(body).toEqual({
      counts: { absent: 1, early: 1, late: 1, total: 3 },
      items: [
        {
          expected_time: "08:30",
          notification_date: twoDaysAgo,
          notification_type: "early",
          status: "acknowledged",
        },
        {
          expected_time: null,
          notification_date: yesterday,
          notification_type: "absent",
          status: "pending",
        },
        {
          expected_time: "08:45",
          notification_date: today,
          notification_type: "late",
          status: "pending",
        },
      ],
      range: { from, to: today },
      role: "student",
      server_today: today,
    });
    expect(JSON.stringify(body)).not.toContain("member_id");
    expect(JSON.stringify(body)).not.toContain('"id"');
  });

  it("rejects unauthenticated, teacher, outsider, future, and oversized access", async () => {
    const today = await databaseToday();
    const validQuery = `?from=${addCalendarDays(today, -30)}&to=${today}`;

    expectError(
      await app.inject({
        method: "GET",
        url: `/api/v1/attendance-notifications/history${validQuery}`,
      }),
      401,
      "UNAUTHENTICATED",
    );
    expectError(
      await app.inject({
        headers: fixture.teacher.headers,
        method: "GET",
        url: `/api/v1/attendance-notifications/history${validQuery}`,
      }),
      403,
      "ROLE_INSUFFICIENT",
    );
    expectError(
      await app.inject({
        headers: fixture.outsider.headers,
        method: "GET",
        url: `/api/v1/attendance-notifications/history${validQuery}`,
      }),
      404,
      "NOT_FOUND",
    );
    expectError(
      await app.inject({
        headers: fixture.students[0].headers,
        method: "GET",
        url: `/api/v1/attendance-notifications/history?from=${today}&to=${addCalendarDays(today, 1)}`,
      }),
      400,
      "VALIDATION_FAILED",
    );
    expectError(
      await app.inject({
        headers: fixture.students[0].headers,
        method: "GET",
        url: `/api/v1/attendance-notifications/history?from=${addCalendarDays(today, -366)}&to=${today}`,
      }),
      400,
      "VALIDATION_FAILED",
    );
  });

  it("uses the DB-authoritative KST date when validating history", async () => {
    const today = await databaseToday();
    const service = app.get(AttendanceNotificationsService);

    for (const offset of [-24 * 60 * 60 * 1000, 24 * 60 * 60 * 1000]) {
      const result = await withShiftedNodeClock(offset, () =>
        service.history({
          actorUserId: fixture.students[0].userId,
          from: addCalendarDays(today, -30),
          to: today,
        }),
      );
      expect(result).toMatchObject({ role: "student", server_today: today });
    }
  });
});

describe("GET /attendance-notifications/today", () => {
  it("hides all other-student data and enforces current class, teacher readiness, and suspension", async () => {
    const [teacherBootstrap, studentBootstrap] = await Promise.all([
      app.inject({
        headers: fixture.teacher.headers,
        method: "GET",
        url: "/api/v1/bootstrap",
      }),
      app.inject({
        headers: fixture.students[0].headers,
        method: "GET",
        url: "/api/v1/bootstrap",
      }),
    ]);
    expect(teacherBootstrap.statusCode).toBe(200);
    expect(studentBootstrap.statusCode).toBe(200);
    expect(teacherBootstrap.json().allowed_actions).toContain("MANAGE_ATTENDANCE_NOTIFICATIONS");
    expect(teacherBootstrap.json().allowed_actions).not.toContain(
      "MANAGE_OWN_ATTENDANCE_NOTIFICATION",
    );
    expect(studentBootstrap.json().allowed_actions).toContain("MANAGE_OWN_ATTENDANCE_NOTIFICATION");
    expect(studentBootstrap.json().allowed_actions).not.toContain(
      "MANAGE_ATTENDANCE_NOTIFICATIONS",
    );

    expectError(
      await app.inject({ method: "GET", url: "/api/v1/attendance-notifications/today" }),
      401,
      "UNAUTHENTICATED",
    );
    expectError(
      await app.inject({
        headers: fixture.outsider.headers,
        method: "GET",
        url: "/api/v1/attendance-notifications/today",
      }),
      404,
      "NOT_FOUND",
    );

    const own = await seedAttendance(fixture, fixture.students[0].memberId!, {
      expectedTime: "08:30:00",
      type: "late",
    });
    await seedAttendance(fixture, fixture.students[1].memberId!, {
      type: "absent",
    });
    const studentResponse = await app.inject({
      headers: fixture.students[0].headers,
      method: "GET",
      url: "/api/v1/attendance-notifications/today",
    });
    expect(studentResponse.statusCode).toBe(200);
    const studentBody = studentResponse.json() as AttendanceStudentTodayResult;
    expect(Object.keys(studentBody).sort()).toEqual(["notification", "role", "server_today"]);
    expect(studentBody).toMatchObject({
      notification: {
        expected_time: "08:30",
        id: own.id,
        notification_type: "late",
        row_version: "1",
        status: "pending",
      },
      role: "student",
    });
    expect(studentResponse.headers.etag).toBe('"1"');
    expect(Object.keys(studentBody.notification!).sort()).toEqual([
      "acknowledged_at",
      "expected_time",
      "id",
      "notification_type",
      "row_version",
      "status",
      "submitted_at",
      "updated_at",
    ]);
    const serialized = JSON.stringify(studentBody);
    expect(serialized).not.toContain("학생나");
    expect(serialized).not.toContain("items");
    expect(serialized).not.toContain("counts");

    await database
      .updateTable("attendance_notifications")
      .set({ status: "canceled" })
      .where("id", "=", own.id)
      .execute();
    const canceledResponse = await app.inject({
      headers: fixture.students[0].headers,
      method: "GET",
      url: "/api/v1/attendance-notifications/today",
    });
    expect(canceledResponse.statusCode).toBe(200);
    expect(canceledResponse.json()).toMatchObject({ notification: null, role: "student" });

    await database
      .updateTable("teacher_profiles")
      .set({
        temporary_password_expires_at: sql<Date>`clock_timestamp() + interval '1 day'`,
        temporary_password_must_change: true,
      })
      .where("user_id", "=", fixture.teacher.userId)
      .execute();
    expectError(
      await app.inject({
        headers: fixture.teacher.headers,
        method: "GET",
        url: "/api/v1/attendance-notifications/today",
      }),
      403,
      "ROLE_INSUFFICIENT",
    );
    await database
      .updateTable("teacher_profiles")
      .set({
        temporary_password_expires_at: null,
        temporary_password_must_change: false,
      })
      .where("user_id", "=", fixture.teacher.userId)
      .execute();

    await database
      .updateTable("classes")
      .set({
        status: "suspended",
        suspended_at: sql<Date>`clock_timestamp()`,
        suspended_by_operator_id: fixture.operatorId,
        suspended_reason: "출결 조회 정지 테스트",
      })
      .where("id", "=", fixture.classId)
      .execute();
    for (const actor of [fixture.teacher, fixture.students[0]]) {
      expectError(
        await app.inject({
          headers: actor.headers,
          method: "GET",
          url: "/api/v1/attendance-notifications/today",
        }),
        423,
        "CLASS_SUSPENDED",
      );
    }
  });

  it("keeps six all-row counts independent from filters and retains historical target rows safely", async () => {
    const late = await seedAttendance(fixture, fixture.students[0].memberId!, { type: "late" });
    await seedAttendance(fixture, fixture.students[1].memberId!, {
      status: "acknowledged",
      type: "absent",
    });
    await seedAttendance(fixture, fixture.students[2].memberId!, { type: "early" });
    const removedStudent = await addStudent(fixture, {
      accountDisplayName: "제거대상 학생",
      displayNameInClass: "제거된 학생",
      studentNumber: 9,
    });
    await seedAttendance(fixture, removedStudent.memberId, { type: "late" });
    await seedAttendance(fixture, fixture.inactive.memberId!, {
      status: "canceled",
      type: "absent",
    });
    await seedAttendance(fixture, fixture.teacher.memberId!, { type: "late" });

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
      .where("id", "=", removedStudent.memberId)
      .execute();
    await database
      .updateTable("class_members")
      .set({
        display_name_in_class: null,
        status: "account_deleted",
        status_changed_at: sql<Date>`clock_timestamp()`,
        student_number: null,
      })
      .where("id", "=", fixture.students[2].memberId!)
      .execute();
    await database
      .updateTable("users")
      .set({
        anonymized_at: sql<Date>`clock_timestamp()`,
        deleted_at: sql<Date>`clock_timestamp()`,
        display_name: "탈퇴한 사용자",
        email_normalized: `deleted-attendance-${fixture.students[2].userId}@invalid.local`,
        is_active: false,
      })
      .where("id", "=", fixture.students[2].userId)
      .execute();

    const expectedCounts: AttendanceCounts = {
      absent: 1,
      acknowledged: 1,
      early: 1,
      late: 2,
      pending: 3,
      total: 4,
    };
    const { body: all, response: allResponse } = await getTeacherToday(fixture);
    expect(allResponse.statusCode).toBe(200);
    expect(all.counts).toEqual(expectedCounts);
    expect(all.items).toHaveLength(4);

    const byMember = new Map(all.items.map((item) => [item.member_id, item]));
    expect(byMember.get(fixture.students[0].memberId!)).toMatchObject({
      account_state: "inactive",
      id: late.id,
      membership_state: "approved",
    });
    expect(byMember.get(fixture.students[1].memberId!)).toMatchObject({
      account_state: "active",
      membership_state: "left",
    });
    expect(byMember.get(removedStudent.memberId)).toMatchObject({
      account_state: "active",
      membership_state: "removed",
    });
    expect(byMember.get(fixture.students[2].memberId!)).toMatchObject({
      account_state: "deleted",
      display_name: "탈퇴한 사용자",
      membership_state: "account_deleted",
      student_number: null,
    });
    expect(JSON.stringify(all)).not.toContain("email");
    expect(JSON.stringify(all)).not.toContain("reason");
    expect(JSON.stringify(all)).not.toContain("학생다");

    const lateOnly = await getTeacherToday(fixture, "?type=late");
    expect(lateOnly.response.statusCode).toBe(200);
    expect(lateOnly.body.counts).toEqual(expectedCounts);
    expect(lateOnly.body.items.map((item) => item.notification_type)).toEqual(["late", "late"]);

    const acknowledgedOnly = await getTeacherToday(fixture, "?status=acknowledged");
    expect(acknowledgedOnly.response.statusCode).toBe(200);
    expect(acknowledgedOnly.body.counts).toEqual(expectedCounts);
    expect(acknowledgedOnly.body.items).toHaveLength(1);
    expect(acknowledgedOnly.body.items[0]!.status).toBe("acknowledged");

    const independentEmpty = await getTeacherToday(fixture, "?type=late&status=acknowledged");
    expect(independentEmpty.response.statusCode).toBe(200);
    expect(independentEmpty.body.counts).toEqual(expectedCounts);
    expect(independentEmpty.body.items).toEqual([]);
  });

  it("paginates the null-number/name/member tuple without gaps and binds cursors to class, date, and filters", async () => {
    const today = await databaseToday();
    const expectedMemberIds: string[] = [];
    for (let index = 0; index < 25; index += 1) {
      const suffix = String(index).padStart(2, "0");
      const student = await addStudent(fixture, {
        accountDisplayName: `정렬계정${suffix}`,
        displayNameInClass:
          index % 3 === 0 ? null : index % 4 === 0 ? "동명이인" : `정렬학생${suffix}`,
        studentNumber: index < 10 ? index + 10 : null,
      });
      expectedMemberIds.push(student.memberId);
      await seedAttendance(fixture, student.memberId, {
        type: index % 3 === 0 ? "late" : index % 3 === 1 ? "absent" : "early",
      });
    }

    const displayName = sql<string>`COALESCE(member.display_name_in_class, account.display_name)`;
    const databaseOrder = await database
      .selectFrom("attendance_notifications as notification")
      .innerJoin("class_members as member", "member.id", "notification.member_id")
      .innerJoin("users as account", "account.id", "member.user_id")
      .select("member.id")
      .where("notification.class_id", "=", fixture.classId)
      .where("notification.notification_date", "=", sql<Date>`${today}::date`)
      .where("notification.status", "!=", "canceled")
      .orderBy(sql`member.student_number ASC NULLS LAST`)
      .orderBy(displayName, "asc")
      .orderBy("member.id", "asc")
      .execute();
    expect(new Set(databaseOrder.map((row) => row.id))).toEqual(new Set(expectedMemberIds));

    const seen: AttendanceTeacherItem[] = [];
    const pageSizes: number[] = [];
    let cursor: string | null = null;
    let firstCursor: string | null = null;
    do {
      const page = await getTeacherToday(
        fixture,
        cursor === null ? "" : `?cursor=${encodeURIComponent(cursor)}`,
      );
      expect(page.response.statusCode).toBe(200);
      expect(page.body.counts.total).toBe(25);
      pageSizes.push(page.body.items.length);
      seen.push(...page.body.items);
      cursor = page.body.next_cursor;
      firstCursor ??= cursor;
    } while (cursor !== null);

    expect(pageSizes).toEqual([20, 5]);
    expect(seen.map((item) => item.member_id)).toEqual(databaseOrder.map((row) => row.id));
    expect(new Set(seen.map((item) => item.member_id)).size).toBe(25);
    expect(firstCursor).not.toBeNull();

    const changedType = await getTeacherToday(
      fixture,
      `?type=late&cursor=${encodeURIComponent(firstCursor!)}`,
    );
    expectError(changedType.response, 400, "INVALID_CURSOR");
    const changedStatus = await getTeacherToday(
      fixture,
      `?status=pending&cursor=${encodeURIComponent(firstCursor!)}`,
    );
    expectError(changedStatus.response, 400, "INVALID_CURSOR");

    const decoded = JSON.parse(Buffer.from(firstCursor!, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
    decoded.notification_date = "2000-01-01";
    const changedDateCursor = Buffer.from(JSON.stringify(decoded), "utf8").toString("base64url");
    const changedDate = await getTeacherToday(
      fixture,
      `?cursor=${encodeURIComponent(changedDateCursor)}`,
    );
    expectError(changedDate.response, 400, "INVALID_CURSOR");

    const otherClass = await createClassFixture();
    const changedClass = await getTeacherToday(
      otherClass,
      `?cursor=${encodeURIComponent(firstCursor!)}`,
    );
    expectError(changedClass.response, 400, "INVALID_CURSOR");
  });

  it("uses the DB-authoritative KST date even when the Node clock moves by plus or minus 24 hours", async () => {
    const row = await seedAttendance(fixture, fixture.students[0].memberId!, { type: "late" });
    const expectedToday = await databaseToday();
    const service = app.get(AttendanceNotificationsService);

    for (const offset of [-24 * 60 * 60 * 1000, 24 * 60 * 60 * 1000]) {
      const result = await withShiftedNodeClock(offset, () =>
        service.today({
          actorUserId: fixture.students[0].userId,
          status: "all",
          type: "all",
        }),
      );
      expect(result).toMatchObject({
        notification: { id: row.id },
        role: "student",
        server_today: expectedToday,
      });
    }
  });
});

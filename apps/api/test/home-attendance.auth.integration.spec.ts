import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "kysely";

import { DATABASE, type ClassHubDatabase } from "../src/database/database.module.js";
import { HomeUnavailableException } from "../src/home/home.errors.js";
import { HomeService } from "../src/home/home.service.js";
import type { AttendanceNotificationItem } from "../src/attendance-notifications/attendance-notifications.types.js";
import {
  app,
  type ActorFixture,
  type ClassFixture,
  createClassFixture,
  database,
  setupSuppliesHarness,
  teardownSuppliesHarness,
} from "./supplies-test-harness.js";

const ATTENDANCE_ITEM_KEYS = [
  "acknowledged_at",
  "expected_time",
  "id",
  "notification_type",
  "row_version",
  "status",
  "submitted_at",
  "updated_at",
];
const COUNT_KEYS = ["absent", "acknowledged", "early", "late", "pending", "total"];
const ZERO_COUNTS = { absent: 0, acknowledged: 0, early: 0, late: 0, pending: 0, total: 0 };

let fixture: ClassFixture;
let applicationDatabase: ClassHubDatabase;

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

async function seedAttendance(
  owner: ClassFixture,
  memberId: string,
  values: {
    date?: string;
    status?: "acknowledged" | "canceled" | "pending";
    type?: "absent" | "early" | "late";
  } = {},
) {
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
      notification_date: sql<Date>`${values.date ?? (await databaseToday())}::date`,
      notification_type: type,
      status,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
}

async function getHome(actor: ActorFixture) {
  return app.inject({
    headers: actor.headers,
    method: "GET",
    url: "/api/v1/home",
  });
}

function databaseProxy(
  onSelect: (table: unknown) => void,
  onSelectNoFrom: () => void = () => undefined,
): ClassHubDatabase {
  return new Proxy(applicationDatabase, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (property === "selectFrom" && typeof value === "function") {
        return (...arguments_: unknown[]) => {
          onSelect(arguments_[0]);
          return Reflect.apply(value, target, arguments_);
        };
      }
      if (property === "selectNoFrom" && typeof value === "function") {
        return (...arguments_: unknown[]) => {
          onSelectNoFrom();
          return Reflect.apply(value, target, arguments_);
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as ClassHubDatabase;
}

async function withShiftedNodeClock<T>(offsetMilliseconds: number, action: () => Promise<T>) {
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

beforeAll(async () => {
  await setupSuppliesHarness();
  applicationDatabase = app.get<ClassHubDatabase>(DATABASE);
}, 120_000);

beforeEach(async () => {
  fixture = await createClassFixture();
});

afterAll(teardownSuppliesHarness, 120_000);

describe("Home attendance snapshot", () => {
  it("returns only the student's own non-canceled item and otherwise returns null", async () => {
    const today = await databaseToday();
    const own = await seedAttendance(fixture, fixture.students[0].memberId!, { type: "late" });
    await seedAttendance(fixture, fixture.students[1].memberId!, { type: "absent" });

    const ownResponse = await getHome(fixture.students[0]);
    expect(ownResponse.statusCode).toBe(200);
    const ownHome = ownResponse.json();
    expect(ownHome.server_today).toBe(today);
    expect(ownHome.attendance.status).toBe("ok");
    expect(Object.keys(ownHome.attendance.data).sort()).toEqual([...ATTENDANCE_ITEM_KEYS].sort());
    expect(ownHome.attendance.data).toMatchObject({
      expected_time: "08:30",
      id: own.id,
      notification_type: "late",
      status: "pending",
    });
    expect(ownHome.attendance.data).not.toHaveProperty("member_id");
    expect(ownHome.attendance.data).not.toHaveProperty("display_name");
    expect(ownHome.attendance.data).not.toHaveProperty("counts");
    expect(ownHome.attendance.data).not.toHaveProperty("items");

    const otherResponse = await getHome(fixture.students[2]);
    expect(otherResponse.json().attendance).toEqual({ data: null, status: "empty" });

    await database
      .updateTable("attendance_notifications")
      .set({ status: "canceled" })
      .where("id", "=", own.id)
      .execute();
    const canceledResponse = await getHome(fixture.students[0]);
    expect(canceledResponse.json().attendance).toEqual({ data: null, status: "empty" });
  });

  it("returns teacher-only six counts including historical targets and excluding canceled rows", async () => {
    const otherClass = await createClassFixture();
    await seedAttendance(otherClass, otherClass.students[0].memberId!, { type: "late" });
    await seedAttendance(fixture, fixture.students[0].memberId!, { type: "late" });
    await seedAttendance(fixture, fixture.students[1].memberId!, {
      status: "acknowledged",
      type: "absent",
    });
    await seedAttendance(fixture, fixture.students[2].memberId!, {
      status: "canceled",
      type: "early",
    });
    await seedAttendance(fixture, fixture.inactive.memberId!, { type: "early" });

    await database
      .updateTable("users")
      .set({ is_active: false })
      .where("id", "=", fixture.students[0].userId)
      .execute();
    await database
      .updateTable("class_members")
      .set({ status: "left", student_number: null })
      .where("id", "=", fixture.students[0].memberId!)
      .execute();
    await database
      .updateTable("class_members")
      .set({ status: "removed", student_number: null })
      .where("id", "=", fixture.students[1].memberId!)
      .execute();

    const teacherResponse = await getHome(fixture.teacher);
    expect(teacherResponse.statusCode).toBe(200);
    const attendance = teacherResponse.json().attendance;
    expect(attendance.status).toBe("ok");
    expect(Object.keys(attendance.data).sort()).toEqual([...COUNT_KEYS].sort());
    expect(attendance.data).toEqual({
      absent: 1,
      acknowledged: 1,
      early: 1,
      late: 1,
      pending: 2,
      total: 3,
    });

    const emptyClass = await createClassFixture();
    const emptyResponse = await getHome(emptyClass.teacher);
    expect(emptyResponse.json().attendance).toEqual({ data: ZERO_COUNTS, status: "empty" });
  });

  it("keeps attendance failure role-safe, preserves partial success, and enforces query budgets", async () => {
    const failingAttendanceDatabase = databaseProxy((table) => {
      if (table === "attendance_notifications as notification") {
        throw new Error("simulated attendance query failure");
      }
    });
    const failingService = new HomeService(failingAttendanceDatabase, true);

    const studentPartial = await failingService.getForUser(fixture.students[0].userId);
    expect(studentPartial.attendance).toEqual({
      data: null,
      error_code: "ATTENDANCE_QUERY_FAILED",
      message: "출결 연락을 불러오지 못했어요.",
      status: "error",
    });
    expect(studentPartial.meal.status).toBe("empty");

    const teacherPartial = await failingService.getForUser(fixture.teacher.userId);
    expect(teacherPartial.attendance).toEqual({
      data: ZERO_COUNTS,
      error_code: "ATTENDANCE_QUERY_FAILED",
      message: "출결 현황을 불러오지 못했어요.",
      status: "error",
    });

    const allFailingDatabase = databaseProxy((table) => {
      if (
        [
          "attendance_notifications as notification",
          "meals",
          "notices as notice",
          "schedules as schedule",
          "supplies as supply",
        ].includes(String(table))
      ) {
        throw new Error("simulated Home card failure");
      }
    });
    await expect(
      new HomeService(allFailingDatabase, true).getForUser(fixture.students[0].userId),
    ).rejects.toBeInstanceOf(HomeUnavailableException);

    let studentQueries = 0;
    const countedStudent = new HomeService(
      databaseProxy(
        () => {
          studentQueries += 1;
        },
        () => {
          studentQueries += 1;
        },
      ),
      true,
    );
    await countedStudent.getForUser(fixture.students[0].userId);
    expect(studentQueries).toBe(9);

    let teacherQueries = 0;
    const countedTeacher = new HomeService(
      databaseProxy(
        () => {
          teacherQueries += 1;
        },
        () => {
          teacherQueries += 1;
        },
      ),
      true,
    );
    await countedTeacher.getForUser(fixture.teacher.userId);
    expect(teacherQueries).toBe(11);
  });

  it("omits attendance and never queries its table when the runtime feature is disabled", async () => {
    const selectedTables: string[] = [];
    const disabledService = new HomeService(
      databaseProxy((table) => {
        selectedTables.push(String(table));
      }),
      false,
    );

    const studentHome = await disabledService.getForUser(fixture.students[0].userId);
    const teacherHome = await disabledService.getForUser(fixture.teacher.userId);

    expect(studentHome).not.toHaveProperty("attendance");
    expect(teacherHome).not.toHaveProperty("attendance");
    expect(selectedTables).not.toContain("attendance_notifications as notification");
  });

  it("uses one DB KST day for server_today and attendance even when Node time shifts", async () => {
    const today = await databaseToday();
    await seedAttendance(fixture, fixture.students[0].memberId!, { date: today, type: "early" });
    const service = app.get(HomeService);

    for (const offsetHours of [-24, 24]) {
      const result = await withShiftedNodeClock(offsetHours * 60 * 60 * 1000, () =>
        service.getForUser(fixture.students[0].userId),
      );
      expect(result.server_today).toBe(today);
      expect(result.attendance?.status).toBe("ok");
      expect((result.attendance?.data as AttendanceNotificationItem).notification_type).toBe(
        "early",
      );
    }
  });
});

import type { DB } from "@classhub/db";
import { ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  DummyDriver,
  Kysely,
  MysqlAdapter,
  MysqlIntrospector,
  MysqlQueryCompiler,
  PostgresAdapter,
  PostgresQueryCompiler,
  type CompiledQuery,
} from "kysely";
import { describe, expect, it, vi } from "vitest";

import { UnauthenticatedException } from "../auth/auth.errors.js";
import { readDatabaseKstToday } from "../common/date/database-kst-clock.js";
import type { AppEnvironment } from "../config/environment.js";
import { BootstrapService } from "./bootstrap.service.js";

const userId = "9007199254740993";
const classId = "9007199254740995";
const memberId = "9007199254740997";
const approvedAt = "2026-09-01 00:00:00.000001";

function state(overrides: Record<string, unknown> = {}) {
  return {
    class_id: classId,
    class_name: "2학년 우리 반",
    class_status: "active",
    school_homepage_url: null,
    school_phone_number: "02-123-4567",
    school_road_address: "서울 시험로",
    school_road_address_detail: "101번지",
    school_name: "합성중학교",
    membership_class_id: classId,
    membership_display_name_in_class: "교사",
    membership_id: memberId,
    membership_role: "teacher",
    membership_student_number: null,
    membership_status: "approved",
    teacher_status: "active",
    temporary_password_must_change: 0,
    deleted_at: null,
    display_name: "합성 교사",
    email_normalized: "synthetic.teacher@example.invalid",
    email_verified_at: null,
    is_active: 1,
    signup_approved_at: approvedAt,
    ...overrides,
  };
}

function boundary(engine: "postgres" | "mariadb", row = state()) {
  const database = new Kysely<DB>({
    dialect: {
      createDriver: () => new DummyDriver(),
      createAdapter: () => (engine === "mariadb" ? new MysqlAdapter() : new PostgresAdapter()),
      createIntrospector: (db) => new MysqlIntrospector(db),
      createQueryCompiler: () =>
        engine === "mariadb" ? new MysqlQueryCompiler() : new PostgresQueryCompiler(),
    },
  });
  const rows: Record<string, unknown>[][] = [
    [{ server_today: "2026-09-08" }],
    [row],
    [{ id: "9007199254740999", status: "removed" }],
    [{ reason: "반 운영 종료" }],
  ];
  const queries: CompiledQuery[] = [];
  vi.spyOn(database.getExecutor(), "executeQuery").mockImplementation(async (query) => {
    queries.push(query);
    const next = rows.shift();
    if (next === undefined) throw new Error("Unexpected bootstrap query");
    return { rows: next };
  });
  const config = new ConfigService({
    DATABASE_ENGINE: engine,
    DUTY_ROSTERS_ENABLED: true,
  }) as ConfigService<AppEnvironment, true>;
  return { database, row, rows, queries, service: new BootstrapService(database, config) };
}

describe("BootstrapService database dialect boundary", () => {
  it("returns the same public policy and JSON booleans for Maria rows as for PG rows", async () => {
    const maria = boundary("mariadb");
    const postgres = boundary(
      "postgres",
      state({
        is_active: true,
        temporary_password_must_change: false,
        signup_approved_at: new Date("2026-09-01T00:00:00.000Z"),
      }),
    );
    const result = await maria.service.getForUser(userId);
    await expect(postgres.service.getForUser(userId)).resolves.toEqual(result);
    expect(result.account.is_active).toBe(true);
    // 본인에게도 전체 주소는 보내지 않는다(첫 사용 점검 18: 번호를 보낸 곳 안내).
    expect(result.account.email_masked).toBe("sy***@example.invalid");
    expect(JSON.stringify(result)).not.toContain("synthetic.teacher");
    expect(result.teacher_profile?.temporary_password_must_change).toBe(false);
    expect(result.destination).toBe("HOME");
    expect(result.allowed_actions).not.toContain("MANAGE_DUTY_ROSTERS");
    expect(result.current_class?.id).toBe(classId);
    expect(result.current_membership?.id).toBe(memberId);
    expect(result.last_status_reason).toBe("반 운영 종료");
    expect(result.server_today).toBe("2026-09-08");
    expect(maria.row.is_active).toBe(1);
    expect(maria.queries[1]?.sql).not.toContain(userId);
    expect(maria.queries[1]?.parameters).toContain(userId);
    expect(maria.queries[3]?.parameters).toEqual(["9007199254740999", "removed"]);
    expect(maria.rows).toHaveLength(0);
  });

  it("uses the fixed-offset MariaDB clock without PG casts or host timezone data", async () => {
    const probe = boundary("mariadb");
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2200-01-01T00:00:00Z"));
      const result = await probe.service.getForUser(userId);
      expect(result.server_today).toBe("2026-09-08");
      expect(probe.queries[0]?.sql).toContain(
        "DATE_FORMAT(UTC_TIMESTAMP(6) + INTERVAL 9 HOUR, '%Y-%m-%d')",
      );
      expect(probe.queries[0]?.parameters).toEqual([]);
      expect(
        probe.queries.some(({ sql }) => /to_char|clock_timestamp|::date|AT TIME ZONE/iu.test(sql)),
      ).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves the shared clock helper's PG default for all unchanged callers", async () => {
    const probe = boundary("postgres");
    await expect(readDatabaseKstToday(probe.database)).resolves.toBe("2026-09-08");
    expect(probe.queries[0]?.sql).toContain("clock_timestamp() AT TIME ZONE 'Asia/Seoul'");
    expect(probe.queries[0]?.sql).toContain("::date");
    expect(probe.queries[0]?.sql).not.toContain("UTC_TIMESTAMP");
  });

  it("requires the temporary password change when the Maria flag is numeric one", async () => {
    const probe = boundary("mariadb", state({ temporary_password_must_change: 1 }));
    const result = await probe.service.getForUser(userId);
    expect(result.destination).toBe("CHANGE_TEMPORARY_PASSWORD");
    expect(result.allowed_actions).toEqual(["CHANGE_PASSWORD", "LOGOUT"]);
    expect(result.teacher_profile?.temporary_password_must_change).toBe(true);
  });

  it("keeps student signup approval and a missing teacher profile valid", async () => {
    const probe = boundary(
      "mariadb",
      state({
        teacher_status: null,
        temporary_password_must_change: null,
        membership_role: "student",
        membership_student_number: 7,
      }),
    );
    const result = await probe.service.getForUser(userId);
    expect(result.destination).toBe("HOME");
    expect(result.teacher_profile).toBeNull();
    expect(result.allowed_actions).toContain("LEAVE_CLASS");
  });

  it("rejects a numeric inactive account before membership history is read", async () => {
    const probe = boundary("mariadb", state({ is_active: 0 }));
    await expect(probe.service.getForUser(userId)).rejects.toBeInstanceOf(UnauthenticatedException);
    expect(probe.queries).toHaveLength(2);
  });

  it.each([
    { is_active: "0" },
    { is_active: null },
    { temporary_password_must_change: "1" },
    { temporary_password_must_change: true },
  ])("fails closed for malformed boolean rows: %j", async (overrides) => {
    const probe = boundary("mariadb", state(overrides));
    await expect(probe.service.getForUser(userId)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(probe.queries).toHaveLength(2);
  });
});

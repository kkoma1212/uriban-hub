import type { DB } from "@classhub/db";
import {
  DummyDriver,
  Kysely,
  MysqlAdapter,
  MysqlIntrospector,
  MysqlQueryCompiler,
  type DatabaseConnection,
  type QueryResult,
} from "kysely";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ValidationPipe } from "@nestjs/common";
import { loadEnvironment } from "../config/environment.js";
import { StudentAssessmentBinding } from "./student-assessments-binding.js";
import {
  StudentAssessmentCreateDto,
  StudentAssessmentWriteDto,
} from "./student-assessments.dto.js";

const opened: Kysely<DB>[] = [];
function harness(results: (Record<string, unknown>[] | Error)[]) {
  const queries: string[] = [];
  class Driver extends DummyDriver {
    override async acquireConnection(): Promise<DatabaseConnection> {
      return {
        executeQuery: async <R>(query: { sql: string }): Promise<QueryResult<R>> => {
          queries.push(query.sql);
          const result = results.shift();
          if (result instanceof Error) throw result;
          if (result === undefined) throw new Error("Unexpected query");
          return { rows: result as R[] };
        },
        streamQuery: async function* <R>(): AsyncIterableIterator<QueryResult<R>> {
          throw new Error("unused");
        },
      };
    }
  }
  const database = new Kysely<DB>({
    dialect: {
      createDriver: () => new Driver(),
      createAdapter: () => new MysqlAdapter(),
      createIntrospector: (db) => new MysqlIntrospector(db),
      createQueryCompiler: () => new MysqlQueryCompiler(),
    },
  });
  opened.push(database);
  return { database, queries, binding: new StudentAssessmentBinding(database, true) };
}
afterEach(async () => {
  vi.useRealTimers();
  for (const db of opened.splice(0)) await db.destroy();
});

describe("assessment class binding contract", () => {
  it("shares concurrent missing-schema probes and refreshes at the exact five-second boundary", async () => {
    vi.useFakeTimers();
    const h = harness([Object.assign(new Error("absent"), { code: "ER_BAD_FIELD_ERROR" }), [], []]);
    expect(
      await Promise.all([h.binding.readable(), h.binding.readable(), h.binding.readable()]),
    ).toEqual([false, false, false]);
    expect(h.queries).toHaveLength(1);
    vi.advanceTimersByTime(4999);
    expect(await h.binding.readable()).toBe(false);
    expect(h.queries).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(await h.binding.readable()).toBe(true);
    expect(h.queries).toHaveLength(3);
  });
  it("propagates batch permission failure after a positive schema probe instead of returning baseline rows", async () => {
    const denied = Object.assign(new Error("synthetic denied"), {
      code: "ER_TABLEACCESS_DENIED_ERROR",
    });
    const h = harness([[], [], denied]);
    expect(await h.binding.readable()).toBe(true);
    await expect(h.binding.records(h.database, "22", ["33", "44"])).rejects.toBe(denied);
    expect(h.queries.at(-1)).toContain("a.owner_user_id=?");
  });
  it("defaults new registration off and keeps the assessment feature and fixture gates", () => {
    const fixture = {
      NODE_ENV: "test",
      PUBLIC_APP_ORIGIN: "https://classhub.test",
      PUBLIC_API_ORIGIN: "https://classhub.test",
      DATABASE_URL: "postgresql://classhub_app:synthetic@127.0.0.1:5432/classhub_test",
      EMAIL_HMAC_KEY: "synthetic-fixture-key-at-least-32-bytes",
    };
    expect(loadEnvironment(fixture).STUDENT_ASSESSMENT_CLASS_BINDING_ENABLED).toBe(false);
    expect(() =>
      loadEnvironment({ ...fixture, STUDENT_ASSESSMENT_CLASS_BINDING_ENABLED: "true" }),
    ).toThrow();
    expect(
      loadEnvironment({
        ...fixture,
        STUDENT_ASSESSMENTS_ENABLED: "true",
        STUDENT_ASSESSMENT_CLASS_BINDING_ENABLED: "true",
      }).STUDENT_ASSESSMENT_CLASS_BINDING_ENABLED,
    ).toBe(true);
    expect(() =>
      loadEnvironment({
        NODE_ENV: "development",
        STUDENT_ASSESSMENTS_ENABLED: "true",
        STUDENT_ASSESSMENT_CLASS_BINDING_ENABLED: "true",
      }),
    ).toThrow();
  });
  it("reprobes an absent candidate after the short negative cache", async () => {
    vi.useFakeTimers();
    const h = harness([Object.assign(new Error("absent"), { code: "ER_BAD_FIELD_ERROR" }), [], []]);
    expect(await h.binding.readable()).toBe(false);
    expect(await h.binding.readable()).toBe(false);
    expect(h.queries).toHaveLength(1);
    vi.advanceTimersByTime(5001);
    expect(await h.binding.readable()).toBe(true);
    expect(h.queries).toHaveLength(3);
  });
  it.each(["ER_TABLEACCESS_DENIED_ERROR", "ECONNRESET"])(
    "fails closed and retries %s",
    async (code) => {
      const h = harness([Object.assign(new Error("failed"), { code }), [], []]);
      await expect(h.binding.readable()).rejects.toMatchObject({ status: 503 });
      expect(await h.binding.readable()).toBe(true);
    },
  );
  it("does not treat missing retention metadata as an uninstalled personal-only schema", async () => {
    const h = harness([
      [],
      Object.assign(new Error("partial schema"), { code: "ER_BAD_FIELD_ERROR" }),
    ]);
    await expect(h.binding.readable()).rejects.toMatchObject({ status: 503 });
    expect(h.queries).toHaveLength(2);
  });
  it("reads the actual binding and earlier class expiry independently of registration", async () => {
    const h = harness([
      [],
      [],
      [
        {
          id: "33",
          class_id: "11",
          class_name: "현재 반",
          effective_expires_at: "2026-10-10 00:00:00.000001",
          alive: 0,
        },
      ],
    ]);
    expect(await h.binding.readable()).toBe(true);
    const row = await h.binding.record(h.database, "22", "33");
    expect(row.class_id).toBe("11");
    expect(row.alive).toBe(false);
    expect(row.effective_expires_at.toISOString()).toBe("2026-10-10T00:00:00.000Z");
    expect(h.queries[2]).toContain("LEAST(a.expires_at");
    expect(h.queries[2]).toContain("a.owner_user_id=?");
  });
  it("locks and validates the session class and its approved student membership", async () => {
    const h = harness([[{ id: "11", name: "현재 반" }], [{ id: "44" }]]);
    expect(await h.binding.currentClass(h.database, "22", "11", true)).toEqual({
      id: "11",
      name: "현재 반",
    });
    expect(h.queries.every((q) => q.includes("for update"))).toBe(true);
    expect(h.queries[0]).toContain("`status` = ?");
    expect(h.queries[1]).toContain("`role` = ? and `status` = ?");
  });
  it("accepts scope only at creation and rejects arbitrary class IDs", async () => {
    const pipe = new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
    });
    const create = (value: unknown) =>
      pipe.transform(value, { metatype: StudentAssessmentCreateDto, type: "body" });
    await expect(create({ connection_scope: "current_class" })).resolves.toMatchObject({
      connection_scope: "current_class",
    });
    await expect(create({ connection_scope: null })).rejects.toThrow();
    await expect(create({ class_id: "11" })).rejects.toThrow();
    await expect(
      pipe.transform(
        { connection_scope: "personal" },
        { metatype: StudentAssessmentWriteDto, type: "body" },
      ),
    ).rejects.toThrow();
  });
});

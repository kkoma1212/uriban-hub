import {
  createIdempotencyRequestHash,
  createIdempotencyRouteKey,
  MariaDbIdempotencyService,
  type DB,
} from "@classhub/db";
import type { Kysely } from "kysely";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CreateClassCommand } from "../classes.types.js";
import { classTimestampIso, createClassMariaDb } from "./create-class.js";

const input = (): CreateClassCommand => ({
  actorUserId: "9223372036854775807",
  academicYear: 2026,
  eduOfficeCode: "B10",
  schoolCode: "1234567",
  expectedStudentCount: 30,
  grade: 2,
  name: "우리 반",
  requestId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  idempotencyKey: "ABCDEFAB-1234-5678-9ABC-DEF012345678",
});
// This stub deliberately never executes the business callback. These tests cover
// pre-transaction input/canonicalization and pure time conversion; real DB QA
// owns the routine, result joins, audit and rollback proofs.
function boundary() {
  const execute = vi.spyOn(MariaDbIdempotencyService.prototype, "execute").mockResolvedValue({
    body: { replay: true },
    statusCode: 201,
    replayed: true,
  });
  const database = {} as Kysely<DB>;
  return { execute, database };
}
afterEach(() => vi.restoreAllMocks());

describe("MariaDB class creation command validation", () => {
  it.each([
    { actorUserId: "0" },
    { actorUserId: "01" },
    { actorUserId: "9223372036854775808" },
    { academicYear: 2019 },
    { academicYear: 2101 },
    { academicYear: 2026.5 },
    { expectedStudentCount: 0 },
    { expectedStudentCount: 61 },
    { expectedStudentCount: Number.NaN },
    { grade: 0 },
    { grade: 7 },
    { grade: 1.5 },
    { eduOfficeCode: "b10" },
    { eduOfficeCode: "B1" },
    { eduOfficeCode: "B100" },
    { schoolCode: "123456" },
    { schoolCode: "12345678" },
    { schoolCode: "ABCDEFG" },
    { name: "  " },
    { name: "😀".repeat(41) },
    { name: "반\u0000이름" },
    { name: "<b>반</b>" },
    { name: "반\n이름" },
    { name: "반\uD800" },
    { requestId: "not-a-uuid" },
  ])("rejects invalid DTO/identity boundary before idempotency: %o", async (change) => {
    const { execute, database } = boundary();
    await expect(createClassMariaDb(database, { ...input(), ...change })).rejects.toMatchObject({
      status: 400,
      response: { code: "VALIDATION_FAILED" },
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    { actorUserId: "1", academicYear: 2020, expectedStudentCount: 1, grade: 1, name: "가" },
    { academicYear: 2100, expectedStudentCount: 60, grade: 6, name: "😀".repeat(40) },
  ])(
    "accepts DTO endpoints while leaving school eligibility to the routine: %o",
    async (change) => {
      const { execute, database } = boundary();
      await createClassMariaDb(database, { ...input(), ...change });
      expect(execute).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    [undefined, "IDEMPOTENCY_KEY_REQUIRED"],
    ["wrong", "INVALID_IDEMPOTENCY_KEY"],
    [["aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"], "INVALID_IDEMPOTENCY_KEY"],
  ] as const)("preserves missing/malformed idempotency header %o", async (key, code) => {
    const { execute, database } = boundary();
    await expect(
      createClassMariaDb(database, {
        ...input(),
        idempotencyKey: key as string | string[] | undefined,
      }),
    ).rejects.toMatchObject({ status: 400, response: { code } });
    expect(execute).not.toHaveBeenCalled();
  });

  it("uses the existing create route and validated canonical body, excluding request ID", async () => {
    const { execute, database } = boundary();
    const command = { ...input(), name: "  우리  반  " };
    await createClassMariaDb(database, command);
    const expected = {
      actorUserId: command.actorUserId,
      idempotencyKey: String(command.idempotencyKey).toLowerCase(),
      routeKey: createIdempotencyRouteKey("/classes", null),
      requestHash: createIdempotencyRequestHash({
        body: {
          academic_year: 2026,
          edu_office_code: "B10",
          expected_student_count: 30,
          grade: 2,
          name: "우리  반",
          school_code: "1234567",
        },
        effectiveClassId: null,
      }),
    };
    expect(execute.mock.calls[0]?.[0]).toEqual(expected);
    expect(command.name).toBe("  우리  반  ");
    await createClassMariaDb(database, {
      ...command,
      requestId: "bbbbbbbb-cccc-dddd-eeee-ffffffffffff",
    });
    expect(execute.mock.calls[1]?.[0]).toEqual(expected);
  });

  it("maps unknown failures from the idempotency boundary without exposing SQL", async () => {
    const { execute, database } = boundary();
    execute.mockRejectedValue({
      errno: 1062,
      sqlState: "23000",
      sql: "private SQL",
      message: "private token",
    });
    const failure = await createClassMariaDb(database, input()).catch((error: unknown) => error);
    expect(failure).toMatchObject({ status: 500, response: { code: "INTERNAL_ERROR" } });
    expect(JSON.stringify(failure)).not.toMatch(/private SQL|private token/u);
    expect(failure).not.toHaveProperty("cause");
  });
});

describe("MariaDB class timestamps at the API boundary", () => {
  it.each([
    ["2026-09-06 13:00:00.123456", "2026-09-06T13:00:00.123Z"],
    ["2024-02-29 23:59:59.999999", "2024-02-29T23:59:59.999Z"],
    ["2000-02-29 00:00:00.000001", "2000-02-29T00:00:00.000Z"],
    ["1000-01-01 00:00:00.000000", "1000-01-01T00:00:00.000Z"],
    ["9999-12-31 23:59:59.999999", "9999-12-31T23:59:59.999Z"],
  ])("converts %s to millisecond ISO without fractional rounding", (datetime6, iso) => {
    expect(classTimestampIso(datetime6)).toBe(iso);
    expect(datetime6).toMatch(/\.\d{6}$/u);
  });

  it.each([
    undefined,
    null,
    new Date("2026-09-06T00:00:00.000Z"),
    "2026-09-06 00:00:00.123",
    "2026-09-06T00:00:00.123456Z",
    "2026-09-06 00:00:00.123456+09:00",
    "0000-01-01 00:00:00.000000",
    "0999-12-31 23:59:59.999999",
    "2100-02-29 00:00:00.000000",
    "2025-02-29 00:00:00.000000",
    "2026-04-31 00:00:00.000000",
    "2026-00-01 00:00:00.000000",
    "2026-13-01 00:00:00.000000",
    "2026-01-00 00:00:00.000000",
    "2026-01-32 00:00:00.000000",
    "2026-09-06 24:00:00.000000",
    "2026-09-06 23:60:00.000000",
    "2026-09-06 23:59:60.000000",
    "2026-09-06 00:00:00.1234567",
  ])("rejects noncanonical or impossible DATETIME6: %o", (value) => {
    expect(() => classTimestampIso(value)).toThrow(
      expect.objectContaining({
        status: 500,
        response: expect.objectContaining({ code: "INTERNAL_ERROR" }),
      }),
    );
  });
});

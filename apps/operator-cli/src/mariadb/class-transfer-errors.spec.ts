import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MariaDbTransferError, mapMariaDbTransferError } from "./class-transfer-errors.js";

const read = (path: string) =>
  readFileSync(new URL(`../../../../${path}`, import.meta.url), "utf8");
const contract = JSON.parse(
  read("db/mariadb/verification/0002_class_transition_error_contract.json"),
) as {
  procedures: { transfer_class_teacher: Record<string, string> };
  helper_propagation: {
    missing_class_errno: number;
    missing_class_by_top_level_procedure: Record<string, string>;
  };
};
const expectedPairs = [
  [30002, "45000", "OPERATOR_CLASS_NOT_FOUND"],
  [30501, "45000", "OPERATOR_CLASS_NOT_LIVE"],
  [30502, "45000", "OPERATOR_SAME_TEACHER"],
  [30503, "45000", "OPERATOR_OUTGOING_USER_NOT_FOUND"],
  [30504, "45000", "OPERATOR_OUTGOING_MEMBERSHIP_CHANGED"],
  [30505, "45000", "OPERATOR_TARGET_PRIOR_MEMBERSHIP"],
  [30506, "45000", "OPERATOR_TARGET_CURRENT_MEMBERSHIP"],
  [30507, "45000", "OPERATOR_TARGET_NOT_TEACHER"],
  [30508, "45000", "OPERATOR_OUTGOING_CAS_FAILED"],
  [30509, "45000", "OPERATOR_CLASS_REACTIVATION_CAS_FAILED"],
  [30510, "45000", "OPERATOR_INCOMING_USER_NOT_FOUND"],
  [30511, "45000", "OPERATOR_INCOMING_USER_INACTIVE"],
  [30512, "45000", "OPERATOR_INCOMING_PROFILE_INACTIVE"],
  [30513, "45000", "OPERATOR_TEMPORARY_PASSWORD_UNCHANGED"],
  [30514, "22023", "OPERATOR_EXPECTED_VERSION_REQUIRED"],
  [30515, "40001", "OPERATOR_CLASS_VERSION_CHANGED"],
  [1213, "40001", "OPERATOR_TRANSFER_BUSY"],
  [1205, "HY000", "OPERATOR_TRANSFER_BUSY"],
] as const;

describe("mapMariaDbTransferError", () => {
  it.each(expectedPairs)("maps errno %i and SQLSTATE %s to %s", (errno, sqlState, code) => {
    const error = mapMariaDbTransferError({ errno, sqlState });
    expect(error).toBeInstanceOf(MariaDbTransferError);
    expect(error.name).toBe("MariaDbTransferError");
    expect(error.code).toBe(code);
    expect(error.message).toMatch(/[가-힣]/u);
  });

  it("preserves all thirteen source public codes, including both CAS failures", () => {
    const publicMappings = Object.entries(contract.procedures.transfer_class_teacher).filter(
      ([, result]) => result.endsWith(":CLI"),
    );
    expect(publicMappings).toHaveLength(13);
    for (const [errno, result] of publicMappings)
      expect(mapMariaDbTransferError({ errno: Number(errno), sqlState: "45000" }).code).toBe(
        result.split(":")[0],
      );
    expect(contract.helper_propagation.missing_class_errno).toBe(30002);
    expect(mapMariaDbTransferError({ errno: 30002, sqlState: "45000" }).code).toBe(
      contract.helper_propagation.missing_class_by_top_level_procedure.transfer_class_teacher?.split(
        ":",
      )[0],
    );
  });

  it("matches the two checked-transfer SIGNAL definitions rather than guessing from SQLSTATE alone", () => {
    const source = read("db/mariadb/migrations/0026_checked_teacher_transfer.sql");
    expect(source).toMatch(/SIGNAL SQLSTATE '22023' SET MYSQL_ERRNO = 30514/u);
    expect(source).toMatch(/SIGNAL SQLSTATE '40001' SET MYSQL_ERRNO = 30515/u);
    for (const error of [
      { sqlState: "40001" },
      { errno: 99999, sqlState: "40001" },
      { code: "40001" },
      { errno: 30514, sqlState: "40001" },
    ])
      expect(mapMariaDbTransferError(error).code).toBe("OPERATOR_TRANSFER_FAILED");
  });

  it("rejects every mismatched, missing or wrongly typed SQLSTATE for known errno values", () => {
    for (const [errno, state] of expectedPairs) {
      for (const sqlState of [
        undefined,
        null,
        45000,
        "",
        "45000 ",
        "hy000",
        "45000",
        "40001",
        "22023",
        "HY000",
      ])
        if (sqlState !== state)
          expect(mapMariaDbTransferError({ errno, sqlState }).code).toBe(
            "OPERATOR_TRANSFER_FAILED",
          );
      expect(mapMariaDbTransferError({ errno, sqlstate: state }).code).toBe(
        "OPERATOR_TRANSFER_FAILED",
      );
    }
  });

  it("does not coerce errno strings, bigints, boxed numbers or invalid numbers", () => {
    for (const errno of [
      "30501",
      30501n,
      Object(30501),
      30501.1,
      NaN,
      Infinity,
      -1,
      null,
      undefined,
    ])
      expect(mapMariaDbTransferError({ errno, sqlState: "45000" }).code).toBe(
        "OPERATOR_TRANSFER_FAILED",
      );
  });

  it("does not turn internal/helper/constraint errors into public domain classifications", () => {
    for (const errno of [30001, 30003, 30004, 30005, 30006, 30409, 30516, 1062, 1451])
      for (const sqlState of ["45000", "23000", "40001", "HY000"])
        expect(
          mapMariaDbTransferError({
            errno,
            sqlState,
            constraint: "class_members_current_class_unique",
          }).code,
        ).toBe("OPERATOR_TRANSFER_FAILED");
  });

  it("treats nonobjects, arrays and errors without diagnostics as generic failures", () => {
    for (const value of [
      null,
      undefined,
      false,
      0,
      30501,
      30501n,
      Symbol("private"),
      "30501 45000 teacher transfer",
      [],
      () => undefined,
      new Error("30501 45000 private"),
    ])
      expect(mapMariaDbTransferError(value).code).toBe("OPERATOR_TRANSFER_FAILED");
  });

  it("ignores native messages, SQL, connection strings and nested causes for every classification", () => {
    const privateText =
      "mysql://private-user:private-password@private-host/secret-db SELECT secret_email";
    for (const pair of [...expectedPairs, [99999, "45000", "OPERATOR_TRANSFER_FAILED"] as const]) {
      const native = Object.assign(new Error(privateText, { cause: new Error(privateText) }), {
        errno: pair[0],
        sqlState: pair[1],
        sql: privateText,
        sqlMessage: privateText,
        dsn: privateText,
        stack: privateText,
      });
      const result = mapMariaDbTransferError(native);
      expect(result.code).toBe(pair[2]);
      expect([String(result), result.stack, JSON.stringify(result)].join("\n")).not.toContain(
        privateText,
      );
      for (const field of ["errno", "sqlState", "sql", "sqlMessage", "dsn", "cause"])
        expect(Object.hasOwn(result, field)).toBe(false);
    }
    const cause = { errno: 30501, sqlState: "45000" };
    expect(mapMariaDbTransferError({ cause }).code).toBe("OPERATOR_TRANSFER_FAILED");
    expect(
      mapMariaDbTransferError({
        message: "30501 45000",
        sqlMessage: "teacher transfer requires a live class",
      }).code,
    ).toBe("OPERATOR_TRANSFER_FAILED");
  });

  it("never reads message/cause accessors and fails closed on diagnostic accessors or throwing proxies", () => {
    const native = { errno: 30501, sqlState: "45000" };
    for (const field of ["message", "cause", "sql", "sqlMessage", "stack"])
      Object.defineProperty(native, field, {
        get: () => {
          throw new Error("private accessor");
        },
      });
    expect(mapMariaDbTransferError(native).code).toBe("OPERATOR_CLASS_NOT_LIVE");
    const accessor = Object.defineProperty({ sqlState: "45000" }, "errno", {
      get: () => {
        throw new Error("private accessor");
      },
    });
    expect(mapMariaDbTransferError(accessor).code).toBe("OPERATOR_TRANSFER_FAILED");
    const proxy = Proxy.revocable({}, {});
    proxy.revoke();
    expect(mapMariaDbTransferError(proxy.proxy).code).toBe("OPERATOR_TRANSFER_FAILED");
    expect(mapMariaDbTransferError(Object.create(native)).code).toBe("OPERATOR_TRANSFER_FAILED");
  });
});

describe("MariaDbTransferError", () => {
  it.each([
    "OPERATOR_INVALID_INPUT",
    "OPERATOR_UNAUTHENTICATED",
    "OPERATOR_CLASS_NOT_FOUND",
    "OPERATOR_OUTGOING_MEMBERSHIP_CHANGED",
    "OPERATOR_INCOMING_USER_NOT_FOUND",
    "OPERATOR_TRANSFER_FAILED",
  ])("supplies a fixed message for adapter code %s", (code) => {
    const error = new MariaDbTransferError(code);
    expect(error.code).toBe(code);
    expect(error.message).toMatch(/[가-힣]/u);
    expect(mapMariaDbTransferError(error)).toBe(error);
  });

  it("normalizes arbitrary code text and protects trusted pass-through errors from added private fields", () => {
    const error = new MariaDbTransferError("mysql://private:secret@host");
    expect(error.code).toBe("OPERATOR_TRANSFER_FAILED");
    expect(error.message).not.toContain("mysql:");
    expect(Object.isFrozen(error)).toBe(true);
    expect(Reflect.set(error, "cause", new Error("private"))).toBe(false);
    expect(Reflect.set(error, "message", "private")).toBe(false);
    expect(mapMariaDbTransferError(error)).toBe(error);
    const counterfeit = Object.assign(Object.create(MariaDbTransferError.prototype), {
      name: "MariaDbTransferError",
      code: "OPERATOR_CLASS_NOT_FOUND",
      message: "private",
    });
    expect(mapMariaDbTransferError(counterfeit).code).toBe("OPERATOR_TRANSFER_FAILED");
  });
});

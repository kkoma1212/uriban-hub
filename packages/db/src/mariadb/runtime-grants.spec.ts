import { describe, expect, it } from "vitest";
import { parseMariaDbRuntimeGrants } from "./runtime-grants.js";

const identity = { database: "classhub", user: "classhub_app", accountHost: "%" };
const passwordHash = `*${"A1".repeat(20)}`;
const account = "`classhub_app`@`%`";
const usage = `GRANT USAGE ON *.* TO ${account} IDENTIFIED BY PASSWORD '${passwordHash}' REQUIRE SSL`;
const table = (privileges: string, name = "users") =>
  `GRANT ${privileges} ON \`classhub\`.\`${name}\` TO ${account}`;
const procedure =
  "GRANT EXECUTE ON PROCEDURE `classhub`.`transfer_class_teacher_checked` TO " + account;
const rows = (...grants: string[]) =>
  grants.map((grant) => ({ "Grants for classhub_app@%": grant }));
const parse = (...grants: string[]) => parseMariaDbRuntimeGrants(rows(usage, ...grants), identity);
const rejected = (input: unknown) => {
  let thrown: unknown;
  try {
    parseMariaDbRuntimeGrants(input, identity);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(Error);
  expect((thrown as Error).message).toBe("MariaDB runtime grants rejected");
  expect(Object.hasOwn(thrown as object, "cause")).toBe(false);
};

describe("parseMariaDbRuntimeGrants", () => {
  it("splits column commas independently from privilege commas and produces sorted canonical keys", () => {
    expect(
      parse(
        table("SELECT, INSERT (`display_name`, `password_input_version`), UPDATE"),
        table("DELETE", "sessions"),
        procedure,
      ),
    ).toEqual([
      "procedure|transfer_class_teacher_checked|EXECUTE",
      "table|sessions|DELETE|*",
      "table|users|INSERT|display_name",
      "table|users|INSERT|password_input_version",
      "table|users|SELECT|*",
      "table|users|UPDATE|*",
    ]);
  });

  it("accepts column SELECT/UPDATE and returns no authentication/USAGE key", () => {
    expect(
      parse(
        table(
          "SELECT (`id`, `email_normalized`), UPDATE (`password_hash`, `password_input_version`)",
        ),
      ),
    ).toEqual([
      "table|users|SELECT|email_normalized",
      "table|users|SELECT|id",
      "table|users|UPDATE|password_hash",
      "table|users|UPDATE|password_input_version",
    ]);
    expect(parse()).toEqual([]);
    expect(JSON.stringify(parse(table("SELECT")))).not.toContain(passwordHash);
    expect(JSON.stringify(parse(table("SELECT")))).not.toContain("IDENTIFIED");
  });

  it("handles row order, multiple objects and null-prototype mysql2-style row records", () => {
    const values = [table("SELECT"), usage, table("INSERT", "audit_logs")];
    const data = values.map((text) => Object.assign(Object.create(null), { grants: text }));
    const result = parseMariaDbRuntimeGrants(data, identity);
    expect(result).toEqual(["table|audit_logs|INSERT|*", "table|users|SELECT|*"]);
    expect(parseMariaDbRuntimeGrants([...data].reverse(), identity)).toEqual(result);
  });

  it("matches the exact trusted DB, account name and account host including escaped backticks", () => {
    const configured = { database: "db-prod", user: "user`one", accountHost: "localhost" };
    expect(
      parseMariaDbRuntimeGrants(
        rows(
          `GRANT USAGE ON *.* TO \`user\`\`one\`@\`localhost\` IDENTIFIED BY PASSWORD '${passwordHash}' REQUIRE SSL`,
          "GRANT SELECT ON `db-prod`.`users` TO `user``one`@`localhost`",
        ),
        configured,
      ),
    ).toEqual(["table|users|SELECT|*"]);
    for (const wrong of [
      table("SELECT").replace("`classhub`", "`other`"),
      table("SELECT").replace("`classhub_app`", "`classhub_operator`"),
      table("SELECT").replace("`%`", "`localhost`"),
      table("SELECT").replace("`classhub`", "`Classhub`"),
    ])
      rejected(rows(usage, wrong));
  });

  it("requires exactly one native-password USAGE record with REQUIRE SSL", () => {
    for (const values of [
      [],
      [table("SELECT")],
      [usage, usage],
      [usage.replace(passwordHash, "")],
      [usage.replace(passwordHash, "*" + "A".repeat(39))],
      [usage.replace(passwordHash, "*" + "A".repeat(41))],
      [usage.replace(passwordHash, "*" + "Z".repeat(40))],
      [usage.replace(" REQUIRE SSL", "")],
      [usage.replace("REQUIRE SSL", "REQUIRE NONE")],
      [usage.replace("REQUIRE SSL", "REQUIRE X509")],
      [usage.replace("IDENTIFIED BY PASSWORD", "IDENTIFIED VIA mysql_native_password USING")],
      [usage + " WITH MAX_USER_CONNECTIONS 10"],
      [usage + " WITH GRANT OPTION"],
      [usage + "\n"],
      [usage.replace("`classhub_app`", "`other`")],
    ])
      rejected(rows(...values));
  });

  it("rejects global/schema scopes, grants on external DBs, grant options and extra privileges", () => {
    for (const grant of [
      `GRANT SELECT ON *.* TO ${account}`,
      `GRANT SELECT ON \`classhub\`.* TO ${account}`,
      `GRANT SELECT ON * . * TO ${account}`,
      `GRANT SELECT ON \`other\`.\`users\` TO ${account}`,
      table("ALL PRIVILEGES"),
      table("PROCESS"),
      table("CREATE"),
      table("REFERENCES"),
      table("SELECT, TRIGGER"),
      table("DELETE (`id`)"),
      table("EXECUTE"),
      table("SELECT") + " WITH GRANT OPTION",
      procedure.replace("EXECUTE", "EXECUTE, ALTER ROUTINE"),
      procedure.replace("PROCEDURE", "FUNCTION"),
    ])
      rejected(rows(usage, grant));
  });

  it("rejects active or inactive role grants, default roles, PUBLIC and PROXY", () => {
    for (const grant of [
      `GRANT \`application_role\` TO ${account}`,
      `GRANT \`inactive_role\` TO ${account}`,
      `SET DEFAULT ROLE \`application_role\` FOR ${account}`,
      `GRANT PROXY ON \`privileged\`@\`localhost\` TO ${account}`,
      "GRANT SELECT ON `classhub`.`users` TO PUBLIC",
      "GRANT SELECT ON `classhub`.`users` TO `PUBLIC`",
      `GRANT PUBLIC TO ${account}`,
    ])
      rejected(rows(usage, grant));
  });

  it("rejects repeated rights and table-wide/column overlap in either order", () => {
    for (const grants of [
      [table("SELECT"), table("SELECT")],
      [procedure, procedure],
      [table("SELECT, SELECT")],
      [table("INSERT (`id`, `id`)")],
      [table("SELECT (`id`)"), table("SELECT (`id`)")],
      [table("SELECT"), table("SELECT (`id`)")],
      [table("SELECT (`id`)"), table("SELECT")],
      [table("SELECT, SELECT (`id`)")],
    ])
      rejected(rows(usage, ...grants));
  });

  it("does not mistake disjoint privileges or columns for duplicate rights", () => {
    expect(
      parse(table("SELECT (`id`)"), table("SELECT (`display_name`)"), table("UPDATE (`id`)")),
    ).toEqual([
      "table|users|SELECT|display_name",
      "table|users|SELECT|id",
      "table|users|UPDATE|id",
    ]);
  });

  it("rejects noncanonical syntax, comments, missing backticks, malformed lists and key delimiters", () => {
    for (const grant of [
      table("select"),
      " " + table("SELECT"),
      table("SELECT") + ";",
      table("SELECT") + "\n",
      "/* comment */ " + table("SELECT"),
      table("SELECT /* comment */"),
      table("SELECT, "),
      table("SELECT (`id`,)"),
      table("SELECT ()"),
      table("INSERT (`id`, `display_name`"),
      table("SELECT").replace("`users`", "users"),
      table("SELECT").replace("`classhub`", "classhub"),
      table("SELECT", "users|UPDATE|*"),
      table("SELECT (`a|b`)"),
      table("SELECT", "*"),
      table("SELECT", "1users"),
    ])
      rejected(rows(usage, grant));
  });

  it("requires one own string data property per row without touching accessors", () => {
    const accessor = Object.defineProperty({}, "grant", {
      get: () => {
        throw new Error(passwordHash);
      },
    });
    const symbol = { [Symbol("grant")]: usage };
    const extraSymbol = { grant: usage, [Symbol("hidden")]: "extra" };
    for (const invalid of [
      null,
      undefined,
      [],
      {},
      usage,
      123,
      { grant: 123 },
      { grant: usage, extra: "hidden" },
      accessor,
      symbol,
      extraSymbol,
      Object.create({ grant: usage }),
    ])
      rejected([invalid]);
    for (const invalid of [null, undefined, {}, usage, 123]) rejected(invalid);
    const proxy = Proxy.revocable({}, {});
    proxy.revoke();
    rejected([proxy.proxy]);
  });

  it("never returns or throws the authentication hash or rejected GRANT text", () => {
    const privateGrant = usage + " PRIVATE_DSN=mysql://private:secret@host/db";
    let error: unknown;
    try {
      parseMariaDbRuntimeGrants(rows(privateGrant), identity);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("MariaDB runtime grants rejected");
    for (const representation of [String(error), (error as Error).stack, JSON.stringify(error)]) {
      expect(representation).not.toContain(passwordHash);
      expect(representation).not.toContain(privateGrant);
      expect(representation).not.toContain("private:secret");
    }
    expect(Object.getOwnPropertyNames(error)).toEqual(["stack", "message"]);
  });
});

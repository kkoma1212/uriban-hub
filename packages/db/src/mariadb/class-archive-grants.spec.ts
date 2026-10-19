import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { requiredMariaDbRuntimeGrants } from "./runtime-grant-extensions.js";
import { parseMariaDbRuntimeGrants } from "./runtime-grants.js";

const read = (legacy: boolean) =>
  [
    "0064_class_archive_retention_candidate_acl.sql",
    ...(legacy ? ["0064_class_archive_retention_candidate_legacy_acl.sql"] : []),
  ].flatMap((name) =>
    readFileSync(new URL(`../../../../db/mariadb/permissions/${name}`, import.meta.url), "utf8")
      .split("\n")
      .filter((line) => line.startsWith("GRANT "))
      .map((line) => ({
        grant: line
          .replace(
            / ON (PROCEDURE )?classhub_mariadb_phase1_dev\.([a-z_]+)/u,
            " ON $1`classhub_mariadb_phase1_dev`.`$2`",
          )
          .replaceAll("'classhub_retention'@'%'", "`classhub_retention`@`%`")
          .replace(
            /\(([^)]+)\)/gu,
            (_, columns: string) =>
              `(${columns
                .split(", ")
                .map((column) => `\`${column}\``)
                .join(", ")})`,
          )
          .replace(/;$/u, ""),
      })),
  );

describe("class archive candidate privileges", () => {
  it.each([false, true])(
    "matches reviewed SQL exactly (legacy=%s), without role or DDL escalation",
    (legacy) => {
      const usage = {
        grant: `GRANT USAGE ON *.* TO \`classhub_retention\`@\`%\` IDENTIFIED BY PASSWORD '*${"A1".repeat(20)}' REQUIRE SSL`,
      };
      const delta = parseMariaDbRuntimeGrants([usage, ...read(legacy)], {
        database: "classhub_mariadb_phase1_dev",
        user: "classhub_retention",
        accountHost: "%",
      });
      const base = requiredMariaDbRuntimeGrants("retention", "retention_admin_records_v1")!;
      const profile = legacy ? "retention_class_archives_legacy_v1" : "retention_class_archives_v1";
      expect(requiredMariaDbRuntimeGrants("retention", profile)).toEqual(
        [...new Set([...base, ...delta])].sort(),
      );
      expect(delta).not.toContain("table|classes|DELETE|*");
      expect(delta).not.toContain("table|classes|UPDATE|*");
      expect(delta).not.toContain("table|users|DELETE|*");
      expect(delta).not.toContain("table|teacher_library_items|DELETE|*");
      expect(delta).toContain("procedure|class_archive_schema_inventory|EXECUTE");
      expect(requiredMariaDbRuntimeGrants("app", profile)).toBeUndefined();
    },
  );
});

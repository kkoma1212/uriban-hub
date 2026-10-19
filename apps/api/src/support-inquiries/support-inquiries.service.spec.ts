import type { DB } from "@classhub/db";
import { ConfigService } from "@nestjs/config";
import {
  DummyDriver,
  Kysely,
  MysqlAdapter,
  MysqlIntrospector,
  MysqlQueryCompiler,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
} from "kysely";
import { describe, expect, it } from "vitest";

import type { AppEnvironment } from "../config/environment.js";
import { SupportInquiriesService } from "./support-inquiries.service.js";

const userId = "9223372036854775806";
const timestamp = "2026-09-08 00:00:00.123456";
const fixtureId = "3d239c52-e2d3-43b9-aa96-05ca4b71254a";
function harness(engine: "postgres" | "mariadb", missingReadback = false) {
  const queries: CompiledQuery[] = [];
  const transactions: string[] = [];
  let inquiryId = fixtureId;
  const row = () => ({
    id: inquiryId,
    status: "open",
    subject: "문의",
    created_at: engine === "mariadb" ? timestamp : new Date("2026-09-08T00:00:00.123Z"),
    updated_at: engine === "mariadb" ? timestamp : new Date("2026-09-08T00:00:00.123Z"),
  });
  const connection = {
    executeQuery: async (query: CompiledQuery) => {
      queries.push(query);
      if (engine === "mariadb" && query.sql.startsWith("insert")) {
        inquiryId = String(query.parameters[0]);
        return { rows: [], numAffectedRows: 1n };
      }
      return { rows: missingReadback ? [] : [row()] };
    },
    streamQuery: async function* () {
      throw new Error("Unexpected stream");
      yield { rows: [] };
    },
  } as DatabaseConnection;
  class Driver extends DummyDriver {
    override async acquireConnection() {
      return connection;
    }
    override async beginTransaction() {
      transactions.push("begin");
    }
    override async commitTransaction() {
      transactions.push("commit");
    }
    override async rollbackTransaction() {
      transactions.push("rollback");
    }
  }
  const database = new Kysely<DB>({
    dialect: {
      createAdapter: () => (engine === "mariadb" ? new MysqlAdapter() : new PostgresAdapter()),
      createDriver: () => new Driver(),
      createIntrospector: (db) =>
        engine === "mariadb" ? new MysqlIntrospector(db) : new PostgresIntrospector(db),
      createQueryCompiler: () =>
        engine === "mariadb" ? new MysqlQueryCompiler() : new PostgresQueryCompiler(),
    },
  });
  const config = new ConfigService<AppEnvironment, true>({ DATABASE_ENGINE: engine });
  return {
    database,
    queries,
    transactions,
    service: new SupportInquiriesService(database, config),
  };
}

describe("support inquiry database contract", () => {
  it("preserves the PostgreSQL insert returning response", async () => {
    const h = harness("postgres");
    try {
      const { inquiry } = await h.service.create(userId, " 문의 ", " 내용 ");
      expect(inquiry.id).toBe(fixtureId);
      expect(h.queries).toHaveLength(1);
      expect(h.queries[0]!.sql).toContain(
        'returning "id", "status", "subject", "created_at", "updated_at"',
      );
      expect(h.queries[0]!.parameters).toEqual(["내용", userId, "문의"]);
      expect(h.transactions).toEqual([]);
    } finally {
      await h.database.destroy();
    }
  });

  it("inserts a unique MariaDB inquiry and reads only that user's new UUID before commit", async () => {
    const h = harness("mariadb");
    try {
      const { inquiry } = await h.service.create(userId, " 문의 ", " 내용 ");
      expect(inquiry.id).toMatch(
        /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u,
      );
      expect(inquiry.created_at.toISOString()).toBe("2026-09-08T00:00:00.123Z");
      expect(h.queries).toHaveLength(2);
      expect(h.queries[0]!.sql).not.toContain("returning");
      expect(h.queries[0]!.parameters).toEqual([inquiry.id, "내용", userId, "문의"]);
      expect(h.queries[1]!.sql).toContain("where `id` = ? and `requester_user_id` = ?");
      expect(h.queries[1]!.parameters).toEqual([inquiry.id, userId]);
      expect(h.transactions).toEqual(["begin", "commit"]);
    } finally {
      await h.database.destroy();
    }
  });

  it("rolls back MariaDB creation when the inserted inquiry cannot be read back", async () => {
    const h = harness("mariadb", true);
    try {
      await expect(h.service.create(userId, "문의", "내용")).rejects.toThrow();
      expect(h.transactions).toEqual(["begin", "rollback"]);
    } finally {
      await h.database.destroy();
    }
  });

  it.each(["postgres", "mariadb"] as const)(
    "keeps %s reads scoped to the authenticated requester",
    async (engine) => {
      const h = harness(engine);
      try {
        const { inquiries } = await h.service.list(userId);
        expect(inquiries[0]!.created_at.toISOString()).toBe("2026-09-08T00:00:00.123Z");
        expect(h.queries[0]!.parameters).toEqual([userId, 100]);
        expect(h.queries[0]!.sql).toMatch(/where [`"]requester_user_id[`"] = /u);
        expect(h.queries[0]!.sql).not.toMatch(
          /internal_note|assigned_admin_account_id|responded_by_admin_account_id/u,
        );
      } finally {
        await h.database.destroy();
      }
    },
  );
});

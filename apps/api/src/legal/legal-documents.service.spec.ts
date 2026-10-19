import { createHash } from "node:crypto";
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
import { LegalDocumentsService } from "./legal-documents.service.js";

const content = "# 이용약관\n개시된 검증용 문서입니다.";
const fixture = (overrides: Record<string, unknown> = {}) => ({
  id: "c782bcbb-5c6f-469a-b489-796124dd6466",
  document_type: "terms",
  policy_version: "v2",
  title: "이용약관",
  content,
  content_sha256: createHash("sha256").update(content).digest(),
  effective_at: new Date("2026-01-01T00:00:00.000Z"),
  published_at: new Date("2026-01-01T00:00:00.000Z"),
  status: "published",
  created_by_admin_account_id: "secret-author-id",
  ...overrides,
});
function harness(
  rows: Record<string, unknown>[],
  engine: "postgres" | "mariadb" = "postgres",
  environment: Partial<AppEnvironment> = {},
) {
  const queries: CompiledQuery[] = [];
  const connection = {
    executeQuery: async (query: CompiledQuery) => {
      queries.push(query);
      return { rows };
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
  const config = new ConfigService<AppEnvironment, true>({
    DATABASE_ENGINE: engine,
    ...environment,
  });
  return { queries, database, service: new LegalDocumentsService(database, config) };
}

describe("public legal documents", () => {
  it("keeps the unactivated preview compatible with its existing schema", async () => {
    const h = harness([]);
    expect(await h.service.consentBundle()).toEqual({ binding_required: false, documents: null });
    expect(h.queries).toHaveLength(0);
    await h.database.destroy();
  });
  it("requires published evidence in production even when the optional flag is off", async () => {
    const h = harness([], "postgres", {
      NODE_ENV: "production",
      LEGAL_CONSENT_BINDING_ENABLED: false,
    });
    await expect(h.service.consentBundle()).rejects.toMatchObject({ status: 503 });
    expect(h.queries).toHaveLength(1);
    await h.database.destroy();
  });
  it("returns only four document references without publisher identity", async () => {
    const h = harness(
      ["terms", "privacy_consent", "privacy_policy", "guardian_consent"].map((document_type) =>
        fixture({ document_type }),
      ),
      "postgres",
      { LEGAL_CONSENT_BINDING_ENABLED: true },
    );
    const result = await h.service.consentBundle();
    expect(result.binding_required).toBe(true);
    expect(Object.keys(result.documents!)).toHaveLength(4);
    expect(Object.keys(result.documents!.terms)).toEqual([
      "id",
      "policy_version",
      "content_sha256",
    ]);
    expect(JSON.stringify(result)).not.toContain("secret-author-id");
    await h.database.destroy();
  });
  it.each(["postgres", "mariadb"] as const)(
    "reads only publication data with %s bindings",
    async (engine) => {
      const date =
        engine === "mariadb" ? "2026-01-01 00:00:00.000000" : new Date("2026-01-01T00:00:00Z");
      const h = harness([fixture({ effective_at: date, published_at: date })], engine);
      try {
        const result = await h.service.read("terms");
        expect(result.version).toMatchObject({
          policy_version: "v2",
          status: "published",
          content,
          effective_at: "2026-01-01T00:00:00.000Z",
          content_sha256: createHash("sha256").update(content).digest("hex"),
        });
        expect(JSON.stringify(result)).not.toContain("secret-author-id");
        expect(h.queries[0]!.sql).not.toContain("created_by_admin_account_id");
        expect(h.queries[0]!.parameters.slice(0, 3)).toEqual(["terms", "published", "retired"]);
        expect(h.queries[0]!.parameters[3]).toBeTypeOf(engine === "mariadb" ? "string" : "object");
      } finally {
        await h.database.destroy();
      }
    },
  );

  it.each([
    { status: "draft" },
    { published_at: null },
    { effective_at: null },
    { effective_at: new Date("2099-01-01T00:00:00Z") },
    { content: "[게시본 주입: 연락처]" },
    { content: "개발 정본" },
    { content_sha256: Buffer.alloc(32) },
  ])("never exposes incomplete publication %j", async (overrides) => {
    const h = harness([fixture(overrides)]);
    try {
      expect(await h.service.read("terms")).toEqual({ version: null, versions: [] });
    } finally {
      await h.database.destroy();
    }
  });

  it("returns a previous published version only when explicitly requested", async () => {
    const h = harness([fixture({ status: "retired", policy_version: "v1" })]);
    try {
      expect((await h.service.read("terms")).version).toBeNull();
      expect((await h.service.read("terms", "v1")).version?.policy_version).toBe("v1");
      expect((await h.service.read("terms", "missing")).version).toBeNull();
      await expect(h.service.read("internal")).rejects.toMatchObject({ status: 400 });
      await expect(h.service.read("terms", "invalid\nversion")).rejects.toMatchObject({
        status: 400,
      });
    } finally {
      await h.database.destroy();
    }
  });
});

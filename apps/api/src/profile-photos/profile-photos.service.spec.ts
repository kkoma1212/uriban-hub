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
import { describe, expect, it, vi } from "vitest";
import type { AppEnvironment } from "../config/environment.js";
import type { RedisRateLimiter } from "../common/rate-limit/redis-rate-limiter.js";
import { deleteAccountProfilePhotoIfInstalled } from "./profile-photo-deletion.js";
import { ProfilePhotoImageService } from "./profile-photo-image.service.js";
import { ProfilePhotoNotFoundException } from "./profile-photo.errors.js";
import { classProfilePhotoQuery, ProfilePhotosService } from "./profile-photos.service.js";
import type { ProfilePhotoActor } from "./profile-photo.types.js";

const actor: ProfilePhotoActor = { userId: "31", sessionId: "session-31", currentClassId: "7" };
const now = new Date("2026-09-27T12:00:00Z");
const encoded = Buffer.from("sanitized image");
const version = "1493ef88-9be6-441e-9b0c-c506ee1d199e";
type Options = {
  deleted?: boolean;
  revoked?: boolean;
  expired?: boolean;
  blockedTeacher?: boolean;
  existing?: boolean;
  tableInstalled?: boolean;
  rateDenied?: boolean;
  noClassPhoto?: boolean;
};
function harness(engine: "postgres" | "mariadb", options: Options = {}) {
  const queries: CompiledQuery[] = [];
  const transactions: string[] = [];
  const date = (value: Date) =>
    engine === "mariadb" ? value.toISOString().replace("T", " ").replace("Z", "000") : value;
  const connection = {
    executeQuery: async (query: CompiledQuery) => {
      queries.push(query);
      const normalized = query.sql.replaceAll('"', "").replaceAll(String.fromCharCode(96), "");
      if (normalized.includes("information_schema.tables"))
        return { rows: options.tableInstalled === false ? [] : [{ installed: 1 }] };
      if (normalized.includes("AS now")) return { rows: [{ now: date(now) }] };
      if (normalized.includes("from users"))
        return {
          rows: [
            {
              deleted_at: options.deleted ? date(now) : null,
              is_active: engine === "mariadb" ? 1 : true,
              email_verified_at: date(now),
              signup_approved_at: null,
              signup_role: "student",
            },
          ],
        };
      if (normalized.includes("from teacher_profiles"))
        return {
          rows: options.blockedTeacher
            ? [
                {
                  status: "revoked",
                  temporary_password_must_change: engine === "mariadb" ? 0 : false,
                },
              ]
            : [],
        };
      if (normalized.includes("from sessions"))
        return {
          rows: [
            {
              expires_at: date(new Date(now.getTime() + (options.expired ? -1 : 60_000))),
              revoked_at: options.revoked ? date(now) : null,
            },
          ],
        };
      if (normalized.startsWith("select") && normalized.includes("user_profile_photos as photo"))
        return {
          rows: options.noClassPhoto ? [] : [{ image_bytes: encoded, photo_version: version }],
        };
      if (normalized.startsWith("select") && normalized.includes("user_profile_photos"))
        return { rows: options.existing ? [{ image_bytes: encoded, photo_version: version }] : [] };
      if (/^(insert|update|delete)/u.test(normalized)) return { rows: [], numAffectedRows: 1n };
      throw new Error("Unexpected SQL: " + normalized);
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
  const rateLimiter = {
    consume: vi.fn(async () => ({
      allowed: !options.rateDenied,
      retryAfterSeconds: 60,
      remaining: 1,
      limit: 10,
      resetAt: 0,
    })),
  } as unknown as RedisRateLimiter;
  const images = new ProfilePhotoImageService();
  vi.spyOn(images, "encode").mockResolvedValue(encoded);
  const service = new ProfilePhotosService(
    database,
    new ConfigService<AppEnvironment, true>({ DATABASE_ENGINE: engine }),
    rateLimiter,
    images,
  );
  return { database, service, queries, transactions, rateLimiter, images };
}

describe.each(["postgres", "mariadb"] as const)(
  "photo service %s SQL boundary (no database connections)",
  (engine) => {
    it("locks the account and session before inserting the sanitized image", async () => {
      const h = harness(engine);
      const result = await h.service.updateOwn(actor, "raw source");
      expect(result.photo?.url).toMatch(/^\/api\/v1\/profile-photos\/me\?v=/u);
      expect(h.transactions).toEqual(["begin", "commit"]);
      const writes = h.queries.filter((q) => q.sql.startsWith("insert"));
      expect(writes).toHaveLength(1);
      expect(writes[0]?.parameters).toContain(encoded);
      expect(writes[0]?.parameters).not.toContain("raw source");
      expect(h.queries.filter((q) => q.sql.includes("for update"))).toHaveLength(3);
      expect(h.queries.map((q) => q.sql).join("\n")).not.toContain("returning");
      await h.database.destroy();
    });
    it("does not rewrite identical sanitized bytes on a retry", async () => {
      const h = harness(engine, { existing: true });
      expect((await h.service.updateOwn(actor, "raw")).photo?.version).toBe(version);
      expect(h.queries.some((q) => /^(insert|update)/u.test(q.sql))).toBe(false);
      await h.database.destroy();
    });
    it.each([{ deleted: true }, { revoked: true }, { expired: true }, { blockedTeacher: true }])(
      "rejects changed account/session authority before any write",
      async (options) => {
        const h = harness(engine, options);
        await expect(h.service.updateOwn(actor, "raw")).rejects.toThrow();
        expect(h.transactions).toEqual(["begin", "rollback"]);
        expect(h.queries.some((q) => /^(insert|update|delete)/u.test(q.sql))).toBe(false);
        await h.database.destroy();
      },
    );
    it("rate limits before decoding", async () => {
      const h = harness(engine, { rateDenied: true });
      await expect(h.service.updateOwn(actor, "raw")).rejects.toThrow();
      expect(h.images.encode).not.toHaveBeenCalled();
      expect(h.queries).toEqual([]);
      await h.database.destroy();
    });
    it("deletes only the authenticated account picture and returns the empty state", async () => {
      const h = harness(engine);
      expect((await h.service.deleteOwn(actor)).photo).toBeNull();
      expect(h.queries.at(-1)?.parameters).toEqual([actor.userId]);
      expect(h.queries.at(-1)?.sql).toMatch(/^delete from/u);
      expect(h.transactions).toEqual(["begin", "commit"]);
      await h.database.destroy();
    });
    it("scopes every class image to both approved same-class memberships and active accounts", async () => {
      const h = harness(engine);
      const query = classProfilePhotoQuery(h.database, actor, { memberId: "56" }).compile();
      const plain = query.sql.replaceAll('"', "").replaceAll(String.fromCharCode(96), "");
      for (const key of [
        "viewer.user_id",
        "viewer.class_id",
        "viewer.status",
        "target.status",
        "classroom.status",
        "target_account.is_active",
        "target_account.deleted_at",
        "viewer_account.is_active",
        "viewer_account.deleted_at",
        "target_teacher.status",
        "viewer_teacher.status",
        "target.id",
      ])
        expect(plain).toContain(key);
      expect(plain).toContain("viewer.class_id = target.class_id");
      expect(query.parameters).toEqual([
        "31",
        "7",
        "approved",
        "approved",
        "active",
        true,
        true,
        "student",
        "teacher",
        "active",
        false,
        "student",
        "teacher",
        "active",
        false,
        "56",
      ]);
      expect(await h.service.getClassImage(actor, { memberId: "56" })).toBe(encoded);
      await h.database.destroy();
    });
    it("uses the same boundary for the class teacher and hides absent/disallowed images alike", async () => {
      const h = harness(engine, { noClassPhoto: true });
      const query = classProfilePhotoQuery(h.database, actor, { teacher: true }).compile();
      expect(query.parameters.at(-1)).toBe("teacher");
      await expect(h.service.getClassImage(actor, { memberId: "56" })).rejects.toBeInstanceOf(
        ProfilePhotoNotFoundException,
      );
      expect(() =>
        classProfilePhotoQuery(h.database, { ...actor, currentClassId: null }, { memberId: "56" }),
      ).toThrow(ProfilePhotoNotFoundException);
      for (const memberId of ["0", "-1", "1 OR 1=1", "9223372036854775808"])
        expect(() => classProfilePhotoQuery(h.database, actor, { memberId })).toThrow(
          ProfilePhotoNotFoundException,
        );
      await h.database.destroy();
    });
    it.each([true, false])(
      "cleans account deletion inside the caller's transaction only when the photo table exists (%s)",
      async (installed) => {
        const h = harness(engine, { tableInstalled: installed });
        await expect(
          h.database.transaction().execute(async (transaction) => {
            await deleteAccountProfilePhotoIfInstalled(
              transaction,
              engine === "mariadb",
              actor.userId,
            );
            throw new Error("later account deletion rejected");
          }),
        ).rejects.toThrow("later account deletion rejected");
        expect(h.queries.filter((q) => q.sql.startsWith("delete"))).toHaveLength(installed ? 1 : 0);
        expect(h.transactions).toEqual(["begin", "rollback"]);
        await h.database.destroy();
      },
    );
  },
);

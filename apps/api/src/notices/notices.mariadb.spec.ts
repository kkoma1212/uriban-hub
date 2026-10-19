import type { DB } from "@classhub/db";
import { ConfigService } from "@nestjs/config";
import {
  Kysely,
  MysqlAdapter,
  MysqlIntrospector,
  MysqlQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
  type QueryResult,
} from "kysely";
import { describe, expect, it, vi } from "vitest";
import type { AppEnvironment } from "../config/environment.js";
import type { ContentAudiencesService } from "../content-audiences/content-audiences.service.js";
import type { InAppRemindersService } from "../in-app-reminders/in-app-reminders.service.js";
import {
  NoticesAccessService,
  type NoticeActorRole,
  type NoticeResourceRow,
} from "./notices-access.service.js";
import { NoticesCommandService } from "./notices-command.service.js";
import { NoticesQueryService } from "./notices-query.service.js";
import {
  decodeNoticeConfirmationsCursor,
  decodeNoticeListCursor,
  encodeNoticeConfirmationsCursor,
  encodeNoticeListCursor,
} from "./notices.cursor.js";
import { noticeDatabaseEngine } from "./notices.database.js";
import type { CreateNoticeCommand, UpdateNoticeCommand } from "./notices.types.js";

// Actual MysqlQueryCompiler and Kysely transaction/result plumbing. Scripted rows
// exercise caller boundaries; this is deliberately not a database state simulator.
function harness(reply: (query: CompiledQuery) => QueryResult<unknown>) {
  const calls: CompiledQuery[] = [];
  const events: string[] = [];
  const connection: DatabaseConnection = {
    async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
      calls.push(query);
      events.push(query.sql.trim());
      return reply(query) as QueryResult<R>;
    },
    async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
      throw new Error("unused");
    },
  };
  const database = new Kysely<DB>({
    dialect: {
      createAdapter: () => new MysqlAdapter(),
      createIntrospector: (db) => new MysqlIntrospector(db),
      createQueryCompiler: () => new MysqlQueryCompiler(),
      createDriver: () => ({
        async init() {},
        async destroy() {},
        async acquireConnection() {
          return connection;
        },
        async releaseConnection() {},
        async beginTransaction() {
          events.push("BEGIN");
        },
        async commitTransaction() {
          events.push("COMMIT");
        },
        async rollbackTransaction() {
          events.push("ROLLBACK");
        },
      }),
    },
  });
  return { database, calls, events };
}

const config = new ConfigService<AppEnvironment, true>({ DATABASE_ENGINE: "mariadb" });
const noticeId = "9007199254741001";
const actorUserId = "9007199254741002";
const classId = "9007199254741003";
const memberId = "9007199254741004";
const requestId = "36000000-0000-4000-8000-000000000001";
const clock = "2026-09-07 14:59:59.123456";
const rawNotice = {
  audience_mode: "all_snapshot",
  category: "general",
  class_id: classId,
  content: "원래 내용",
  content_revision: "7",
  id: noticeId,
  is_important: 0,
  published_at: clock,
  row_version: "12",
  title: "원래 제목",
};
const notice: NoticeResourceRow = {
  ...rawNotice,
  audience_mode: "all_snapshot",
  category: "general",
  is_important: false,
  published_at: new Date("2026-09-07T14:59:59.123Z"),
};
function dependencies(role: NoticeActorRole = "teacher") {
  const context = { classId, memberId, role };
  const access = {
    getCollectionContext: vi.fn().mockResolvedValue(context),
    getResourceContext: vi.fn().mockResolvedValue({ context, notice }),
    lockActorContext: vi.fn().mockResolvedValue({ ...context, displayName: "선생님" }),
    lockNotice: vi.fn().mockResolvedValue(notice),
  };
  const audiences = {
    resolveRecipientIds: vi.fn().mockResolvedValue(["20", "21"]),
    selectedAudienceEnabled: () => true,
  };
  const reminders = { resolve: vi.fn().mockResolvedValue(undefined), create: vi.fn() };
  return {
    access,
    audiences,
    reminders,
    accessService: access as unknown as NoticesAccessService,
    audienceService: audiences as unknown as ContentAudiencesService,
    reminderService: reminders as unknown as InAppRemindersService,
  };
}
function commands(h: ReturnType<typeof harness>, d = dependencies()) {
  return new NoticesCommandService(
    h.database,
    d.accessService,
    d.audienceService,
    d.reminderService,
    config,
  );
}
function queries(h: ReturnType<typeof harness>, d = dependencies()) {
  return new NoticesQueryService(h.database, d.accessService, d.audienceService, config);
}
function unexpected(): never {
  throw new Error("Unexpected SQL in unit test");
}
function mutationValues(query: CompiledQuery): Record<string, unknown> {
  const columns = /\(([^)]+)\) values/u
    .exec(query.sql)?.[1]
    ?.split(", ")
    .map((column) => column.replaceAll("`", ""));
  if (!columns) throw new Error("Expected single-row insert");
  return Object.fromEntries(columns.map((column, index) => [column, query.parameters[index]]));
}
const updateCommand: UpdateNoticeCommand = {
  actorUserId,
  noticeId,
  requestId,
  ifMatch: '"12"',
  category: undefined,
  content: undefined,
  isImportant: undefined,
  title: undefined,
};
const createCommand: CreateNoticeCommand = {
  actorUserId,
  requestId,
  idempotencyKey: requestId,
  title: "원래 제목",
  content: "원래 내용",
  isImportant: false,
  category: "general",
  audience: { memberIds: [], mode: "all", storedMode: "all_snapshot" },
};

describe("notices MariaDB access and engine boundaries", () => {
  it("defaults to PostgreSQL and accepts only the explicit MariaDB engine", () => {
    expect(noticeDatabaseEngine()).toBe("postgres");
    expect(noticeDatabaseEngine(config)).toBe("mariadb");
    expect(() =>
      noticeDatabaseEngine(
        new ConfigService({ DATABASE_ENGINE: "sqlite" }) as ConfigService<AppEnvironment, true>,
      ),
    ).toThrow("Invalid notices database engine");
  });
  it.each([0, 1])(
    "decodes native teacher must-change %s before access checks",
    async (mustChange) => {
      const h = harness(() => ({
        rows: [
          {
            class_id: classId,
            class_status: "active",
            member_id: memberId,
            profile_status: "active",
            role: "teacher",
            temporary_password_must_change: mustChange,
          },
        ],
      }));
      const operation = new NoticesAccessService(h.database, config).getCollectionContext(
        actorUserId,
      );
      if (mustChange) await expect(operation).rejects.toMatchObject({ status: 403 });
      else await expect(operation).resolves.toEqual({ classId, memberId, role: "teacher" });
    },
  );
  it("rejects native inactive account before querying its class", async () => {
    const h = harness(() => ({ rows: [{ deleted_at: null, display_name: "이름", is_active: 0 }] }));
    const access = new NoticesAccessService(h.database, config);
    await expect(
      h.database
        .transaction()
        .execute((tx) =>
          access.lockActorContext(
            tx,
            { classId, memberId, role: "teacher" },
            actorUserId,
            "teacher",
          ),
        ),
    ).rejects.toMatchObject({ status: 401 });
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.sql).toMatch(/from `users`.*for update/u);
    expect(h.events.at(-1)).toBe("ROLLBACK");
  });
  it("locks account, class, member in order and decodes the teacher profile", async () => {
    const h = harness((q) => {
      if (q.sql.includes("from `users`"))
        return { rows: [{ deleted_at: null, display_name: "이름", is_active: 1 }] };
      if (q.sql.includes("from `classes`")) return { rows: [{ id: classId, status: "active" }] };
      if (q.sql.includes("from `class_members`"))
        return {
          rows: [{ id: memberId, user_id: actorUserId, status: "approved", role: "teacher" }],
        };
      if (q.sql.includes("from `teacher_profiles`"))
        return { rows: [{ status: "active", temporary_password_must_change: 0 }] };
      return unexpected();
    });
    const access = new NoticesAccessService(h.database, config);
    await expect(
      h.database
        .transaction()
        .execute((tx) =>
          access.lockActorContext(
            tx,
            { classId, memberId, role: "teacher" },
            actorUserId,
            "teacher",
          ),
        ),
    ).resolves.toEqual({ classId, memberId, role: "teacher", displayName: "이름" });
    expect(h.calls.slice(0, 3).every((q) => q.sql.endsWith("for update"))).toBe(true);
    expect(h.calls[3]!.sql).not.toContain("for update"); // Preserve the existing PG lock scope.
  });
  it("binds student audience identity and normalizes the locked publication timestamp", async () => {
    const h = harness(() => ({ rows: [rawNotice] }));
    const access = new NoticesAccessService(h.database, config);
    const result = await h.database
      .transaction()
      .execute((tx) => access.lockNotice(tx, classId, noticeId, memberId));
    expect(result.published_at.toISOString()).toBe("2026-09-07T14:59:59.123Z");
    expect(result.is_important).toBe(false);
    expect(h.calls[0]!.parameters).toEqual([noticeId, classId, memberId]);
    expect(h.calls[0]!.sql).toContain("UTC_TIMESTAMP(6)");
    expect(h.calls[0]!.sql).not.toContain("::");
  });
  it.each(["01", "0", "9223372036854775808", "1 OR 1=1"])(
    "rejects notice id %s without SQL",
    async (id) => {
      const h = harness(unexpected);
      await expect(
        new NoticesAccessService(h.database, config).getResourceContext(actorUserId, id),
      ).rejects.toMatchObject({ status: 404 });
      expect(h.calls).toHaveLength(0);
    },
  );
});

describe("notices MariaDB query compilation and native results", () => {
  it("preserves BIGINT, booleans, escaped search, UTC response and six-digit cursor", async () => {
    const d = dependencies("student");
    const search = "A%_\\";
    const h = harness((q) =>
      q.sql.includes("server_today")
        ? { rows: [{ server_today: "2026-09-08" }] }
        : {
            rows: Array.from({ length: 21 }, (_, index) => ({
              ...rawNotice,
              id: String(BigInt(noticeId) + BigInt(index)),
              cursor_published_at: "2026-09-07T14:59:59.123456Z",
              confirmed_revision: index === 0 ? "7" : null,
            })),
          },
    );
    const cursor = encodeNoticeListCursor({
      id: noticeId,
      importance: "all",
      isImportant: false,
      publishedAt: "2026-09-07T14:59:59.654321Z",
      search,
    });
    const result = await queries(h, d).list({ actorUserId, importance: "all", cursor, search });
    expect(result.items).toHaveLength(20);
    expect(result.items[0]).toMatchObject({
      id: noticeId,
      is_important: false,
      published_at: "2026-09-07T14:59:59.123Z",
      confirmation_state: "confirmed",
    });
    expect(result.items[1]!.confirmation_state).toBe("unread");
    expect(decodeNoticeListCursor(result.next_cursor!, "all", search).publishedAt).toBe(
      "2026-09-07T14:59:59.123456Z",
    );
    const query = h.calls[1]!;
    expect(query.sql).toContain("LOWER(notice.title) LIKE LOWER(?) ESCAPE ?");
    expect(query.sql).toContain("audience_recipient.member_id = ?");
    expect(query.sql).not.toMatch(/::|ILIKE|to_char/u);
    expect(query.parameters).toContain("%A\\%\\_\\\\%");
    expect(query.parameters).toContain("2026-09-07 14:59:59.654321");
    expect(query.parameters.at(-1)).toBe(21);
  });
  it("loads a student's stored revision using native string identities", async () => {
    const h = harness(() => ({ rows: [{ confirmed_revision: "6" }] }));
    const result = await queries(h, dependencies("student")).get({ actorUserId, noticeId });
    expect(result.confirmation_state).toBe("modified_unconfirmed");
    expect(h.calls[0]!.parameters).toEqual([noticeId, memberId]);
  });
  it.each(["unread", "confirmed", "modified_unconfirmed"] as const)(
    "reads %s counts/page/reminder in one statement, including an empty page",
    async (state) => {
      const h = harness(() => ({
        rows: [
          {
            content_revision: "8",
            confirmed: "2",
            unread: "3",
            modified_unconfirmed: "1",
            reconfirmed: "1",
            excluded_member_count: "4",
            requested_at: clock,
            server_today: "2026-09-07",
            member_id: null,
            student_number: null,
            display_name: null,
          },
        ],
      }));
      const result = await queries(h).listConfirmations({ actorUserId, noticeId, state });
      expect(result).toEqual({
        content_revision: "8",
        counts: {
          confirmed: 2,
          unread: 3,
          modified_unconfirmed: 1,
          reconfirmed: 1,
          excluded_member_count: 4,
        },
        items: [],
        next_cursor: null,
        server_today: "2026-09-07",
        last_reminder_requested_at: "2026-09-07T14:59:59.123Z",
      });
      expect(h.calls).toHaveLength(1);
      expect(h.events).not.toContain("BEGIN");
      const query = h.calls[0]!;
      expect(query.sql).toContain("WITH snapshot_notice");
      expect(query.sql).toContain("CROSS JOIN counts LEFT JOIN page ON TRUE");
      expect(query.sql).toContain("account.is_active=TRUE AND account.deleted_at IS NULL");
      expect(query.sql).not.toMatch(/NULLS LAST|FILTER|::/u);
    },
  );
  it.each([null, 12])(
    "keeps confirmation cursor ordering with student number %s",
    async (studentNumber) => {
      const h = harness(() => ({
        rows: Array.from({ length: 21 }, (_, index) => ({
          content_revision: "8",
          confirmed: "0",
          unread: "21",
          modified_unconfirmed: "0",
          reconfirmed: "0",
          excluded_member_count: "0",
          requested_at: null,
          server_today: "2026-09-07",
          member_id: String(BigInt(memberId) + BigInt(index)),
          student_number: studentNumber,
          display_name: "학생",
        })),
      }));
      const cursor = encodeNoticeConfirmationsCursor({
        displayName: "학생",
        memberId,
        noticeId,
        state: "unread",
        studentNumber,
      });
      const result = await queries(h).listConfirmations({
        actorUserId,
        noticeId,
        state: "unread",
        cursor,
      });
      expect(result.items).toHaveLength(20);
      expect(
        decodeNoticeConfirmationsCursor(result.next_cursor!, noticeId, "unread").studentNumber,
      ).toBe(studentNumber);
      expect(h.calls[0]!.sql).toContain(
        studentNumber === null
          ? "student_number IS NULL AND"
          : "student_number > ? OR student_number IS NULL",
      );
    },
  );
  it("returns 404 if the notice disappears before the confirmation snapshot", async () => {
    const h = harness(() => ({ rows: [] }));
    await expect(
      queries(h).listConfirmations({ actorUserId, noticeId, state: "unread" }),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe("notices MariaDB write transaction boundaries", () => {
  it("creates recipients and audit with one DB6 clock before final idempotency response", async () => {
    const h = harness((q) => {
      if (q.sql.includes("SELECT id, request_hash")) return { rows: [] };
      if (q.sql.includes("AS notice_clock")) return { rows: [{ notice_clock: clock }] };
      if (q.sql.startsWith("select") && q.sql.includes("from `notices`"))
        return { rows: [rawNotice] };
      if (q.sql.startsWith("insert into `notices`"))
        return { rows: [], insertId: BigInt(noticeId), numAffectedRows: 1n };
      return { rows: [], insertId: 42n, numAffectedRows: 1n };
    });
    const d = dependencies();
    const result = await commands(h, d).create(createCommand);
    expect(result).toMatchObject({
      id: noticeId,
      is_important: false,
      published_at: "2026-09-07T14:59:59.123Z",
    });
    expect(d.audiences.resolveRecipientIds).toHaveBeenCalledOnce();
    const insertion = h.calls.find((q) => q.sql.startsWith("insert into `notices`"))!;
    expect(mutationValues(insertion)).toMatchObject({
      created_at: clock,
      published_at: clock,
      updated_at: clock,
      is_important: false,
    });
    const recipients = h.calls.find((q) => q.sql.startsWith("insert into `notice_recipients`"))!;
    expect(recipients.parameters.filter((value) => value === clock)).toHaveLength(2);
    const audit = h.calls.find((q) => q.sql.startsWith("insert into `audit_logs`"))!;
    const values = mutationValues(audit);
    expect(values.created_at).toBe(clock);
    expect(JSON.parse(values.after_json as string)).toMatchObject({
      is_important: false,
      recipient_count: 2,
      notice_id: noticeId,
    });
    expect(h.calls.indexOf(recipients)).toBeLessThan(h.calls.indexOf(audit));
    expect(h.calls.at(-1)!.sql).toContain("INSERT INTO api_idempotency_keys");
    expect(h.calls.every((q) => !q.sql.includes("returning") && !q.sql.includes("::"))).toBe(true);
    expect(h.events.at(-1)).toBe("COMMIT");
  });
  it.each([undefined, "not-a-uuid"])("rejects creation key %s before starting SQL", async (key) => {
    const h = harness(unexpected);
    await expect(
      commands(h).create({ ...createCommand, idempotencyKey: key }),
    ).rejects.toMatchObject({ status: 400 });
    expect(h.calls).toHaveLength(0);
  });
  it.each(["title", "content", "isImportant", "category"] as const)(
    "preserves revision semantics and audit JSON when changing %s",
    async (field) => {
      const changesRevision = field === "title" || field === "content";
      const changed = {
        ...rawNotice,
        row_version: "13",
        content_revision: changesRevision ? "8" : "7",
        ...(field === "title" ? { title: "새 제목" } : {}),
        ...(field === "content" ? { content: "새 내용" } : {}),
        ...(field === "category" ? { category: "performance" } : {}),
        ...(field === "isImportant" ? { is_important: 1 } : {}),
      };
      const h = harness((q) =>
        q.sql.startsWith("select") ? { rows: [changed] } : { rows: [], numAffectedRows: 1n },
      );
      const value =
        field === "isImportant"
          ? true
          : field === "category"
            ? "performance"
            : field === "title"
              ? "새 제목"
              : "새 내용";
      const result = await commands(h).update({ ...updateCommand, [field]: value });
      expect(result.content_revision).toBe(changesRevision ? "8" : "7");
      expect(result.row_version).toBe("13");
      const mutation = h.calls[0]!;
      expect(mutation.sql.includes("`content_revision` = content_revision + 1")).toBe(
        changesRevision,
      );
      expect(
        mutation.parameters.some(
          (parameter) => typeof parameter === "string" && /^202\d-.*\.\d{6}$/u.test(parameter),
        ),
      ).toBe(true);
      const audit = mutationValues(h.calls.at(-1)!);
      const after = JSON.parse(audit.after_json as string) as Record<string, unknown>;
      expect(Object.hasOwn(after, "content_revision")).toBe(changesRevision);
      expect(after).not.toHaveProperty("content");
      if (field === "isImportant") expect(after.is_important).toBe(true);
      expect(h.calls.every((q) => !q.sql.includes("returning"))).toBe(true);
    },
  );
  it("leaves no-op edits without writes or audit", async () => {
    const h = harness(unexpected);
    await expect(commands(h).update(updateCommand)).resolves.toMatchObject({ row_version: "12" });
    expect(h.calls).toHaveLength(0);
    expect(h.events).toEqual(["BEGIN", "COMMIT"]);
  });
  it.each([undefined, "12", '"11"'])(
    "preserves If-Match %s checks after actor and notice locks",
    async (ifMatch) => {
      const h = harness(unexpected);
      const d = dependencies();
      await expect(
        commands(h, d).update({ ...updateCommand, ifMatch, title: "새 제목" }),
      ).rejects.toMatchObject({
        status: ifMatch === undefined ? 428 : ifMatch === "12" ? 400 : 409,
      });
      expect(d.access.lockActorContext).toHaveBeenCalledOnce();
      expect(d.access.lockNotice).toHaveBeenCalledOnce();
      expect(h.calls).toHaveLength(0);
      expect(h.events.at(-1)).toBe("ROLLBACK");
    },
  );
  it.each([0n, 2n])(
    "rejects invalid update affected count %s without audit",
    async (numAffectedRows) => {
      const h = harness(() => ({ rows: [], numAffectedRows }));
      await expect(commands(h).update({ ...updateCommand, title: "새 제목" })).rejects.toThrow();
      expect(h.calls).toHaveLength(1);
      expect(h.events.at(-1)).toBe("ROLLBACK");
    },
  );
  it("soft deletes and serializes the existing public snapshot", async () => {
    const h = harness(() => ({ rows: [], numAffectedRows: 1n }));
    await commands(h).delete({ actorUserId, noticeId, requestId, ifMatch: '"12"', reason: "정정" });
    expect(h.calls[0]!.sql).toContain("update `notices`");
    expect(
      h.calls[0]!.parameters.filter(
        (value) => typeof value === "string" && /\.\d{6}$/u.test(value),
      ),
    ).toHaveLength(2);
    const audit = mutationValues(h.calls[1]!);
    expect(audit.reason).toBe("정정");
    expect(JSON.parse(audit.target_snapshot as string)).toMatchObject({
      deleted_at: null,
      is_important: false,
      published_at: "2026-09-07T14:59:59.123Z",
    });
  });
  it("rolls back a native audit failure without retrying update", async () => {
    const failure = Object.assign(new Error("synthetic SQL failure"), {
      errno: 1213,
      sqlState: "40001",
    });
    const h = harness((q) => {
      if (q.sql.startsWith("insert into `audit_logs`")) throw failure;
      return q.sql.startsWith("select")
        ? { rows: [{ ...rawNotice, row_version: "13", title: "새 제목", content_revision: "8" }] }
        : { rows: [], numAffectedRows: 1n };
    });
    await expect(commands(h).update({ ...updateCommand, title: "새 제목" })).rejects.toBe(failure);
    expect(h.events.filter((event) => event === "BEGIN")).toHaveLength(1);
    expect(h.events.at(-1)).toBe("ROLLBACK");
  });
  it.each([undefined, "6", "7"])(
    "confirms with previous revision %s then resolves reminders",
    async (previous) => {
      const h = harness((q) =>
        q.sql.startsWith("select")
          ? { rows: previous === undefined ? [] : [{ id: "50", confirmed_revision: previous }] }
          : { rows: [], numAffectedRows: 1n },
      );
      const d = dependencies("student");
      const now = new Date("2026-09-07T15:00:00.999Z");
      await expect(
        commands(h, d).confirm({ actorUserId, noticeId, contentRevision: "7" }, now),
      ).resolves.toMatchObject({ confirmation_state: "confirmed" });
      expect(h.calls[0]!.sql).toContain("for update");
      expect(h.calls).toHaveLength(previous === "7" ? 1 : 2);
      if (previous !== "7") expect(h.calls[1]!.parameters).toContain("2026-09-07 15:00:00.999000");
      expect(d.reminders.resolve).toHaveBeenCalledOnce();
      expect(d.reminders.resolve.mock.calls[0]![1]).toEqual({
        classId,
        contentRevision: "7",
        memberId,
        reminderType: "notice",
        resourceId: noticeId,
      });
    },
  );
  it("rejects stale confirmation after reading the locked mark", async () => {
    const h = harness(() => ({ rows: [] }));
    const d = dependencies("student");
    await expect(
      commands(h, d).confirm({ actorUserId, noticeId, contentRevision: "6" }),
    ).rejects.toMatchObject({ status: 409 });
    expect(h.calls).toHaveLength(1);
    expect(d.reminders.resolve).not.toHaveBeenCalled();
  });
  it("passes the reminder service a live actor/resource lock callback", async () => {
    const h = harness(unexpected);
    const d = dependencies();
    d.reminders.create.mockImplementation(
      async (input: { lockContext: (tx: unknown) => Promise<unknown> }) => {
        expect(await h.database.transaction().execute((tx) => input.lockContext(tx))).toEqual({
          actorDisplayName: "선생님",
          actorMemberId: memberId,
          classId,
          contentRevision: "7",
          resourceId: noticeId,
        });
        return { status: "queued" };
      },
    );
    await expect(
      commands(h, d).createReminder({
        actorUserId,
        noticeId,
        requestId,
        idempotencyKey: requestId,
        contentRevision: "7",
      }),
    ).resolves.toEqual({ status: "queued" });
    expect(d.access.lockActorContext).toHaveBeenCalledOnce();
    expect(d.access.lockNotice).toHaveBeenCalledOnce();
  });
});

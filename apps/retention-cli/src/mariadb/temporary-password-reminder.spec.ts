import type { DB } from "@classhub/db";
import { Kysely, MysqlDialect } from "kysely";
import { describe, expect, it, vi } from "vitest";
import { runMariaDbTemporaryPasswordReminder } from "./temporary-password-reminder.js";

const now = new Date("2026-09-07T12:00:00.000Z");
const candidates = [1, 2, 3].map((id) => ({
  email_normalized: `synthetic-${id}@example.test`,
  user_id: String(id),
  expires_at: "2026-09-08 11:00:00.987654",
}));
function harness(rows = candidates, failureAt = "") {
  const calls: { sql: string; parameters: readonly unknown[] }[] = [];
  const events: string[] = [];
  const database = new Kysely<DB>({
    dialect: new MysqlDialect({
      pool: {
        getConnection(callback) {
          callback(null, {
            config: {},
            threadId: 1,
            connect() {},
            destroy() {},
            query(sql, parameters: readonly unknown[], done) {
              calls.push({ sql, parameters });
              events.push(
                sql.startsWith("UPDATE")
                  ? `mark:${String(parameters[1])}`
                  : sql.trim().split(/\s/u)[0]!,
              );
              if (failureAt && sql.includes(failureAt))
                done?.(new Error("synthetic SQL failure"), []);
              else
                done?.(
                  null,
                  sql.includes("SELECT users.email_normalized")
                    ? rows
                    : { affectedRows: 1, insertId: 0, changedRows: 0 },
                );
              return {
                stream() {
                  throw new Error("unused stream");
                },
              };
            },
            release() {},
          });
        },
        end(callback) {
          callback(null);
        },
      },
    }),
  });
  return { database, calls, events };
}

describe("MariaDB temporary password reminders", () => {
  it("dry-run counts only capped recipients without constructing SMTP or writing", async () => {
    const h = harness();
    const createMailer = vi.fn();
    const result = await runMariaDbTemporaryPasswordReminder(h.database, {
      mode: "dry-run",
      now,
      maxRecipients: 2,
      createMailer,
    });
    expect(result).toEqual({
      capped: true,
      eligible_count: 2,
      failed_count: 0,
      mode: "dry-run",
      sent_count: 0,
      table_name: "teacher_profiles",
      window_ends_at: "2026-09-08T12:00:00.000Z",
    });
    expect(createMailer).not.toHaveBeenCalled();
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.parameters).toEqual([
      "2026-09-07 12:00:00.000",
      "2026-09-08 12:00:00.000",
      3,
    ]);
    expect(h.calls[0]!.sql).toContain("temporary_password_reminder_sent_at IS NULL");
    expect(h.calls[0]!.sql).toContain("users.deleted_at IS NULL");
  });

  it("sends then marks each success, continues after SMTP failure and audits counts only", async () => {
    const h = harness();
    const dates: Date[] = [];
    const send = vi.fn(async (email: string, expiry: Date) => {
      dates.push(expiry);
      const id = email.slice("synthetic-".length, "synthetic-".length + 1);
      h.events.push(`send:${id}`);
      if (id === "2") throw new Error("synthetic SMTP failure");
    });
    const result = await runMariaDbTemporaryPasswordReminder(h.database, {
      mode: "execute",
      now,
      createMailer: () => ({ sendExpiryReminder: send }),
    });
    expect(result).toMatchObject({ sent_count: 2, failed_count: 1, eligible_count: 3 });
    expect(h.events).toEqual([
      "SELECT",
      "send:1",
      "mark:1",
      "send:2",
      "send:3",
      "mark:3",
      "INSERT",
    ]);
    expect(dates.map((date) => date.toISOString())).toEqual(
      Array(3).fill("2026-09-08T11:00:00.987Z"),
    );
    const audit = h.calls.at(-1)!;
    expect(audit.parameters.slice(0, 3)).toEqual([
      "reminder.executed",
      "temporary_password_reminders",
      JSON.stringify({
        eligible_count: 3,
        sent_count: 2,
        failed_count: 1,
        window_ends_at: "2026-09-08T12:00:00.000Z",
      }),
    ]);
    expect(JSON.stringify(audit.parameters)).not.toContain("example.test");
  });

  it("a mark failure stops subsequent delivery without retry or success audit", async () => {
    const h = harness(candidates, "UPDATE");
    const send = vi.fn().mockResolvedValue(undefined);
    await expect(
      runMariaDbTemporaryPasswordReminder(h.database, {
        mode: "execute",
        now,
        createMailer: () => ({ sendExpiryReminder: send }),
      }),
    ).rejects.toThrow("synthetic SQL failure");
    expect(send).toHaveBeenCalledTimes(1);
    expect(h.calls).toHaveLength(2);
  });

  it("preserves the initial clock even if the caller mutates its Date during SMTP", async () => {
    const h = harness(candidates.slice(0, 1));
    const mutableNow = new Date(now);
    await runMariaDbTemporaryPasswordReminder(h.database, {
      mode: "execute",
      now: mutableNow,
      createMailer: () => ({
        async sendExpiryReminder() {
          mutableNow.setUTCFullYear(2040);
        },
      }),
    });
    expect(h.calls[1]!.parameters[0]).toBe("2026-09-07 12:00:00.000");
  });

  it("rejects malformed returned dates before constructing SMTP", async () => {
    const h = harness([{ ...candidates[0]!, expires_at: "2026-02-30 00:00:00.000000" }]);
    const createMailer = vi.fn();
    await expect(
      runMariaDbTemporaryPasswordReminder(h.database, { mode: "execute", now, createMailer }),
    ).rejects.toMatchObject({ reason: "invalid_result" });
    expect(createMailer).not.toHaveBeenCalled();
  });
});

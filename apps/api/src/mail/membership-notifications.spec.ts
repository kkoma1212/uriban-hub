import type { DB } from "@classhub/db";
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
} from "kysely";
import { describe, expect, it, vi } from "vitest";

import type { AuthConfig } from "../auth/auth.types.js";
import { MembersService } from "../members/members.service.js";
import { MembershipService } from "../membership/membership.service.js";
import type { NotificationMailer } from "./notification-mailer.js";

const authConfig: AuthConfig = {
  agePolicyVersion: "test",
  emailHmacKey: "synthetic-notification-test-hmac-key",
  emailHmacKeyVersion: "test",
  privacyPolicyVersion: "test",
  termsPolicyVersion: "test",
};
const changedAt = new Date("2026-09-08T00:00:00Z");
type Action = "request" | "approve" | "reject" | "remove";

function harness(
  action: Action,
  options: {
    commitFails?: boolean;
    mailThrows?: boolean;
    teacherLookupFails?: boolean;
    inactiveStudent?: boolean;
  } = {},
) {
  const events: string[] = [];
  const queries: CompiledQuery[] = [];
  const nextStatus = {
    request: "pending",
    approve: "approved",
    reject: "rejected",
    remove: "removed",
  }[action];
  const expectedStatus = action === "remove" ? "approved" : "pending";
  const student = {
    deleted_at: null,
    display_name: "학생",
    email_normalized: "student@example.invalid",
    email_verified_at: changedAt,
    id: "2",
    is_active: !options.inactiveStudent,
    signup_approved_at: changedAt,
  };
  const teacher = {
    ...student,
    id: "1",
    is_active: true,
    email_normalized: "teacher@example.invalid",
  };
  const targetClass = { id: "10", name: "우리 반", status: "active", expected_student_count: 30 };
  const studentMember = {
    class_id: "10",
    display_name_in_class: null,
    id: "20",
    role: "student",
    row_version: "1",
    status: expectedStatus,
    user_id: "2",
  };
  const teacherMember = {
    ...studentMember,
    id: "11",
    role: "teacher",
    status: "approved",
    user_id: "1",
  };
  const changedMember = {
    ...studentMember,
    row_version: "2",
    status: nextStatus,
    status_changed_at: changedAt,
    student_number: null,
  };
  const connection = {
    executeQuery: async (query: CompiledQuery) => {
      queries.push(query);
      const statement = query.sql;
      // 승인 때 지난 '반 전체' 글 받는 사람을 더하는 raw SQL(대문자 INSERT, 2026-10-02 A1-02)도 쓰기 문장이다.
      if (/^\s*(insert|delete)\b/iu.test(statement)) {
        return { rows: statement.includes('into "class_members"') ? [changedMember] : [] };
      }
      if (statement.startsWith('update "class_members"')) return { rows: [changedMember] };
      if (statement.includes("to_regclass")) return { rows: [{ exists: false }] };
      if (statement.includes('from "users"')) {
        return { rows: action === "request" ? [student] : [teacher, student] };
      }
      if (statement.includes('from "teacher_profiles"')) {
        return {
          rows:
            action === "request"
              ? []
              : [{ status: "active", temporary_password_must_change: false }],
        };
      }
      if (statement.includes('from "class_invite_codes"'))
        return { rows: [{ class_id: "10", id: "30" }] };
      if (statement.includes('from "classes"')) return { rows: [targetClass] };
      if (statement.includes('from "class_member_status_history"')) return { rows: [] };
      if (statement.includes('from "class_members" as "member"')) {
        if (statement.includes('select "account"."email_normalized"')) {
          events.push("teacher-lookup");
          if (options.teacherLookupFails) throw new Error("synthetic recipient lookup failure");
          // Duplicate recipient rows still produce one separate message for that mailbox.
          return {
            rows: [
              { email_normalized: teacher.email_normalized },
              { email_normalized: teacher.email_normalized },
            ],
          };
        }
        if (statement.includes("count(*)")) return { rows: [{ count: "1" }] };
        return {
          rows: [
            {
              class_id: "10",
              class_status: "active",
              member_id: "11",
              profile_status: "active",
              role: "teacher",
              temporary_password_must_change: false,
            },
          ],
        };
      }
      if (statement.includes('from "class_members"')) {
        if (action === "request") return { rows: [] };
        return {
          rows: statement.includes("for update") ? [teacherMember, studentMember] : [studentMember],
        };
      }
      throw new Error("Unexpected synthetic query");
    },
    streamQuery: async function* () {
      throw new Error("Unexpected stream");
      yield { rows: [] };
    },
  } as DatabaseConnection;
  let commitCount = 0;
  class Driver extends DummyDriver {
    override async acquireConnection() {
      return connection;
    }
    override async beginTransaction() {
      events.push("begin");
    }
    override async commitTransaction() {
      commitCount += 1;
      if (options.commitFails && commitCount === (action === "request" ? 2 : 1)) {
        throw new Error("synthetic commit failure");
      }
      events.push("commit");
    }
    override async rollbackTransaction() {
      events.push("rollback");
    }
  }
  const database = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new Driver(),
      createIntrospector: (db) => new PostgresIntrospector(db),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  const delivery = (name: string) =>
    vi.fn(async () => {
      events.push(name);
      if (options.mailThrows) throw new Error("private SMTP reply");
      return "sent" as const;
    });
  const notifications = {
    sendClassJoinRequestedEmail: delivery("student-mail"),
    sendClassJoinRequestEmail: delivery("teacher-mail"),
    sendMembershipStatusEmail: delivery("status-mail"),
  };
  const notificationMailer = notifications as unknown as NotificationMailer;
  const members = new MembersService(database, notificationMailer);
  const membership = new MembershipService(
    database,
    {
      consume: vi.fn().mockResolvedValue({ allowed: true, remaining: 2, retryAfterSeconds: 60 }),
    } as never,
    authConfig,
    notificationMailer,
  );
  const run = () => {
    if (action === "request")
      return membership.createRequest({
        clientIp: "192.0.2.1",
        inviteCode: "ABCDEFGH",
        requestId: "10000000-0000-4000-8000-000000000001",
        userId: "2",
      });
    const command = {
      actorUserId: "1",
      memberId: "20",
      reason: "서비스에서만 확인하는 사유",
      requestId: "10000000-0000-4000-8000-000000000001",
    };
    return action === "approve"
      ? members.approve({ ...command, displayNameInClass: null, studentNumber: null })
      : members[action](command);
  };
  return { database, events, notifications, queries, run };
}

describe("PostgreSQL membership mail notifications", () => {
  it("sends student receipt and authorized teacher alerts only after the request commits", async () => {
    const h = harness("request");
    try {
      const result = await h.run();
      expect(result).toMatchObject({
        status: "pending",
        email_delivery_status: "sent",
        teacher_notification_delivery_status: "sent",
      });
      expect(h.events.slice(0, 4)).toEqual(["begin", "commit", "begin", "commit"]);
      expect(h.events.indexOf("teacher-lookup")).toBeGreaterThan(3);
      expect(h.events.indexOf("student-mail")).toBeGreaterThan(3);
      expect(h.notifications.sendClassJoinRequestedEmail).toHaveBeenCalledExactlyOnceWith(
        "student@example.invalid",
        "우리 반",
      );
      expect(h.notifications.sendClassJoinRequestEmail).toHaveBeenCalledExactlyOnceWith(
        "teacher@example.invalid",
        "우리 반",
      );
      const recipientQuery = h.queries.find((query) =>
        query.sql.startsWith('select "account"."email_normalized"'),
      )!;
      expect(recipientQuery.sql).toContain('"member"."class_id" = $1');
      expect(recipientQuery.sql).toContain('"account"."deleted_at" is null');
      expect(recipientQuery.sql).toContain('"account"."is_active" = $5');
      expect(recipientQuery.sql).toContain('"profile"."status" = $6');
      expect(recipientQuery.sql).toContain('"profile"."temporary_password_must_change" = $7');
      expect(recipientQuery.parameters).toEqual([
        "10",
        "teacher",
        "approved",
        "active",
        true,
        "active",
        false,
      ]);
      expect(JSON.stringify(result)).not.toContain("@example.invalid");
      expect(h.notifications.sendMembershipStatusEmail).not.toHaveBeenCalled();
    } finally {
      await h.database.destroy();
    }
  });

  it.each(["mail", "teacher lookup", "commit"] as const)(
    "keeps request outcome accurate when %s fails",
    async (failure) => {
      const h = harness("request", {
        mailThrows: failure === "mail",
        teacherLookupFails: failure === "teacher lookup",
        commitFails: failure === "commit",
      });
      try {
        if (failure === "commit") {
          await expect(h.run()).rejects.toThrow("synthetic commit failure");
          expect(h.notifications.sendClassJoinRequestedEmail).not.toHaveBeenCalled();
          expect(h.notifications.sendClassJoinRequestEmail).not.toHaveBeenCalled();
        } else {
          await expect(h.run()).resolves.toMatchObject({
            status: "pending",
            email_delivery_status: failure === "mail" ? "failed" : "sent",
            teacher_notification_delivery_status: "failed",
          });
        }
        expect(
          h.queries.filter((query) => query.sql.startsWith('insert into "class_members"')),
        ).toHaveLength(1);
      } finally {
        await h.database.destroy();
      }
    },
  );

  it.each(["approve", "reject", "remove"] as const)(
    "mails the %s result after commit without sending the private reason",
    async (action) => {
      const h = harness(action);
      try {
        await expect(h.run()).resolves.toMatchObject({ email_delivery_status: "sent" });
        expect(h.events).toEqual(["begin", "commit", "status-mail"]);
        expect(h.notifications.sendMembershipStatusEmail).toHaveBeenCalledExactlyOnceWith(
          "student@example.invalid",
          "우리 반",
          { approve: "approved", reject: "rejected", remove: "removed" }[action],
        );
      } finally {
        await h.database.destroy();
      }
    },
  );

  it.each(["approve", "reject", "remove"] as const)(
    "does not retry the committed %s mutation when SMTP throws",
    async (action) => {
      const h = harness(action, { mailThrows: true });
      try {
        await expect(h.run()).resolves.toMatchObject({ email_delivery_status: "failed" });
        expect(h.events).toEqual(["begin", "commit", "status-mail"]);
        expect(
          h.queries.filter((query) => query.sql.startsWith('update "class_members"')),
        ).toHaveLength(1);
      } finally {
        await h.database.destroy();
      }
    },
  );

  it.each(["approve", "reject", "remove"] as const)(
    "does not send %s mail when commit fails",
    async (action) => {
      const h = harness(action, { commitFails: true });
      try {
        await expect(h.run()).rejects.toThrow("synthetic commit failure");
        expect(h.notifications.sendMembershipStatusEmail).not.toHaveBeenCalled();
        expect(h.events).toEqual(["begin", "rollback"]);
      } finally {
        await h.database.destroy();
      }
    },
  );

  it.each(["reject", "remove"] as const)(
    "does not mail inactive accounts after %s",
    async (action) => {
      const h = harness(action, { inactiveStudent: true });
      try {
        await expect(h.run()).resolves.toMatchObject({ email_delivery_status: "failed" });
        expect(h.notifications.sendMembershipStatusEmail).not.toHaveBeenCalled();
        expect(h.events).toEqual(["begin", "commit"]);
      } finally {
        await h.database.destroy();
      }
    },
  );
});

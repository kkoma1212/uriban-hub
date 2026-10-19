import { describe, expect, it } from "vitest";

import { AuditLogDataInvalidException } from "./audit-logs.errors.js";
import {
  assertSafeAuditEnvelope,
  expectedTargetType,
  sanitizeAuditSnapshot,
} from "./audit-logs.service.js";
import { CLASS_AUDIT_ACTIONS } from "./audit-logs.types.js";

describe("audit log response snapshot allowlist", () => {
  it("keeps only action-specific scalar values", () => {
    expect(
      sanitizeAuditSnapshot("member.profile_updated", {
        display_name_snapshot: "김학생",
        email: "student@example.com",
        member_id: "12",
        nested: { password: "secret" },
        role: "student",
        status: "approved",
        student_number: 7,
      }),
    ).toEqual({
      display_name_snapshot: "김학생",
      member_id: "12",
      role: "student",
      status: "approved",
    });
  });

  it("removes attendance time and unknown-action metadata", () => {
    expect(
      sanitizeAuditSnapshot("attendance_notification.created", {
        attendance_notification_id: "9",
        expected_time: "08:20",
        notification_date: "2026-07-18",
        notification_type: "late",
        status: "pending",
      }),
    ).toEqual({
      attendance_notification_id: "9",
      notification_date: "2026-07-18",
      notification_type: "late",
      status: "pending",
    });
    expect(sanitizeAuditSnapshot("security.authz.denied", { email: "x@example.com" })).toBeNull();
  });

  it("accepts current reminder and draw-adjustment actions with privacy-safe snapshots", () => {
    const common = {
      actorDisplayName: "김교사",
      actorRole: "teacher",
      createdAt: "2026-07-18T03:04:05.123456Z",
      reason: null,
      targetId: "10",
    };
    for (const [action, targetType] of [
      ["notice.reminder_created", "notice"],
      ["supply.reminder_created", "supply"],
      ["seat_draw.adjusted", "seat_draw"],
      ["team_draw.adjusted", "team_draw"],
    ] as const) {
      expect(() => assertSafeAuditEnvelope({ ...common, action, targetType })).not.toThrow();
      expect(() => assertSafeAuditEnvelope({ ...common, action, targetType: "member" })).toThrow(
        AuditLogDataInvalidException,
      );
    }

    expect(
      sanitizeAuditSnapshot("notice.reminder_created", {
        content_revision: "3",
        cooldown_suppressed_count: 1,
        created_count: 2,
        current_unresolved_count: 4,
        recipient_member_ids: ["11", "12"],
        reminder_batch_id: "b9fa877e-af6d-4d52-a3c5-306b5da229a1",
        student_name: "노출 금지",
      }),
    ).toEqual({
      content_revision: "3",
      cooldown_suppressed_count: 1,
      created_count: 2,
      current_unresolved_count: 4,
      reminder_batch_id: "b9fa877e-af6d-4d52-a3c5-306b5da229a1",
    });
    expect(
      sanitizeAuditSnapshot("supply.reminder_created", {
        content_revision: "4",
        created_count: 3,
        recipient_member_ids: ["21", "22", "23"],
        reminder_batch_id: "9a2e4c6c-b99b-41e2-90f7-842f10ebecb0",
        student_number: 8,
      }),
    ).toEqual({
      content_revision: "4",
      created_count: 3,
      reminder_batch_id: "9a2e4c6c-b99b-41e2-90f7-842f10ebecb0",
    });
    expect(
      sanitizeAuditSnapshot("seat_draw.adjusted", {
        assigned_student_count: 28,
        email: "student@example.com",
        row_count: 6,
        student_number: 3,
      }),
    ).toEqual({ assigned_student_count: 28, row_count: 6 });
    expect(
      sanitizeAuditSnapshot("team_draw.adjusted", {
        assigned_student_count: 28,
        group_count: 7,
        member_id: "91",
        student_name: "노출 금지",
      }),
    ).toEqual({ assigned_student_count: 28, group_count: 7 });
  });

  it("fails closed for action, timestamp, target, id, actor, and reason corruption", () => {
    const valid = {
      action: "notice.updated",
      actorDisplayName: "김교사",
      actorRole: "teacher",
      createdAt: "2026-07-18T03:04:05.123456Z",
      reason: null,
      targetId: "10",
      targetType: "notice",
    };
    expect(() => assertSafeAuditEnvelope(valid)).not.toThrow();
    for (const invalid of [
      { ...valid, action: "notice.unapproved" },
      { ...valid, action: "security.authz.denied" },
      { ...valid, createdAt: "2026-07-18T03:04:05.123Z" },
      { ...valid, targetType: "security_audit" },
      { ...valid, targetId: "email@example.com" },
      { ...valid, actorRole: "system" },
      { ...valid, actorDisplayName: "교\u0000사" },
      { ...valid, reason: "사유\n개행" },
    ]) {
      expect(() => assertSafeAuditEnvelope(invalid)).toThrow(AuditLogDataInvalidException);
    }
  });

  /*
   * 종류 목록에 새 감사가 들어갔는데 이 매핑이 안 따라가면 **목록 한 줄이 아니라 감사
   * 화면 전체가 500** 이 된다 — 봉투 검사가 던지기 때문이다. 2026-08-22 감사(BLUE-03)
   * 에서 실제로 그랬다: 선거·당번이 목록에는 12건 들어갔는데 매핑이 비어서, 교사가 그
   * 기능을 **한 번만 써도** 최신 감사 화면이 안 열렸다.
   *
   * 그래서 목록과 매핑을 함께 보게 강제한다. 새 감사를 더하면 이 시험이 먼저 막는다.
   */
  it("maps every class audit action to a target type", () => {
    const unmapped = CLASS_AUDIT_ACTIONS.filter(
      (action) => expectedTargetType(action) === undefined,
    );
    expect(unmapped).toEqual([]);
  });
});

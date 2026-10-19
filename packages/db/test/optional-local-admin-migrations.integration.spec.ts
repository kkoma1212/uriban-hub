import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { runner } from "node-pg-migrate";
import { Pool } from "pg";
import {
  startNativeTestService,
  type StartedNativeTestService,
} from "../../../OPERATIONS/native-runtime/test-services.mjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const bootstrapPath = fileURLToPath(
  new URL("../../../db/bootstrap/001-local-development-roles.sql", import.meta.url),
);
const migrationsDirectory = fileURLToPath(new URL("../../../db/migrations", import.meta.url));
const mandatoryClosedRoles = [
  "classhub_app",
  "classhub_worker",
  "classhub_retention",
  "classhub_operator",
];

let bootstrapPool: Pool;
let container: StartedNativeTestService;
let migratorDatabaseUrl: string;

function databaseUrl(username: string, password: string): string {
  return `postgresql://${username}:${password}@${container.getHost()}:${container.getMappedPort(5432)}/classhub_dev`;
}

async function migrate(direction: "down" | "up", count?: number): Promise<void> {
  await runner({
    ...(count === undefined ? {} : { count }),
    databaseUrl: migratorDatabaseUrl,
    direction,
    dir: migrationsDirectory,
    migrationsTable: "pgmigrations",
    verbose: false,
  });
}

/*
 * 걸음수를 "맨 위에서 몇 칸"으로 세면 마이그레이션이 추가될 때마다 착지점이 밀린다.
 * 실제로 두 번 깨졌으므로(22000·24000 추가 시) 목표 지점을 절대값으로 말한다.
 */
async function migrateDownTo(remaining: number): Promise<void> {
  const applied = await bootstrapPool.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM pgmigrations",
  );
  const steps = Number(applied.rows[0]!.count) - remaining;
  if (steps < 0) throw new Error(`already below ${remaining} migrations`);
  if (steps > 0) await migrate("down", steps);
}

async function latestMigrationOnDisk(): Promise<{ count: number; name: string }> {
  const names = (await readdir(migrationsDirectory))
    .filter((name) => /^\d+_[a-z0-9-]+\.sql$/u.test(name))
    .sort();
  return { count: names.length, name: names.at(-1)!.replace(/\.sql$/u, "") };
}

/*
 * 아래 단계별 걸음은 마이그레이션마다 ACL이 닫힌 채인지 확인하는 실제 커버리지라
 * 줄이지 않는다. 다만 새 마이그레이션이 생겼는데 걸음을 안 늘리면 조용히 커버리지만
 * 빠지므로, 끝에서 디스크의 마지막 마이그레이션과 대조해 크게 실패하게 만든다.
 */
async function expectWalkedEveryMigration(): Promise<void> {
  const latest = await latestMigrationOnDisk();
  await expectMigrationHead(latest.count, latest.name);
}

async function expectMigrationHead(count: number, latest: string): Promise<void> {
  const state = await bootstrapPool.query<{ count: string; latest: string }>(`
    SELECT
      count(*)::text AS count,
      max(name) AS latest
    FROM pgmigrations
  `);
  expect(state.rows[0]).toEqual({ count: String(count), latest });
}

async function expectRoleExists(expected: boolean): Promise<void> {
  const role = await bootstrapPool.query<{ exists: boolean }>(`
    SELECT EXISTS (
      SELECT 1 FROM pg_roles WHERE rolname = 'classhub_local_admin'
    ) AS exists
  `);
  expect(role.rows[0]?.exists).toBe(expected);
}

async function expectFunctionClosed(functionName: string, roles: string[]): Promise<void> {
  const rolePrivileges = await bootstrapPool.query<{
    can_execute: boolean;
    role_name: string;
  }>(
    `
      SELECT
        role_name,
        has_function_privilege(
          role_name,
          format('public.%I()', $1::text),
          'EXECUTE'
        ) AS can_execute
      FROM unnest($2::text[]) AS role_name
      ORDER BY role_name
    `,
    [functionName, roles],
  );
  expect(rolePrivileges.rows).toEqual(
    roles
      .map((roleName) => ({ can_execute: false, role_name: roleName }))
      .toSorted((left, right) => left.role_name.localeCompare(right.role_name, "en")),
  );

  const publicPrivilege = await bootstrapPool.query<{ can_execute: boolean }>(
    `
      SELECT EXISTS (
        SELECT 1
        FROM pg_proc AS procedure
        JOIN pg_namespace AS namespace
          ON namespace.oid = procedure.pronamespace
        CROSS JOIN LATERAL aclexplode(
          COALESCE(procedure.proacl, acldefault('f', procedure.proowner))
        ) AS privilege
        WHERE namespace.nspname = 'public'
          AND procedure.proname = $1::text
          AND privilege.grantee = 0
          AND privilege.privilege_type = 'EXECUTE'
      ) AS can_execute
    `,
    [functionName],
  );
  expect(publicPrivilege.rows[0]?.can_execute).toBe(false);
}

async function expectTablesClosed(tableNames: string[], roles: string[]): Promise<void> {
  const privileges = await bootstrapPool.query<{
    has_any_privilege: boolean;
    role_name: string;
    table_name: string;
  }>(
    `
      SELECT
        role_name,
        table_name,
        (
          has_table_privilege(role_name, format('public.%I', table_name), 'SELECT')
          OR has_table_privilege(role_name, format('public.%I', table_name), 'INSERT')
          OR has_table_privilege(role_name, format('public.%I', table_name), 'UPDATE')
          OR has_table_privilege(role_name, format('public.%I', table_name), 'DELETE')
          OR has_table_privilege(role_name, format('public.%I', table_name), 'TRUNCATE')
          OR has_table_privilege(role_name, format('public.%I', table_name), 'REFERENCES')
          OR has_table_privilege(role_name, format('public.%I', table_name), 'TRIGGER')
        ) AS has_any_privilege
      FROM unnest($1::text[]) AS role_name
      CROSS JOIN unnest($2::text[]) AS table_name
      ORDER BY role_name, table_name
    `,
    [roles, tableNames],
  );
  expect(privileges.rows).toHaveLength(roles.length * tableNames.length);
  expect(privileges.rows.every((row) => row.has_any_privilege === false)).toBe(true);
}

async function expectAppPrivileges(): Promise<void> {
  const privileges = await bootstrapPool.query<{
    batches_insert: boolean;
    batches_select: boolean;
    notice_recipients_insert: boolean;
    notice_recipients_select: boolean;
    recipients_insert: boolean;
    recipients_member_update: boolean;
    recipients_resolved_update: boolean;
    recipients_select: boolean;
    supply_recipients_insert: boolean;
    supply_recipients_select: boolean;
  }>(`
    SELECT
      has_table_privilege(
        'classhub_app', 'in_app_reminder_batches', 'SELECT'
      ) AS batches_select,
      has_table_privilege(
        'classhub_app', 'in_app_reminder_batches', 'INSERT'
      ) AS batches_insert,
      has_table_privilege(
        'classhub_app', 'in_app_reminder_recipients', 'SELECT'
      ) AS recipients_select,
      has_table_privilege(
        'classhub_app', 'in_app_reminder_recipients', 'INSERT'
      ) AS recipients_insert,
      has_column_privilege(
        'classhub_app', 'in_app_reminder_recipients', 'resolved_at', 'UPDATE'
      ) AS recipients_resolved_update,
      has_column_privilege(
        'classhub_app', 'in_app_reminder_recipients', 'member_id', 'UPDATE'
      ) AS recipients_member_update,
      has_table_privilege(
        'classhub_app', 'notice_recipients', 'SELECT'
      ) AS notice_recipients_select,
      has_table_privilege(
        'classhub_app', 'notice_recipients', 'INSERT'
      ) AS notice_recipients_insert,
      has_table_privilege(
        'classhub_app', 'supply_recipients', 'SELECT'
      ) AS supply_recipients_select,
      has_table_privilege(
        'classhub_app', 'supply_recipients', 'INSERT'
      ) AS supply_recipients_insert
  `);
  expect(privileges.rows[0]).toEqual({
    batches_insert: true,
    batches_select: true,
    notice_recipients_insert: true,
    notice_recipients_select: true,
    recipients_insert: true,
    recipients_member_update: false,
    recipients_resolved_update: true,
    recipients_select: true,
    supply_recipients_insert: true,
    supply_recipients_select: true,
  });
}

async function expectAdminSecurityAuditReadPrivileges(): Promise<void> {
  const privileges = await bootstrapPool.query<{
    actor_email_hmac_select: boolean;
    actor_ip_select: boolean;
    event_id_select: boolean;
    user_agent_select: boolean;
  }>(`
    SELECT
      has_column_privilege(
        'classhub_app', 'security_audit_logs', 'event_id', 'SELECT'
      ) AS event_id_select,
      has_column_privilege(
        'classhub_app', 'security_audit_logs', 'actor_email_hmac', 'SELECT'
      ) AS actor_email_hmac_select,
      has_column_privilege(
        'classhub_app', 'security_audit_logs', 'actor_ip', 'SELECT'
      ) AS actor_ip_select,
      has_column_privilege(
        'classhub_app', 'security_audit_logs', 'user_agent', 'SELECT'
      ) AS user_agent_select
  `);
  expect(privileges.rows[0]).toEqual({
    actor_email_hmac_select: false,
    actor_ip_select: false,
    event_id_select: true,
    user_agent_select: false,
  });
}

beforeAll(async () => {
  container = await startNativeTestService("postgres", {
    POSTGRES_DB: "classhub_dev",
    POSTGRES_PASSWORD: "local_bootstrap_password",
    POSTGRES_USER: "classhub_bootstrap",
  });

  bootstrapPool = new Pool({
    connectionString: databaseUrl("classhub_bootstrap", "local_bootstrap_password"),
  });
  await bootstrapPool.query(await readFile(bootstrapPath, "utf8"));
  migratorDatabaseUrl = databaseUrl("classhub_migrator", "local_migrator_password");
}, 120_000);

afterAll(async () => {
  await bootstrapPool?.end();
  await container?.stop({ remove: true, removeVolumes: true });
}, 120_000);

describe.sequential("optional local-admin migration portability", () => {
  it("keeps ACLs closed when the development-only role exists", async () => {
    await migrate("up");
    await expectWalkedEveryMigration();
    await expectRoleExists(true);

    const closedRoles = [...mandatoryClosedRoles, "classhub_local_admin"];
    await expectFunctionClosed("enforce_in_app_reminder_recipient_resolution", closedRoles);
    await expectFunctionClosed("enforce_content_audience_mode_immutable", closedRoles);
    await expectFunctionClosed("enforce_profile_teacher_invariants", closedRoles);
    await expectTablesClosed(
      [
        "in_app_reminder_batches",
        "in_app_reminder_recipients",
        "notice_recipients",
        "supply_recipients",
      ],
      closedRoles.filter((roleName) => roleName !== "classhub_app"),
    );
    await expectAppPrivileges();
    await expectAdminSecurityAuditReadPrivileges();
  });

  it("applies every migration from 8000 up when the development-only role is absent", async () => {
    // 8000 직전 = 7000까지 적용된 8개 상태.
    await migrateDownTo(8);
    await bootstrapPool.query("DROP OWNED BY classhub_local_admin");
    await bootstrapPool.query("DROP ROLE classhub_local_admin");
    await expectRoleExists(false);

    await migrate("up", 1);
    await expectMigrationHead(9, "1783700008000_in-app-reminders");
    await expectRoleExists(false);
    await expectFunctionClosed(
      "enforce_in_app_reminder_recipient_resolution",
      mandatoryClosedRoles,
    );
    await expectTablesClosed(
      ["in_app_reminder_batches", "in_app_reminder_recipients"],
      mandatoryClosedRoles.filter((roleName) => roleName !== "classhub_app"),
    );

    await migrate("up", 1);
    await expectMigrationHead(10, "1783700009000_content-audiences");
    await expectRoleExists(false);
    await expectFunctionClosed(
      "enforce_in_app_reminder_recipient_resolution",
      mandatoryClosedRoles,
    );
    await expectFunctionClosed("enforce_content_audience_mode_immutable", mandatoryClosedRoles);
    await expectTablesClosed(
      [
        "in_app_reminder_batches",
        "in_app_reminder_recipients",
        "notice_recipients",
        "supply_recipients",
      ],
      mandatoryClosedRoles.filter((roleName) => roleName !== "classhub_app"),
    );
    await expectAppPrivileges();

    await migrate("up", 1);
    await expectMigrationHead(11, "1783700010000_operator-onboarding-privileges");
    await expectRoleExists(false);
    await expectFunctionClosed("enforce_profile_teacher_invariants", mandatoryClosedRoles);

    await migrate("up", 1);
    await expectMigrationHead(12, "1783700011000_neis-meal-source");
    await expectRoleExists(false);

    await migrate("up", 1);
    await expectMigrationHead(13, "1783700012000_neis-meal-calorie");
    await expectRoleExists(false);

    await migrate("up", 1);
    await expectMigrationHead(14, "1783700013000_neis-school-schedules");
    await expectRoleExists(false);

    await migrate("up", 1);
    await expectMigrationHead(15, "1783700014000_neis-school-details");
    await expectRoleExists(false);

    await migrate("up", 1);
    await expectMigrationHead(16, "1783700015000_student-assessment-records");
    await expectRoleExists(false);

    await migrate("up", 1);
    await expectMigrationHead(17, "1783700016000_class-polls");
    await expectRoleExists(false);

    await migrate("up", 1);
    await expectMigrationHead(18, "1783700017000_seat-draws");
    await expectRoleExists(false);

    await migrate("up", 1);
    await expectMigrationHead(19, "1783700018000_team-draws");
    await expectRoleExists(false);

    await migrate("up", 1);
    await expectMigrationHead(20, "1783700019000_seat-draw-adjustment-audit");
    await expectRoleExists(false);

    await migrate("up", 1);
    await expectMigrationHead(21, "1783700020000_team-draw-adjustment-audit");
    await expectRoleExists(false);

    await migrate("up", 1);
    await expectMigrationHead(22, "1783700021000_poll-visibility-and-results-policy");
    await expectRoleExists(false);

    await migrate("up", 1);
    await expectMigrationHead(23, "1783700022000_operator-teacher-password-reset");
    await expectRoleExists(false);

    await migrate("up", 1);
    await expectMigrationHead(24, "1783700023000_temporary-password-reminder");
    await expectRoleExists(false);

    await migrate("up", 1);
    await expectMigrationHead(25, "1783700024000_operator-class-transfer");
    await expectRoleExists(false);

    await migrate("up", 1);
    await expectMigrationHead(26, "1783700025000_operator-reissue-cooldown");
    await expectRoleExists(false);

    await migrate("up", 1);
    await expectMigrationHead(27, "1783700026000_operator-class-transfer-audit");
    await expectRoleExists(false);

    await migrate("up", 1);
    await expectMigrationHead(28, "1783700027000_retention-job-visibility");
    await expectRoleExists(false);

    await migrate("up", 1);
    await expectMigrationHead(29, "1783700028000_class-duty-rosters");
    await expectRoleExists(false);

    await migrate("up", 1);
    await expectMigrationHead(30, "1783700029000_supply-categories");
    await expectRoleExists(false);

    await migrate("up", 1);
    await expectMigrationHead(31, "1783700030000_audit-action-catalog");
    await expectRoleExists(false);

    await migrate("up", 1);
    await expectMigrationHead(32, "1783700031000_class-elections");
    await expectRoleExists(false);

    await migrate("up", 1);
    await expectMigrationHead(33, "1783700032000_election-results");
    await expectRoleExists(false);

    await migrate("up", 1);
    await expectMigrationHead(34, "1783700033000_layout-draft-autosaves");
    await expectRoleExists(false);

    await migrate("up", 1);
    await expectMigrationHead(35, "1783700034000_layout-draft-autosave-retention-grants");
    await expectRoleExists(false);

    await migrate("up", 1);
    await expectMigrationHead(36, "1783700035000_classroom-layout-templates");
    await expectRoleExists(false);

    await migrate("up", 1);
    await expectMigrationHead(37, "1783700036000_election-participants-erasure");
    await expectRoleExists(false);

    await migrate("up", 1);
    await expectMigrationHead(38, "1783700037000_public-holidays");
    await expectRoleExists(false);

    await migrate("up", 1);
    await expectMigrationHead(39, "1783700038000_guardian-consent-requests");
    await expectRoleExists(false);

    await migrate("up", 1);
    await expectMigrationHead(40, "1783700039000_operator-suspended-class-transfer");
    await expectRoleExists(false);

    await migrate("up", 1);
    await expectMigrationHead(41, "1783700040000_password-input-version");
    await expectRoleExists(false);

    await migrate("up", 1);
    await expectMigrationHead(42, "1783700041000_admin-auth-foundation");
    await expectRoleExists(false);

    await migrate("up", 1);
    await expectMigrationHead(43, "1783700042000_admin-signup-approval");
    await expectRoleExists(false);

    await migrate("up", 1);
    await expectMigrationHead(44, "1783700043000_admin-inquiries-system-state");
    await expectRoleExists(false);

    await migrate("up", 1);
    await expectMigrationHead(45, "1783700044000_admin-terms-management");
    await expectRoleExists(false);

    await migrate("up", 1);
    await expectMigrationHead(46, "1783700045000_admin-account-management");
    await expectRoleExists(false);

    await migrate("up", 1);
    await expectMigrationHead(47, "1783700046000_admin-security-audit-read");
    await expectRoleExists(false);
    await expectAdminSecurityAuditReadPrivileges();

    await migrate("up", 1);
    await expectMigrationHead(48, "1783700047000_admin-session-renewal");
    await expectRoleExists(false);

    await migrate("up", 1);
    await expectMigrationHead(49, "1783700048000_signup-role");
    await expectRoleExists(false);

    await migrate("up", 1);
    await expectMigrationHead(50, "1783700049000_admin-request-limit-policy");
    await expectRoleExists(false);

    await migrate("up", 1);
    await expectMigrationHead(51, "1783700050000_signup-email-management");
    await expectRoleExists(false);
    await expectTablesClosed(
      ["mail_templates", "mail_delivery_logs"],
      ["classhub_worker", "classhub_retention", "classhub_operator"],
    );

    await migrate("up", 1);
    await expectMigrationHead(52, "1783700051000_legal-consent-snapshots");
    await expectRoleExists(false);

    await migrate("up", 1);
    await expectMigrationHead(53, "1783700052000_poll-manual-close");
    await expectRoleExists(false);

    const nonApplicationRoles = ["classhub_worker", "classhub_retention", "classhub_operator"];

    await migrate("up", 1);
    await expectMigrationHead(54, "1783700053000_push-subscriptions");
    await expectRoleExists(false);
    await expectTablesClosed(["push_subscriptions"], nonApplicationRoles);

    await migrate("up", 1);
    await expectMigrationHead(55, "1783700054000_push-deliveries");
    await expectRoleExists(false);
    await expectTablesClosed(["push_deliveries"], nonApplicationRoles);

    await migrate("up", 1);
    await expectMigrationHead(56, "1783700055000_schedule-links");
    await expectRoleExists(false);
    await expectTablesClosed(
      ["schedule_notice_links", "schedule_supply_links"],
      nonApplicationRoles,
    );

    await migrate("up", 1);
    await expectMigrationHead(57, "1783700056000_help-requests");
    await expectRoleExists(false);
    await expectTablesClosed(["help_requests"], nonApplicationRoles);

    // 2026-10-01: 09-26 교사 자료함부터 걸음이 늘지 않아 아래 덫이 계속 실패하던 것을 채운다.
    // 각 단계의 새 표는 앱 역할 전용이고 작업자·보존·운영자 역할에는 닫혀 있어야 한다.
    await migrate("up", 1);
    await expectMigrationHead(58, "1783700057000_teacher-library");
    await expectRoleExists(false);
    await expectTablesClosed(["teacher_library_items"], nonApplicationRoles);

    await migrate("up", 1);
    await expectMigrationHead(59, "1783700058000_help-chat");
    await expectRoleExists(false);
    await expectTablesClosed(["help_request_messages"], nonApplicationRoles);

    await migrate("up", 1);
    await expectMigrationHead(60, "1783700059000_profile-photos");
    await expectRoleExists(false);
    await expectTablesClosed(["user_profile_photos"], nonApplicationRoles);

    await migrate("up", 1);
    await expectMigrationHead(61, "1783700061000_admin-passkeys");
    await expectRoleExists(false);
    await expectTablesClosed(
      ["admin_passkeys", "admin_recovery_codes", "admin_webauthn_challenges", "admin_mfa_stepups"],
      nonApplicationRoles,
    );

    await migrate("up", 1);
    await expectMigrationHead(62, "1783700062000_social-login");
    await expectRoleExists(false);
    await expectTablesClosed(["social_identities", "social_oauth_flows"], nonApplicationRoles);

    await migrate("up", 1);
    await expectMigrationHead(63, "1783700070000_class-chat");
    await expectRoleExists(false);
    await expectTablesClosed(
      ["class_chat_rooms", "class_chat_messages", "class_chat_mutes", "class_chat_reports"],
      nonApplicationRoles,
    );

    // 세션 강제 종료 기록값·생년월일 칸은 새 표 없이 기존 표만 바꾼다.
    await migrate("up", 1);
    await expectMigrationHead(64, "1783700071000_admin-session-revoke");
    await expectRoleExists(false);

    await migrate("up", 1);
    await expectMigrationHead(65, "1783700072000_user-birth-dates");
    await expectRoleExists(false);

    await migrate("up", 1);
    await expectMigrationHead(66, "1783700073000_admin-access-logs");
    await expectRoleExists(false);
    await expectTablesClosed(["admin_access_logs"], nonApplicationRoles);

    // 투표 수정은 새 표 없이 감사 종류 한 줄과 기존 표의 열 권한만 더한다.
    await migrate("up", 1);
    await expectMigrationHead(67, "1783700074000_poll-edit");
    await expectRoleExists(false);

    // 새 마이그레이션이 추가됐는데 위에 걸음을 안 늘렸다면 여기서 걸린다.
    await expectWalkedEveryMigration();
  });

  it("refuses to roll back the administrator foundation while account data exists", async () => {
    await migrateDownTo(42);

    const operator = await bootstrapPool.query<{ id: string }>(`
      INSERT INTO operators (email_normalized, credential_hash)
      VALUES ('rollback-guard@example.test', decode(repeat('ab', 32), 'hex'))
      RETURNING id::text AS id
    `);
    await bootstrapPool.query(
      `
        INSERT INTO admin_accounts (
          email_normalized, display_name, password_hash, created_by_operator_id
        )
        VALUES ('admin-rollback-guard@example.test', 'Rollback Guard', 'test-only-hash', $1)
      `,
      [operator.rows[0]!.id],
    );

    await expect(migrate("down", 1)).rejects.toThrow(/admin_accounts still holds rows/u);
    await expectMigrationHead(42, "1783700041000_admin-auth-foundation");

    await bootstrapPool.query(
      "DELETE FROM admin_accounts WHERE email_normalized = 'admin-rollback-guard@example.test'",
    );
    await bootstrapPool.query(
      "DELETE FROM operators WHERE email_normalized = 'rollback-guard@example.test'",
    );
    await migrate("down", 1);
    await expectMigrationHead(41, "1783700040000_password-input-version");
    await migrate("up", 1);
    await expectMigrationHead(42, "1783700041000_admin-auth-foundation");
    await migrate("up");
    await expectWalkedEveryMigration();
  });
});

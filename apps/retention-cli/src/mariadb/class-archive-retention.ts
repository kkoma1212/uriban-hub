import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import type { RetentionDatabase } from "../database.js";
import type { RetentionMode } from "../student-assessment-retention.js";
import { RetentionMariaDbError } from "./errors.js";
import { recordMariaDbAudit } from "./job-audit.js";
import { countValue, dateValue, positiveInteger } from "./values.js";
import { classArchiveSchemaContract } from "./class-archive-schema-contract.js";
import { classArchiveInstallationContract } from "./class-archive-installation-contract.js";

// Children precede parents. The legacy layout tables are intentionally included if installed.
// Audit tables retain their independent expiry; teacher_library_items is an independent copy.
export const classArchiveDeletionOrder = [
  "class_chat_reports",
  "class_chat_messages",
  "class_chat_mutes",
  "class_chat_rooms",
  "help_request_messages",
  "help_requests",
  "in_app_reminder_recipients",
  "in_app_reminder_batches",
  "push_deliveries",
  "schedule_notice_links",
  "schedule_supply_links",
  "notice_reads",
  "notice_recipients",
  "supply_checks",
  "supply_recipients",
  "poll_votes",
  "poll_options",
  "polls",
  "election_tallies",
  "election_participants",
  "election_candidates",
  "elections",
  "seat_draw_assignments",
  "seat_draw_slots",
  "seat_draws",
  "team_draw_assignments",
  "team_draw_groups",
  "team_draws",
  "duty_assignments",
  "duty_rosters",
  "class_duty_roles",
  "layout_draft_autosaves",
  "classroom_layout_templates",
  "attendance_notifications",
  "notices",
  "supplies",
  "schedules",
  "student_assessment_records",
  "class_invite_codes",
  "class_member_status_history",
  "class_members",
] as const;
const legacyTables = new Set<string>([
  "seat_draw_assignments",
  "seat_draw_slots",
  "seat_draws",
  "team_draw_assignments",
  "team_draw_groups",
  "team_draws",
  "duty_assignments",
  "duty_rosters",
  "class_duty_roles",
  "layout_draft_autosaves",
  "classroom_layout_templates",
]);

function scope(table: string, classId: string) {
  if (table === "poll_options")
    return sql`poll_id IN (SELECT id FROM polls WHERE class_id=${classId})`;
  if (table === "election_tallies")
    return sql`election_id IN (SELECT id FROM elections WHERE class_id=${classId})`;
  return sql`class_id=${classId}`;
}
const eligible = (cutoff: string) => sql`BINARY status=BINARY 'archived'
  AND archived_at<=${cutoff} AND retention_purged_at IS NULL`;

/** Requires reviewed shell/schema + exact ACL installation. No operational application is implicit. */
export async function runMariaDbClassArchiveRetention(
  database: RetentionDatabase,
  options: { mode: RetentionMode; maxClasses?: number; runId?: string },
) {
  if (!["dry-run", "execute"].includes(options.mode))
    throw new RetentionMariaDbError("invalid_mode");
  const maxClasses = positiveInteger(options.maxClasses ?? 20, "maxClasses");
  const clock = (
    await sql<{ started_at: string; cutoff_at: string }>`SELECT
    DATE_FORMAT(UTC_TIMESTAMP(6), '%Y-%m-%d %H:%i:%s.%f') AS started_at,
    DATE_FORMAT(UTC_TIMESTAMP(6) - INTERVAL 365 DAY, '%Y-%m-%d %H:%i:%s.%f') AS cutoff_at`.execute(
      database,
    )
  ).rows[0];
  dateValue(clock?.started_at);
  dateValue(clock?.cutoff_at);
  if (!clock) throw new RetentionMariaDbError("invalid_result");
  // The locked, metadata-only definer sees even tables this caller cannot SELECT.
  // Otherwise MariaDB would silently hide future dependencies from the schema guard.
  const probe = (await sql`CALL class_archive_schema_inventory()`.execute(database))
    .rows as unknown;
  const probeRows = Array.isArray(probe) && Array.isArray(probe[0]) ? probe[0] : null;
  const inventory =
    probeRows?.length === 1
      ? (probeRows[0] as {
          database_name?: unknown;
          tables_json?: unknown;
          references_json?: unknown;
          installation_json?: unknown;
        })
      : null;
  if (
    !inventory ||
    typeof inventory.database_name !== "string" ||
    typeof inventory.tables_json !== "string" ||
    typeof inventory.references_json !== "string" ||
    typeof inventory.installation_json !== "string"
  )
    throw new RetentionMariaDbError("configuration");
  const tableNames: unknown = JSON.parse(inventory.tables_json);
  const allReferences: unknown = JSON.parse(inventory.references_json);
  const installation: unknown = JSON.parse(inventory.installation_json);
  if (!Array.isArray(installation)) throw new RetentionMariaDbError("configuration");
  if (
    !Array.isArray(tableNames) ||
    !tableNames.every((name) => typeof name === "string") ||
    !Array.isArray(allReferences)
  )
    throw new RetentionMariaDbError("configuration");
  const installed = new Set<string>(tableNames);
  const expectedInstallation = classArchiveInstallationContract.filter(
    (artifact) =>
      artifact.version !== 113 || [...legacyTables].some((table) => installed.has(table)),
  );
  if (
    installation.length !== expectedInstallation.length ||
    expectedInstallation.some(
      (artifact) =>
        !installation.some(
          (entry) =>
            entry &&
            typeof entry === "object" &&
            Object.keys(entry).length === 3 &&
            String(entry.version) === String(artifact.version) &&
            entry.description === artifact.description &&
            entry.sha256 === artifact.sha256,
        ),
    )
  )
    throw new RetentionMariaDbError("configuration");
  const requiredTables = [
    "classes",
    "audit_logs",
    "security_audit_logs",
    ...classArchiveDeletionOrder.filter((table) => !legacyTables.has(table)),
  ];
  if (requiredTables.some((table) => !installed.has(table)))
    throw new RetentionMariaDbError("configuration");
  // Match column/FK/delete-rule and the complete shell definition. New personal shell
  // columns, changed cascades, removed tables or unknown descendants fail before mutation.
  const classColumns = (
    await sql`SELECT COLUMN_NAME AS name,COLUMN_TYPE AS type,IS_NULLABLE AS nullable,EXTRA AS extra
    FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='classes' ORDER BY ORDINAL_POSITION`.execute(
      database,
    )
  ).rows;
  // Column-scoped writers cannot see CHECK_CONSTRAINTS; SELECT permits SHOW CREATE
  // without granting ALTER or broad UPDATE.
  const classDefinition = (
    await sql<Record<string, string>>`SHOW CREATE TABLE classes`.execute(database)
  ).rows[0]?.["Create Table"]?.replace(/ AUTO_INCREMENT=\d+/gu, "");
  const protectedTables = new Set<string>(["classes", ...classArchiveDeletionOrder]);
  const observedReferences = allReferences
    .map((row) => {
      if (
        !row ||
        typeof row !== "object" ||
        Object.keys(row).length !== 7 ||
        ![
          "table_schema",
          "table_name",
          "constraint_name",
          "column_name",
          "referenced_table",
          "referenced_column",
          "delete_rule",
        ].every((key) => typeof row[key] === "string")
      )
        throw new RetentionMariaDbError("configuration");
      if (row.table_schema !== inventory.database_name && protectedTables.has(row.referenced_table))
        throw new RetentionMariaDbError("configuration");
      const { table_schema: _schema, ...reference } = row;
      return reference as Record<string, string>;
    })
    .filter((row) => row.table_name === "classes" || protectedTables.has(row.referenced_table!));
  const canonicalReferences = (rows: readonly object[]) =>
    rows.map((row) => JSON.stringify(row)).sort();
  const expectedReferences = classArchiveSchemaContract.references.filter((row) =>
    installed.has(row.table_name),
  );
  if (
    JSON.stringify(classColumns) !== JSON.stringify(classArchiveSchemaContract.classColumns) ||
    classDefinition !== classArchiveSchemaContract.classDefinition ||
    JSON.stringify(canonicalReferences(observedReferences)) !==
      JSON.stringify(canonicalReferences(expectedReferences))
  )
    throw new RetentionMariaDbError("configuration");
  const tables = classArchiveDeletionOrder.filter((table) => installed.has(table));
  const countEligible = async () =>
    countValue(
      (
        await sql<{ count: string }>`SELECT CAST(COUNT(*) AS CHAR) AS count
    FROM classes WHERE ${eligible(clock.cutoff_at)}`.execute(database)
      ).rows[0]?.count,
    );
  const initial = await countEligible();
  const unlinked = countValue(
    (
      await sql<{ count: string }>`SELECT CAST(COUNT(*) AS CHAR) AS count
    FROM student_assessment_records WHERE class_id IS NULL`.execute(database)
    ).rows[0]?.count,
  );
  const candidates = (
    await sql<{ id: string }>`SELECT CAST(id AS CHAR) AS id FROM classes
    WHERE ${eligible(clock.cutoff_at)} ORDER BY archived_at,id LIMIT ${maxClasses}`.execute(
      database,
    )
  ).rows;
  const counts: Record<string, number> = Object.fromEntries(tables.map((table) => [table, 0]));
  let purged = 0;
  const runId = options.mode === "execute" ? (options.runId ?? randomUUID()) : null;
  for (const candidate of candidates) {
    if (!/^\d+$/u.test(candidate.id)) throw new RetentionMariaDbError("invalid_result");
    if (options.mode === "dry-run") {
      for (const table of tables)
        counts[table]! += countValue(
          (
            await sql<{ count: string }>`SELECT CAST(COUNT(*) AS CHAR) AS count
        FROM ${sql.table(table)} WHERE ${scope(table, candidate.id)}`.execute(database)
          ).rows[0]?.count,
        );
      continue;
    }
    const deleted = await database.transaction().execute(async (transaction) => {
      // A transaction-owned class row lock avoids connection-scoped GET_LOCK leaks and serializes parallel runners.
      const locked =
        await sql`SELECT id FROM classes WHERE id=${candidate.id} AND ${eligible(clock.cutoff_at)} FOR UPDATE`.execute(
          transaction,
        );
      if (locked.rows.length === 0) return null;
      const local: Record<string, number> = {};
      if (installed.has("elections")) {
        // Break the winner/candidate FK cycle without disabling FK checks. Everything commits with erasure.
        await sql`UPDATE elections SET status='closed', winner_candidate_id=NULL
          WHERE class_id=${candidate.id}`.execute(transaction);
      }
      for (const table of tables)
        local[table] = countValue(
          (
            await sql`DELETE FROM ${sql.table(table)}
        WHERE ${scope(table, candidate.id)}`.execute(transaction)
          ).numAffectedRows,
        );
      const updated = await sql`UPDATE classes SET name='종료된 반', academic_year=NULL, grade=NULL,
        edu_office_code=NULL, school_code=NULL, expected_student_count=NULL, created_by_user_id=NULL,
        suspended_reason=NULL, suspended_at=NULL, suspended_by_operator_id=NULL,
        archived_by_user_id=NULL, archived_by_operator_id=NULL,
        retention_purged_at=${clock.started_at}, updated_at=${clock.started_at}, row_version=row_version+1
        WHERE id=${candidate.id} AND ${eligible(clock.cutoff_at)}`.execute(transaction);
      if (countValue(updated.numAffectedRows) !== 1)
        throw new RetentionMariaDbError("invalid_result");
      await recordMariaDbAudit(
        transaction,
        "retention.executed",
        `class_archives:${candidate.id}`,
        {
          cutoff_at: clock.cutoff_at,
          table_name: "class_archives",
          deleted_count: Object.values(local).reduce((a, b) => a + b, 0),
        },
        runId!,
        clock.started_at,
      );
      return local;
    });
    if (deleted) {
      purged++;
      for (const table of tables) counts[table]! += deleted[table]!;
    }
  }
  const remaining = options.mode === "execute" ? await countEligible() : initial;
  return {
    table_name: "class_archives",
    mode: options.mode,
    run_id: runId,
    cutoff_at: clock.cutoff_at,
    eligible_count: initial,
    purged_class_count: purged,
    deleted_count:
      options.mode === "execute" ? Object.values(counts).reduce((a, b) => a + b, 0) : 0,
    table_counts: counts,
    unlinked_assessment_count: unlinked,
    remaining_eligible_count: remaining,
    capped: options.mode === "execute" ? remaining > 0 : initial > maxClasses,
  };
}

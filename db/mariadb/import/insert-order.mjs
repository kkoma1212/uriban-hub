import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { buildInstallPostconditionCatalog } from "../ledger/install-postconditions.mjs";
import { inspectMariaDbSemanticSql } from "../ledger/active-semantic-sql.mjs";
import { importFailure } from "./value-codecs.mjs";

const requireContract = (condition, coordinate) => {
  if (!condition) importFailure(`insert_order.${coordinate}`);
};
const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value !== null && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical(value[key])]),
        )
      : value;
const digest = (value) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
const same = (actual, expected, coordinate) =>
  requireContract(isDeepStrictEqual(actual, expected), coordinate);
const ordered = (values) => [...values].sort();
const identifier = (value, coordinate) => {
  requireContract(typeof value === "string" && /^[a-z_][a-z0-9_]*$/u.test(value), coordinate);
  return value;
};
const requireHash = (record, field, coordinate) => {
  requireContract(record && typeof record === "object", coordinate);
  const { [field]: expected, ...body } = record;
  same(digest(body), expected, coordinate);
};

const reviewedTriggerProfiles = {
  audit_logs_actor_class_validate: {
    table: "audit_logs",
    event: "INSERT",
    reads: ["class_members"],
  },
  class_member_status_history_validate: {
    table: "class_member_status_history",
    event: "INSERT",
    reads: ["class_members"],
  },
  elections_tie_break_immutable: { table: "elections", event: "UPDATE", reads: [] },
  in_app_reminder_recipients_resolution_guard: {
    table: "in_app_reminder_recipients",
    event: "UPDATE",
    reads: [],
  },
  notices_audience_mode_immutable: { table: "notices", event: "UPDATE", reads: [] },
  supplies_audience_mode_immutable: { table: "supplies", event: "UPDATE", reads: [] },
};

/** Classify only the six pinned trigger definitions. Any new object read,
 * routine call or table write requires a fresh insertion review.
 */
export function reviewImportInsertTriggers(triggers) {
  same(
    ordered(Object.keys(triggers)),
    ordered(Object.keys(reviewedTriggerProfiles)),
    "trigger_set",
  );
  return Object.entries(reviewedTriggerProfiles).map(([name, profile]) => {
    const actual = triggers[name];
    same(
      [actual.name, actual.table, actual.event, actual.timing, actual.definer],
      [name, profile.table, profile.event, "BEFORE", "classhub_routine@%"],
      `trigger.${name}.header`,
    );
    let inspection;
    try {
      inspection = inspectMariaDbSemanticSql(actual.body);
    } catch {
      importFailure(`insert_order.trigger.${name}.unreviewed_sql`);
    }
    same(inspection.definitions, [], `trigger.${name}.definitions`);
    same(inspection.mutations, [], `trigger.${name}.mutations`);
    requireContract(
      !/\bnew\s*\.\s*[a-z_][a-z0-9_]*\s*(?::=|=)/iu.test(actual.body),
      `trigger.${name}.new_row_assignment`,
    );
    same(
      inspection.references
        .map(({ kind, object }) => ({ kind, object }))
        .sort((a, b) => a.object.localeCompare(b.object)),
      profile.reads.map((object) => ({ kind: "table_read", object })),
      `trigger.${name}.references`,
    );
    return {
      name,
      table: actual.table,
      event: actual.event,
      timing: actual.timing,
      table_reads: [...profile.reads],
      routine_calls: [],
      table_writes: [],
      source_body_sha256: digest(actual.body),
    };
  });
}

/** Data-free graph analysis. Edges point from child to required parent. */
export function analyzeImportForeignKeys(tables) {
  const names = tables.map((table) => identifier(table.table, "graph.table"));
  same(new Set(names).size, names.length, "graph.duplicate_table");
  const edges = tables.flatMap((table) =>
    table.foreign_keys.map((fk) => {
      const name = identifier(fk.name, "graph.constraint"),
        parent = identifier(fk.target_table, "graph.parent");
      requireContract(names.includes(parent), `graph.${table.table}.${name}.unknown_parent`);
      requireContract(
        fk.columns.length > 0 && fk.columns.length === fk.target_columns.length,
        `graph.${table.table}.${name}.columns`,
      );
      fk.columns.forEach((column) => identifier(column, "graph.column"));
      fk.target_columns.forEach((column) => identifier(column, "graph.target_column"));
      return {
        coordinate: `${table.table}.${name}`,
        child_table: table.table,
        columns: [...fk.columns],
        parent_table: parent,
        parent_columns: [...fk.target_columns],
      };
    }),
  );
  same(new Set(edges.map((edge) => edge.coordinate)).size, edges.length, "graph.duplicate_fk");
  const parents = new Map(
    names.map((name) => [
      name,
      ordered(
        new Set(edges.filter((edge) => edge.child_table === name).map((edge) => edge.parent_table)),
      ),
    ]),
  );
  let nextIndex = 0;
  const visited = new Map(),
    low = new Map(),
    stack = [],
    onStack = new Set(),
    components = [];
  function visit(node) {
    visited.set(node, nextIndex);
    low.set(node, nextIndex++);
    stack.push(node);
    onStack.add(node);
    for (const parent of parents.get(node)) {
      if (!visited.has(parent)) {
        visit(parent);
        low.set(node, Math.min(low.get(node), low.get(parent)));
      } else if (onStack.has(parent)) low.set(node, Math.min(low.get(node), visited.get(parent)));
    }
    if (low.get(node) === visited.get(node)) {
      const component = [];
      let member;
      do {
        member = stack.pop();
        onStack.delete(member);
        component.push(member);
      } while (member !== node);
      components.push(ordered(component));
    }
  }
  for (const node of ordered(names)) if (!visited.has(node)) visit(node);
  const cycles = components
    .filter((group) => group.length > 1 || parents.get(group[0]).includes(group[0]))
    .sort((a, b) => a.join(".").localeCompare(b.join(".")));
  return { table_count: names.length, foreign_key_count: edges.length, edges, cycles };
}

function dependencyWaves(names, edges) {
  const remaining = new Set(names),
    finished = new Set(),
    waves = [];
  while (remaining.size > 0) {
    const ready = ordered(
      [...remaining].filter((table) =>
        edges
          .filter((edge) => edge.child_table === table)
          .every((edge) => finished.has(edge.parent_table)),
      ),
    );
    requireContract(ready.length > 0, "graph.unreviewed_cycle");
    waves.push(ready);
    for (const table of ready) {
      remaining.delete(table);
      finished.add(table);
    }
  }
  return waves;
}

/** Read-only plan, conditional on actual source winner/creator preflight.
 * It contains no INSERT/UPDATE SQL and never rewrites a source row.
 */
export function buildImportInsertOrderPlan(
  importPlan,
  {
    winnerForeignKeyMode = "preserve_installed",
    installation = buildInstallPostconditionCatalog(),
  } = {},
) {
  requireContract(
    ["preserve_installed", "recreate_after_exact_insert"].includes(winnerForeignKeyMode),
    "winner_foreign_key_mode",
  );
  requireHash(importPlan, "plan_sha256", "mapping_plan_checksum");
  same(importPlan.runtime_plan_sha256, installation.plan.plan_sha256, "runtime_plan_checksum");
  same(
    ordered(importPlan.tables.map((table) => table.table)),
    ordered(installation.plan.product_tables),
    "table_set",
  );
  for (const table of importPlan.tables)
    same(
      table.foreign_keys,
      Object.values(installation.final.tables[table.table].foreign_keys),
      `table.${table.table}.foreign_keys`,
    );
  const triggers = reviewImportInsertTriggers(installation.final.triggers);
  const graph = analyzeImportForeignKeys(importPlan.tables);
  same(graph.cycles, [["admin_accounts"], ["election_candidates", "elections"]], "reviewed_cycles");
  const adminCreator = "admin_accounts.admin_accounts_admin_creator_fk";
  const electionWinner = "elections.elections_winner_candidate_foreign_key";
  const winnerFk =
    installation.final.tables.elections.foreign_keys.elections_winner_candidate_foreign_key;
  same(
    winnerFk,
    {
      name: "elections_winner_candidate_foreign_key",
      columns: ["winner_candidate_id", "id"],
      target_table: "election_candidates",
      target_columns: ["id", "election_id"],
      delete_rule: "RESTRICT",
      update_rule: "RESTRICT",
    },
    "elections.exact_winner_constraint",
  );
  const handled = new Set([adminCreator, electionWinner]);
  const remainingEdges = graph.edges.filter((edge) => !handled.has(edge.coordinate));
  // INSERT-trigger reads must precede the trigger's table even if a future FK
  // is nullable. These reads already coincide with the reviewed FK graph today.
  const triggerEdges = triggers
    .filter((trigger) => trigger.event === "INSERT")
    .flatMap((trigger) =>
      trigger.table_reads.map((parent) => ({ child_table: trigger.table, parent_table: parent })),
    );
  const stagingDependencies = [
    {
      child_table: "classes",
      parent_table: "teacher_profiles",
      reason: "stage_teacher_profiles_before_class_construction",
    },
  ];
  const waves = dependencyWaves(
    importPlan.tables.map((table) => table.table),
    [...remainingEdges, ...triggerEdges, ...stagingDependencies],
  );
  const record = {
    schema_version: 1,
    status: "conditional_exact_value_insert_order",
    executable: false,
    winner_foreign_key_mode: winnerForeignKeyMode,
    import_plan_sha256: importPlan.plan_sha256,
    runtime_plan_sha256: installation.plan.plan_sha256,
    table_count: graph.table_count,
    foreign_key_count: graph.foreign_key_count,
    graph_cycles: graph.cycles,
    dependency_waves: waves,
    candidate_table_order: waves.flat(),
    staging_dependencies: stagingDependencies,
    triggers,
    preflight: {
      source_context: "isolated_restored_backup_without_writers",
      election_winner_count_sql:
        'SELECT COUNT(*)::text AS violating_count FROM "public"."elections" WHERE "winner_candidate_id" IS NOT NULL',
      required_election_winner_count: winnerForeignKeyMode === "preserve_installed" ? "0" : null,
      election_cycle_coordinates: [
        electionWinner,
        "election_candidates.election_candidates_election_class_foreign_key",
      ],
      election_cycle_reason: "non_null_winner_requires_candidate_which_requires_the_same_election",
      admin_creator_projection_sql:
        'SELECT "id"::text AS "id", "created_by_admin_account_id"::text AS "created_by_admin_account_id" FROM "public"."admin_accounts"',
      admin_creator_row_policy: "parent_first_indices_from_orderAdminCreatorRows",
      admin_creator_coordinate: adminCreator,
    },
    constraint_recreation:
      winnerForeignKeyMode === "preserve_installed"
        ? null
        : {
            table: "elections",
            ...winnerFk,
            drop_sql:
              "ALTER TABLE `elections` DROP FOREIGN KEY `elections_winner_candidate_foreign_key`",
            add_sql:
              "ALTER TABLE `elections` ADD CONSTRAINT `elections_winner_candidate_foreign_key` FOREIGN KEY (`winner_candidate_id`, `id`) REFERENCES `election_candidates` (`id`, `election_id`) ON DELETE RESTRICT ON UPDATE RESTRICT",
            verify_sql:
              "SELECT k.TABLE_NAME AS table_name, k.CONSTRAINT_NAME AS constraint_name, CAST(k.ORDINAL_POSITION AS CHAR) AS ordinal, k.COLUMN_NAME AS column_name, k.REFERENCED_TABLE_NAME AS target_table, k.REFERENCED_COLUMN_NAME AS target_column, r.UPDATE_RULE AS update_rule, r.DELETE_RULE AS delete_rule FROM information_schema.KEY_COLUMN_USAGE k JOIN information_schema.REFERENTIAL_CONSTRAINTS r ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.TABLE_NAME = k.TABLE_NAME AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME WHERE k.CONSTRAINT_SCHEMA = DATABASE() AND k.TABLE_NAME = 'elections' AND k.CONSTRAINT_NAME = 'elections_winner_candidate_foreign_key' ORDER BY k.ORDINAL_POSITION",
            installed_rows: winnerFk.columns.map((column, index) => ({
              table_name: "elections",
              constraint_name: winnerFk.name,
              ordinal: String(index + 1),
              column_name: column,
              target_table: winnerFk.target_table,
              target_column: winnerFk.target_columns[index],
              update_rule: winnerFk.update_rule,
              delete_rule: winnerFk.delete_rule,
            })),
            dropped_rows: [],
            required_session: {
              foreign_key_checks: "1",
              unique_checks: "1",
              check_constraint_checks: "1",
            },
            phases: [
              "attest_empty_non_seed_target_exclusive_lock_inactive_runtime_source_backup",
              "verify_exact_installed_fk_then_drop_before_row_transaction",
              "verify_only_this_fk_absent_preserve_all_other_schema_constraints",
              "insert_and_compare_exact_rows_assert_class_invariants_commit",
              "add_exact_fk_with_checks_enabled_db_validates_existing_rows",
              "verify_exact_fk_and_full_native_schema_values_grants_sequences_before_activation",
            ],
            drop_is_transactional: false,
            add_is_transactional: false,
            failure_boundary:
              "keep_runtime_inactive_and_rebuild_owned_target_from_preserved_source_backup",
          },
    class_invariant_assertion: {
      dependencies: ["users", "teacher_profiles", "classes", "class_members", "class_invite_codes"],
      target_class_projection_sql: "SELECT CAST(id AS CHAR) AS id FROM classes ORDER BY classes.id",
      call_sql: "CALL assert_class_invariants(?)",
      timing: "after_all_exact_inserts_before_commit",
      required_session_isolation: "READ-COMMITTED",
      caller_transaction_required: true,
      row_locks: true,
      row_mutations: false,
      source_body_sha256: digest(installation.final.routines.assert_class_invariants.body),
    },
    protected_transition_routines_not_called: ordered(
      Object.values(installation.final.routines)
        .filter((routine) => routine.access === "MODIFIES SQL DATA")
        .map((routine) => routine.name),
    ),
    seed_comparison_table: "audit_log_actions",
    constraint_checks_disabled: false,
    source_value_mutations: false,
    database_io: false,
  };
  return { ...record, order_plan_sha256: digest(record) };
}

/** Return indices only; IDs and private row contents are never placed in errors.
 * Self-reference can be satisfied by its own INSERT. A multi-row creator cycle
 * has no first row under immediate FK enforcement and is rejected.
 */
export function orderAdminCreatorRows(rows) {
  requireContract(Array.isArray(rows), "admin_accounts.row_shape");
  const ids = new Map();
  const validId = (value) =>
    typeof value === "string" &&
    /^(?:0|-?[1-9]\d*)$/u.test(value) &&
    BigInt(value) >= -9223372036854775808n &&
    BigInt(value) <= 9223372036854775807n;
  rows.forEach((row, index) => {
    requireContract(row && typeof row === "object" && validId(row.id), "admin_accounts.id");
    requireContract(
      row.created_by_admin_account_id === null || validId(row.created_by_admin_account_id),
      "admin_accounts.created_by_admin_account_id",
    );
    requireContract(!ids.has(row.id), "admin_accounts.duplicate_id");
    ids.set(row.id, index);
  });
  for (const row of rows)
    requireContract(
      row.created_by_admin_account_id === null || ids.has(row.created_by_admin_account_id),
      "admin_accounts.admin_accounts_admin_creator_fk.missing_parent",
    );
  const orderedIndices = [],
    remaining = new Set(rows.map((_row, index) => index)),
    finished = new Set();
  while (remaining.size > 0) {
    const ready = [...remaining].filter((index) => {
      const row = rows[index],
        parent = row.created_by_admin_account_id;
      return parent === null || parent === row.id || finished.has(parent);
    });
    requireContract(ready.length > 0, "admin_accounts.admin_accounts_admin_creator_fk.row_cycle");
    for (const index of ready) {
      remaining.delete(index);
      finished.add(rows[index].id);
      orderedIndices.push(index);
    }
  }
  return orderedIndices;
}

/** Resolve the two exceptional graph edges using source facts supplied by the
 * caller. This validates order only, never claims DB constraints/rows imported.
 */
export function resolveImportInsertOrder(
  orderPlan,
  { electionWinnerCount, adminCreatorRows, nonSeedTargetRowCountBeforeImport },
) {
  requireHash(orderPlan, "order_plan_sha256", "order_plan_checksum");
  requireContract(
    typeof electionWinnerCount === "string" && /^(?:0|[1-9]\d*)$/u.test(electionWinnerCount),
    "elections.winner_count_shape",
  );
  if (orderPlan.winner_foreign_key_mode === "preserve_installed")
    same(
      electionWinnerCount,
      "0",
      "elections.elections_winner_candidate_foreign_key.source_row_cycle",
    );
  else {
    same(
      orderPlan.winner_foreign_key_mode,
      "recreate_after_exact_insert",
      "winner_foreign_key_mode",
    );
    same(nonSeedTargetRowCountBeforeImport, "0", "target.non_seed_rows_before_import");
  }
  return {
    table_order: [...orderPlan.candidate_table_order],
    admin_account_row_indices: orderAdminCreatorRows(adminCreatorRows),
    constraint_recreation: orderPlan.constraint_recreation,
    order_verified_only: true,
    database_constraints_verified: false,
    order_plan_sha256: orderPlan.order_plan_sha256,
  };
}

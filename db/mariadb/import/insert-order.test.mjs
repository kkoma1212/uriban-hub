import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { argv } from "node:process";
import { test } from "node:test";
import { buildInstallPostconditionCatalog } from "../ledger/install-postconditions.mjs";
import { withAccountExperiencePostconditions } from "../ledger/account-experience-followup.mjs";
import { withMailManagementPostconditions } from "../ledger/mail-management-followup.mjs";
import { buildPostgresMariaDbImportPlan } from "./import-plan.mjs";
import {
  analyzeImportForeignKeys,
  buildImportInsertOrderPlan,
  orderAdminCreatorRows,
  resolveImportInsertOrder,
  reviewImportInsertTriggers,
} from "./insert-order.mjs";

const copy = (value) => JSON.parse(JSON.stringify(value));
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
const installation = buildInstallPostconditionCatalog();
const mappingBody = {
  runtime_plan_sha256: installation.plan.plan_sha256,
  tables: installation.plan.product_tables.map((table) => ({
    table,
    foreign_keys: Object.values(installation.final.tables[table].foreign_keys),
  })),
};
const mapping = { ...mappingBody, plan_sha256: digest(mappingBody) };
test("mail tables and automatic teacher approval follow their exact parent rows", () => {
  const updated = withMailManagementPostconditions(
    withAccountExperiencePostconditions(installation),
  );
  const body = {
    runtime_plan_sha256: updated.plan.plan_sha256,
    tables: updated.plan.product_tables.map((table) => ({
      table,
      foreign_keys: Object.values(updated.final.tables[table].foreign_keys),
    })),
  };
  const plan = buildImportInsertOrderPlan(
    { ...body, plan_sha256: digest(body) },
    {
      installation: updated,
      winnerForeignKeyMode: "recreate_after_exact_insert",
    },
  );
  assert.equal(plan.table_count, 56);
  assert.equal(plan.foreign_key_count, 105);
  const order = plan.candidate_table_order;
  for (const [parent, child] of [
    ["users", "admin_signup_approvals"],
    ["admin_signup_approvals", "teacher_profiles"],
    ["admin_accounts", "mail_templates"],
  ]) {
    assert.ok(order.indexOf(parent) < order.indexOf(child));
  }
  assert.throws(
    () => buildImportInsertOrderPlan({ ...body, plan_sha256: digest(body) }),
    /runtime_plan_checksum/u,
  );
});
const rejected = (suffix) => (error) => {
  assert.equal(error.code, "PG_MARIADB_IMPORT_REJECTED");
  assert.ok(error.message.endsWith(suffix), error.message);
  assert.ok(!error.message.includes("private-value"));
  return true;
};

test("pinned54-table graph has exactly103 FK constraints and only the reviewed creator/winner cycles", () => {
  const graph = analyzeImportForeignKeys(mapping.tables);
  assert.equal(graph.table_count, 54);
  assert.equal(graph.foreign_key_count, 103);
  assert.deepEqual(graph.cycles, [["admin_accounts"], ["election_candidates", "elections"]]);
});

test("six final triggers include only two INSERT readers and four UPDATE guards", () => {
  const triggers = reviewImportInsertTriggers(installation.final.triggers);
  assert.equal(triggers.length, 6);
  assert.deepEqual(
    triggers.filter((trigger) => trigger.event === "INSERT").map((trigger) => trigger.table),
    ["audit_logs", "class_member_status_history"],
  );
  for (const trigger of triggers) {
    assert.deepEqual(trigger.routine_calls, []);
    assert.deepEqual(trigger.table_writes, []);
  }
});

test("trigger event changes, new reads, routine calls and NEW assignments require fresh review", () => {
  const changed = () => copy(installation.final.triggers);
  let triggers = changed();
  triggers.notices_audience_mode_immutable.event = "INSERT";
  assert.throws(() => reviewImportInsertTriggers(triggers), rejected("header"));
  triggers = changed();
  triggers.audit_logs_actor_class_validate.body += " select id from users ;";
  assert.throws(() => reviewImportInsertTriggers(triggers), rejected("references"));
  triggers = changed();
  triggers.audit_logs_actor_class_validate.body += " call assert_class_invariants ( 1 ) ;";
  assert.throws(() => reviewImportInsertTriggers(triggers), rejected("references"));
  triggers = changed();
  triggers.audit_logs_actor_class_validate.body += " set new . actor_user_id = null ;";
  assert.throws(() => reviewImportInsertTriggers(triggers), rejected("new_row_assignment"));
  triggers = changed();
  delete triggers.elections_tie_break_immutable;
  assert.throws(() => reviewImportInsertTriggers(triggers), rejected("trigger_set"));
});

test("candidate order obeys all remaining FK/trigger edges and stages class users and profiles first", () => {
  const plan = buildImportInsertOrderPlan(mapping);
  assert.equal(plan.executable, false);
  assert.equal(plan.constraint_recreation, null);
  const index = (table) => plan.candidate_table_order.indexOf(table);
  const omitted = new Set([
    "admin_accounts.admin_accounts_admin_creator_fk",
    "elections.elections_winner_candidate_foreign_key",
  ]);
  for (const edge of analyzeImportForeignKeys(mapping.tables).edges)
    if (!omitted.has(edge.coordinate))
      assert.ok(index(edge.parent_table) < index(edge.child_table), edge.coordinate);
  for (const [parent, child] of [
    ["users", "teacher_profiles"],
    ["teacher_profiles", "classes"],
    ["classes", "class_members"],
    ["class_members", "class_invite_codes"],
    ["class_members", "class_member_status_history"],
    ["class_members", "audit_logs"],
    ["elections", "election_candidates"],
    ["election_candidates", "election_tallies"],
  ])
    assert.ok(index(parent) < index(child));
  assert.deepEqual(JSON.parse(JSON.stringify(plan)), plan);
  assert.equal(plan.class_invariant_assertion.call_sql, "CALL assert_class_invariants(?)");
  assert.equal(plan.class_invariant_assertion.timing, "after_all_exact_inserts_before_commit");
  assert.equal(plan.class_invariant_assertion.required_session_isolation, "READ-COMMITTED");
});

test("default order stops on any saved winner and never fabricates a null winner", () => {
  const plan = buildImportInsertOrderPlan(mapping);
  for (const electionWinnerCount of ["1", "2", "9007199254740993"])
    assert.throws(
      () => resolveImportInsertOrder(plan, { electionWinnerCount, adminCreatorRows: [] }),
      rejected("source_row_cycle"),
    );
  assert.throws(
    () => resolveImportInsertOrder(plan, { electionWinnerCount: 0, adminCreatorRows: [] }),
    rejected("winner_count_shape"),
  );
  const result = resolveImportInsertOrder(plan, { electionWinnerCount: "0", adminCreatorRows: [] });
  assert.equal(result.table_order.length, 54);
  assert.equal(result.database_constraints_verified, false);
});

test("explicit exact-FK recreation preserves both composite coordinates and RESTRICT actions", () => {
  const plan = buildImportInsertOrderPlan(mapping, {
    winnerForeignKeyMode: "recreate_after_exact_insert",
  });
  const change = plan.constraint_recreation;
  assert.equal(plan.executable, false);
  assert.equal(change.name, "elections_winner_candidate_foreign_key");
  assert.deepEqual(change.columns, ["winner_candidate_id", "id"]);
  assert.deepEqual(change.target_columns, ["id", "election_id"]);
  assert.equal(change.target_table, "election_candidates");
  assert.deepEqual(change.required_session, {
    foreign_key_checks: "1",
    unique_checks: "1",
    check_constraint_checks: "1",
  });
  assert.equal(
    change.drop_sql,
    "ALTER TABLE `elections` DROP FOREIGN KEY `elections_winner_candidate_foreign_key`",
  );
  assert.equal(
    change.add_sql,
    "ALTER TABLE `elections` ADD CONSTRAINT `elections_winner_candidate_foreign_key` FOREIGN KEY (`winner_candidate_id`, `id`) REFERENCES `election_candidates` (`id`, `election_id`) ON DELETE RESTRICT ON UPDATE RESTRICT",
  );
  assert.deepEqual(
    change.installed_rows.map((row) => [row.ordinal, row.column_name, row.target_column]),
    [
      ["1", "winner_candidate_id", "id"],
      ["2", "id", "election_id"],
    ],
  );
  assert.deepEqual(change.dropped_rows, []);
  assert.equal(change.drop_is_transactional, false);
  assert.equal(change.add_is_transactional, false);
  assert.match(change.phases[3], /assert_class_invariants_commit/u);
  assert.match(change.phases[4], /db_validates_existing_rows/u);
  for (const [name, sql] of Object.entries(change))
    if (name.endsWith("_sql")) assert.doesNotMatch(sql, /^UPDATE\b|foreign_key_checks\s*=\s*0/iu);
  const result = resolveImportInsertOrder(plan, {
    electionWinnerCount: "2",
    adminCreatorRows: [],
    nonSeedTargetRowCountBeforeImport: "0",
  });
  assert.equal(result.constraint_recreation.name, change.name);
  assert.equal(result.database_constraints_verified, false);
});

test("exact-FK mode requires a measured empty non-seed target; absent/number/occupied values fail", () => {
  const plan = buildImportInsertOrderPlan(mapping, {
    winnerForeignKeyMode: "recreate_after_exact_insert",
  });
  for (const nonSeedTargetRowCountBeforeImport of [undefined, 0, "1", "56", "private-value"])
    assert.throws(
      () =>
        resolveImportInsertOrder(plan, {
          electionWinnerCount: "2",
          adminCreatorRows: [],
          nonSeedTargetRowCountBeforeImport,
        }),
      rejected("non_seed_rows_before_import"),
    );
  assert.throws(
    () => buildImportInsertOrderPlan(mapping, { winnerForeignKeyMode: "ignore_constraints" }),
    rejected("winner_foreign_key_mode"),
  );
});

test("admin creator rows are ordered parent-first even when IDs and source row order disagree", () => {
  const rows = [
    { id: "1", created_by_admin_account_id: "9007199254740993", email: "private-value" },
    { id: "9007199254740993", created_by_admin_account_id: "20" },
    { id: "20", created_by_admin_account_id: null },
  ];
  const before = copy(rows);
  assert.deepEqual(orderAdminCreatorRows(rows), [2, 1, 0]);
  assert.deepEqual(rows, before);
  assert.deepEqual(orderAdminCreatorRows([]), []);
});

test("a self-referencing admin row can be its own parent without altering the row", () => {
  const rows = [
    { id: "2", created_by_admin_account_id: "1" },
    { id: "1", created_by_admin_account_id: "1" },
  ];
  assert.deepEqual(orderAdminCreatorRows(rows), [1, 0]);
});

test("multi-row creator cycles, missing parents and duplicate IDs stop at safe coordinates", () => {
  for (const rows of [
    [
      { id: "1", created_by_admin_account_id: "2" },
      { id: "2", created_by_admin_account_id: "1" },
    ],
    [
      { id: "1", created_by_admin_account_id: "2" },
      { id: "2", created_by_admin_account_id: "3" },
      { id: "3", created_by_admin_account_id: "1" },
    ],
  ])
    assert.throws(() => orderAdminCreatorRows(rows), rejected("row_cycle"));
  assert.throws(
    () => orderAdminCreatorRows([{ id: "1", created_by_admin_account_id: "2" }]),
    rejected("missing_parent"),
  );
  assert.throws(
    () =>
      orderAdminCreatorRows([
        { id: "1", created_by_admin_account_id: null },
        { id: "1", created_by_admin_account_id: null },
      ]),
    rejected("duplicate_id"),
  );
  assert.throws(
    () => orderAdminCreatorRows([{ id: "private-value", created_by_admin_account_id: null }]),
    rejected("admin_accounts.id"),
  );
  assert.throws(
    () => orderAdminCreatorRows([{ id: "1", created_by_admin_account_id: 1 }]),
    rejected("created_by_admin_account_id"),
  );
});

test("plan tampering and FK references to excluded tables cannot produce an executable order", () => {
  const changed = copy(mapping);
  changed.tables.pop();
  assert.throws(() => buildImportInsertOrderPlan(changed), rejected("mapping_plan_checksum"));
  const order = buildImportInsertOrderPlan(mapping);
  order.candidate_table_order.reverse();
  assert.throws(
    () => resolveImportInsertOrder(order, { electionWinnerCount: "0", adminCreatorRows: [] }),
    rejected("order_plan_checksum"),
  );
  const graph = [
    {
      table: "users",
      foreign_keys: [
        {
          name: "unreviewed_fk",
          columns: ["id"],
          target_table: "seat_draws",
          target_columns: ["id"],
        },
      ],
    },
  ];
  assert.throws(() => analyzeImportForeignKeys(graph), rejected("unknown_parent"));
});

if (argv[2] && argv[3])
  test("actual schema mapping supports the explicit preserved-winner plan without reading source rows", () => {
    const sourceSchema = JSON.parse(readFileSync(argv[2], "utf8")),
      targetMetadata = JSON.parse(readFileSync(argv[3], "utf8"));
    const actual = buildPostgresMariaDbImportPlan({ sourceSchema, targetMetadata });
    const plan = buildImportInsertOrderPlan(actual, {
      winnerForeignKeyMode: "recreate_after_exact_insert",
    });
    assert.equal(plan.foreign_key_count, 103);
    assert.equal(plan.candidate_table_order.length, 54);
    assert.equal(plan.constraint_recreation.name, "elections_winner_candidate_foreign_key");
  });

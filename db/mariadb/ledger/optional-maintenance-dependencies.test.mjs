import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { URL } from "node:url";
import { buildMariaDbInstallPlan } from "./install-plan.mjs";
import {
  assertOptionalMaintenanceActivationOrder,
  buildOptionalMaintenanceSelection,
  optionalMaintenanceArtifactPath,
  optionalMaintenanceProfileIds,
  readOptionalMaintenanceArtifacts,
} from "./optional-maintenance-dependencies.mjs";
import {
  inspectOptionalLockSchema,
  inspectOptionalRuntimeAcl,
} from "./optional-maintenance-sql.mjs";

const root = new URL("../../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root));
const clone = (value) => JSON.parse(JSON.stringify(value));
const plan = buildMariaDbInstallPlan({
  followups: ["class_access_approval", "signup_role", "admin_user_status", "admin_member_status"],
});
const source = readOptionalMaintenanceArtifacts();
const full = buildOptionalMaintenanceSelection(plan, {
  profiles: [...optionalMaintenanceProfileIds],
});
const sourceText = (id) =>
  read(source.artifacts.find((artifact) => artifact.id === id).source_path).toString("utf8");

test("separate five-file review preserves historical53, ledger gaps and current grant catalog", () => {
  assert.equal(source.base_artifact_mapping.length, 53);
  assert.equal(source.artifacts.length, 5);
  assert.deepEqual(
    source.artifacts.map((artifact) => artifact.ledger_version),
    [64, 65, 66, 67, 68],
  );
  assert.equal(source.mapping_boundary.historical_worker_mapping, "absent");
  assert.equal(source.mapping_boundary.historical_retention_mapping.ledger_version, null);
  assert.equal(source.execution_enabled, false);
  assert.equal(source.runtime_activation_applied, false);
  assert.equal(source.actual_database_verified, false);
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(source.artifacts[0].grant_entries).map(([role, entries]) => [
        role,
        entries.length,
      ]),
    ),
    { app: 251, operator: 195, worker: 2, retention: 43 },
  );
  assert.equal(
    source.artifacts.reduce((count, artifact) => count + artifact.references.length, 0),
    77,
  );
});

for (const [profiles, versions, tables, worker, retention] of [
  [[], [64], 55, 2, 43],
  [["worker_security_audit_v1"], [64, 65, 66], 56, 4, 43],
  [["retention_v1"], [64, 67, 68], 56, 2, 44],
  [["worker_security_audit_v1", "retention_v1"], [64, 65, 66, 67, 68], 57, 4, 44],
])
  test(`explicit profiles ${profiles.join("+") || "baseline"} preserve optional versions and final envelope`, () => {
    const selected = buildOptionalMaintenanceSelection(plan, { profiles });
    assert.deepEqual(
      selected.steps.slice(53).map((step) => step.ledger_version),
      versions,
    );
    assert.equal(selected.expected_base_table_count, tables);
    assert.equal(selected.planned_record_count, 52 + versions.length);
    assert.deepEqual(selected.expected_runtime_grant_counts, {
      app: 251,
      operator: 195,
      worker,
      retention,
    });
    assert.equal(selected.product_tables.length, 54);
    assert.equal(selected.execution_enabled, false);
    assert.equal(selected.runtime_activation_applied, false);
    assert.equal(selected.actual_database_verified, false);
    assert.equal(Object.hasOwn(selected, "plan_sha256"), false);
    for (let i = 53; i < selected.steps.length; i++)
      assert.equal(selected.steps[i].after, selected.steps[i - 1].id);
    assert.equal(
      assertOptionalMaintenanceActivationOrder(
        selected,
        selected.activation_order.map((action) => action.id),
      ),
      true,
    );
  });

test("canonical profile ordering and outputs do not mutate the source plan or another selection", () => {
  const before = clone(plan);
  assert.deepEqual(
    buildOptionalMaintenanceSelection(plan, {
      profiles: [...optionalMaintenanceProfileIds].reverse(),
    }),
    full,
  );
  const changed = buildOptionalMaintenanceSelection(plan, {
    profiles: [...optionalMaintenanceProfileIds],
  });
  changed.steps[0].requires.push("invented");
  changed.final_runtime_grants.app.length = 0;
  assert.deepEqual(plan, before);
  assert.deepEqual(
    buildOptionalMaintenanceSelection(plan, { profiles: [...optionalMaintenanceProfileIds] }),
    full,
  );
});

test("CREATE/seed ownership and semantic requires remain distinct from execution after", () => {
  const worker = source.artifacts.find((artifact) => artifact.id === "worker-audit-lock-keys");
  const retention = source.artifacts.find(
    (artifact) => artifact.id === "retained-retention-lock-keys",
  );
  assert.deepEqual(worker.requires, []);
  assert.deepEqual(retention.requires, []);
  assert.equal(worker.after, "current-runtime-acl");
  assert.equal(worker.lock_contract.committed_seed_rows, 0);
  assert.equal(retention.lock_contract.committed_seed_rows, 3);
  assert.deepEqual(retention.owner_contract.required_installer_privileges, ["CREATE", "INSERT"]);
  assert.equal(retention.owner_contract.runtime_seed_insert, false);
  assert.equal(retention.owner_contract.seed_transaction_must_commit, true);
  assert.ok(
    source.artifacts.every((artifact) => artifact.owner_contract.grants_to_definer === false),
  );
  const acl = source.artifacts[0];
  for (const id of [
    "identity-school",
    "signup-role",
    "admin-account-management",
    "admin-user-status",
    "admin-member-status",
  ])
    assert.ok(acl.requires.includes(id));
});

test("retention has only retained domain digests and worker registrations are dynamic", () => {
  assert.deepEqual(
    full.lock_contracts.map((contract) => [contract.table, contract.committed_seed_rows]),
    [
      ["worker_security_audit_lock_keys", 0],
      ["retention_lock_keys", 3],
    ],
  );
  assert.deepEqual(full.lock_contracts[1].seed_tables, [
    "attendance_notifications",
    "guardian_consent_requests",
    "student_assessment_records",
  ]);
  assert.ok(source.profiles[0].registration_lifecycle.includes("no production cleanup"));
  assert.deepEqual(source.historical_comment_corrections[0].active_contract, {
    seed_rows: 3,
    baseline_entries: 43,
    final_entries: 44,
  });
  assert.ok(full.final_runtime_grants.retention.includes("table|retention_lock_keys|SELECT|*"));
  assert.equal(
    full.final_runtime_grants.retention.some((entry) =>
      /retention_lock_keys\|(INSERT|UPDATE|DELETE)/u.test(entry),
    ),
    false,
  );
});

for (const profiles of [
  "worker_security_audit_v1",
  ["worker"],
  ["retention"],
  ["app"],
  ["worker_security_audit_v1", "worker_security_audit_v1"],
])
  test(`reject ambiguous, unknown or duplicate profile ${JSON.stringify(profiles)}`, () => {
    assert.throws(() => buildOptionalMaintenanceSelection(plan, { profiles }), /profile/iu);
  });

for (const [label, mutate] of [
  [
    "missing signup schema",
    (value) =>
      value.steps.splice(
        value.steps.findIndex((step) => step.id === "signup-role"),
        1,
      ),
  ],
  [
    "missing owner activation grant",
    (value) =>
      value.steps.splice(
        value.steps.findIndex((step) => step.id === "admin-member-status-execute"),
        1,
      ),
  ],
  [
    "different ledger number",
    (value) => {
      value.steps[52].ledger_version = 68;
    },
  ],
  ["retired product table", (value) => value.product_tables.push("layout_draft_autosaves")],
  [
    "unreviewed operational table",
    (value) => value.operational_tables.push("transaction_lock_keys"),
  ],
  [
    "forged base after field",
    (value) => {
      value.steps[1].after = "retention-lock-acl";
    },
  ],
  [
    "misordered base dependencies",
    (value) => {
      [value.steps[49], value.steps[50]] = [value.steps[50], value.steps[49]];
    },
  ],
])
  test(`reject optional activation over ${label}`, () => {
    const value = clone(plan);
    mutate(value);
    assert.throws(() => buildOptionalMaintenanceSelection(value, { profiles: ["retention_v1"] }));
  });

for (const path of [
  optionalMaintenanceArtifactPath,
  ...source.artifacts.map((artifact) => artifact.source_path),
  ...source.support_sources.map((artifact) => artifact.source_path),
])
  test(`reject changed reviewed bytes ${path}`, () => {
    assert.throws(
      () =>
        readOptionalMaintenanceArtifacts({
          readRepoFile: (candidate) =>
            candidate === path
              ? Buffer.concat([read(candidate), Buffer.from("\n")])
              : read(candidate),
        }),
      /changed/u,
    );
  });

for (const [label, mutate] of [
  [
    "reset after optional grants",
    (ids) => {
      ids.push(ids.splice(1, 1)[0]);
    },
  ],
  ["missing retention grant", (ids) => ids.splice(ids.indexOf("retention-lock-acl"), 1)],
  [
    "ACL before seed creation",
    (ids) => {
      const i = ids.indexOf("retained-retention-lock-keys");
      [ids[i], ids[i + 1]] = [ids[i + 1], ids[i]];
    },
  ],
  [
    "baseline reset appended",
    (ids) => ids.push("reset-four-runtime-privileges-preserving-credentials"),
  ],
  ["missing final profile attestation", (ids) => ids.pop()],
])
  test(`reject unsafe external action order: ${label}`, () => {
    const ids = full.activation_order.map((action) => action.id);
    mutate(ids);
    assert.throws(() => assertOptionalMaintenanceActivationOrder(full, ids), /order/u);
  });

for (const [label, mutate] of [
  [
    "retention grant fallback",
    (value) => {
      value.final_runtime_grants.retention = value.final_runtime_grants.retention.filter(
        (entry) => !entry.includes("retention_lock_keys"),
      );
    },
  ],
  [
    "worker profile fallback",
    (value) => {
      value.runtime_grant_profiles.worker = null;
    },
  ],
  [
    "old baseline count",
    (value) => {
      value.expected_runtime_grant_counts.retention = 43;
    },
  ],
  ["self-consistent forged order", (value) => value.activation_order.reverse()],
  [
    "source path substitution",
    (value) => {
      value.activation_order[2].source_path = "db/mariadb/permissions/0036_active_runtime_acl.sql";
    },
  ],
  [
    "false execution claim",
    (value) => {
      value.runtime_activation_applied = true;
    },
  ],
])
  test(`reject modified selection contract: ${label}`, () => {
    const value = clone(full);
    mutate(value);
    assert.throws(() =>
      assertOptionalMaintenanceActivationOrder(
        value,
        value.activation_order.map((action) => action.id),
      ),
    );
  });

test("ACL parser expands column and procedure rights without accepting broad/schema/grantable rights", () => {
  const sql = sourceText("current-runtime-acl");
  assert.ok(inspectOptionalRuntimeAcl(sql).app.includes("table|users|INSERT|signup_role"));
  assert.ok(
    inspectOptionalRuntimeAcl(sql).app.includes("procedure|set_admin_member_status|EXECUTE"),
  );
  for (const extra of [
    "GRANT ALL PRIVILEGES ON classhub_mariadb_phase1_dev.* TO 'classhub_worker'@'%';",
    "GRANT SELECT ON classhub_mariadb_phase1_dev.`retention_lock_keys` TO 'classhub_retention'@'%' WITH GRANT OPTION;",
    "GRANT SELECT ON classhub_mariadb_phase1_dev.`retention_lock_keys` TO 'classhub_retention'@'%', 'classhub_worker'@'%';",
    "/*! GRANT DELETE ON classhub_mariadb_phase1_dev.retention_lock_keys TO 'classhub_retention'@'%'; */",
    "REVOKE ALL PRIVILEGES, GRANT OPTION FROM 'classhub_worker'@'%';",
  ])
    assert.throws(() => inspectOptionalRuntimeAcl(sql + "\n" + extra));
  assert.throws(
    () =>
      inspectOptionalRuntimeAcl(
        sql +
          "\n" +
          sourceText("worker-audit-lock-acl") +
          "\n" +
          sourceText("worker-audit-lock-acl"),
      ),
    /Duplicate/u,
  );
});

test("lock schema rejects missing commit, extra historical seed, dynamic DML, FK and seed substitution", () => {
  const sql = sourceText("retained-retention-lock-keys");
  for (const changed of [
    sql.replace("COMMIT;", ""),
    sql.replace("COMMIT;", "ROLLBACK;"),
    sql.replace("(0xe967", "(0xe968"),
    sql + "\nINSERT INTO retention_lock_keys VALUES (0x00);",
    sql.replace(
      "PRIMARY KEY (lock_digest)",
      "PRIMARY KEY (lock_digest), FOREIGN KEY (lock_digest) REFERENCES users(id)",
    ),
    read("db/mariadb/migrations/0035_retention_lock_keys.sql").toString("utf8"),
  ])
    assert.throws(() => inspectOptionalLockSchema(changed, "retention_lock_keys"));
  assert.throws(() =>
    inspectOptionalLockSchema(
      sourceText("worker-audit-lock-keys") +
        "\nINSERT INTO worker_security_audit_lock_keys VALUES (0x00);",
      "worker_security_audit_lock_keys",
    ),
  );
});

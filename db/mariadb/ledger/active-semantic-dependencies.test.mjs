import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { URL } from "node:url";
import test from "node:test";
import { buildMariaDbInstallPlan } from "./install-plan.mjs";
import { inspectMariaDbSemanticSql } from "./active-semantic-sql.mjs";
import {
  activeSemanticDependencyPath,
  readActiveSemanticDependencies,
  applyActiveSemanticDependencies,
} from "./active-semantic-dependencies.mjs";

const root = new URL("../../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fullPlan = () =>
  buildMariaDbInstallPlan({
    followups: ["class_access_approval", "signup_role", "admin_user_status", "admin_member_status"],
  });
const byId = (items, id) => items.find((item) => item.id === id);

test("all 53 exact sources have typed direct-reference providers and explicit supplemental dependencies", () => {
  const review = readActiveSemanticDependencies();
  assert.equal(review.artifacts.length, 53);
  assert.equal(review.reference_count, 280);
  assert.equal(review.dependency_count, 179);
  assert.equal(review.defined_object_count, 84);
  assert.equal(
    review.artifacts.flatMap((item) => item.definitions).filter((item) => item.kind === "table")
      .length,
    54,
  );
  assert.ok(
    review.artifacts.every((item) =>
      item.references.every((reference) => typeof reference.provider === "string"),
    ),
  );
  assert.ok(review.separate_review.some((item) => item.category === "worker"));
  assert.ok(review.separate_review.some((item) => item.category === "retention"));
  assert.ok(review.separate_review.some((item) => item.category === "current_runtime_acl"));
  assert.equal(review.assessment.runtime_activation_applied, false);
});

test("actual table/column/grant dependencies replace empty requires without copying adjacent after edges", () => {
  const original = fullPlan(),
    before = JSON.parse(JSON.stringify(original));
  const { steps, review } = applyActiveSemanticDependencies(original);
  assert.deepEqual(original, before);
  assert.notEqual(steps, original.steps);
  assert.deepEqual(byId(steps, "identity-foundation").requires, []);
  assert.deepEqual(byId(steps, "public-holidays").requires, [
    "audit-import-logs",
    "school-schedules",
  ]);
  assert.deepEqual(byId(steps, "signup-role").requires, [
    "development-identities",
    "identity-foundation",
  ]);
  assert.ok(byId(steps, "admin-member-status").requires.includes("admin-account-management"));
  assert.ok(
    byId(steps, "admin-member-status-execute").requires.includes("admin-account-management"),
  );
  assert.ok(byId(steps, "class-access-approval-owner").requires.includes("admin-signup-approvals"));
  assert.deepEqual(
    steps.map((step) => step.after),
    original.steps.map((step) => step.after),
  );
  assert.deepEqual(
    steps.map((step) => step.ledger_version),
    original.steps.map((step) => step.ledger_version),
  );
  assert.equal(review.status, "selected_static_dependencies_complete");
  assert.equal(review.selected_reviewed_artifacts, 53);
  assert.equal(review.actual_database_verified, false);
  assert.equal(review.execution_enabled, false);
});

test("later definer grants are invocation conditions, never cyclic installation predecessors", () => {
  const { steps, review } = applyActiveSemanticDependencies(fullPlan());
  assert.ok(
    !byId(steps, "class-transition-lifecycle-routines").requires.includes(
      "class-membership-definer-dml-grants",
    ),
  );
  assert.ok(
    review.activation_requires
      .find((item) => item.artifact === "class-transition-lifecycle-routines")
      .requires.some((item) => item.id === "class-membership-definer-dml-grants"),
  );
  assert.ok(!byId(steps, "admin-member-status").requires.includes("admin-member-status-execute"));
  assert.ok(
    review.activation_requires
      .find((item) => item.artifact === "admin-member-status")
      .requires.some((item) => item.id === "admin-member-status-execute"),
  );
});

test("baseline-only plan is statically complete without silently selecting application followups", () => {
  const plan = buildMariaDbInstallPlan(),
    result = applyActiveSemanticDependencies(plan);
  assert.equal(result.steps.length, 46);
  assert.equal(result.review.selected_reviewed_artifacts, 46);
  assert.equal(result.review.status, "selected_static_dependencies_complete");
  assert.ok(!result.steps.some((step) => step.id === "signup-role"));
});

test("missing approval column grant fails even when its surrounding table and routine files remain", () => {
  const plan = fullPlan();
  plan.steps = plan.steps.filter((step) => step.id !== "class-access-approval-owner");
  assert.throws(
    () => applyActiveSemanticDependencies(plan),
    /Selected semantic prerequisite missing or late/u,
  );
});

test("moving EXECUTE before its new routine cannot be repaired by a plausible after field", () => {
  const plan = fullPlan(),
    left = plan.steps.findIndex((step) => step.id === "admin-user-status"),
    right = left + 1;
  [plan.steps[left], plan.steps[right]] = [plan.steps[right], plan.steps[left]];
  plan.steps[left].after = plan.steps[left - 1].id;
  assert.throws(
    () => applyActiveSemanticDependencies(plan),
    /Selected semantic prerequisite missing or late/u,
  );
});

test("omitting a following permission file reports the precise missing activation condition", () => {
  const plan = fullPlan();
  plan.steps = plan.steps.filter((step) => step.id !== "admin-user-status-execute");
  const result = applyActiveSemanticDependencies(plan);
  assert.equal(result.review.complete_direct_static_dependency_review, true);
  assert.equal(result.review.selected_activation_artifacts_present, false);
  assert.equal(result.review.status, "selected_static_dependencies_incomplete");
  assert.deepEqual(
    result.review.missing_activation_artifacts.map(({ artifact, requires }) => ({
      artifact,
      requires,
    })),
    [{ artifact: "admin-user-status", requires: "admin-user-status-execute" }],
  );
});

for (const file of [
  activeSemanticDependencyPath,
  "db/mariadb/ledger/install-artifacts.json",
  "db/mariadb/ledger/current-application-artifacts.json",
  "db/mariadb/migrations/0040_admin_member_status.sql",
]) {
  test(`source or overlay drift is refused: ${file}`, () => {
    assert.throws(() =>
      readActiveSemanticDependencies({
        readRepoFile: (path) =>
          path === file ? Buffer.concat([read(path), Buffer.from("\n")]) : read(path),
      }),
    );
  });
}

test("selected source metadata cannot borrow a different artifact's valid checksum", () => {
  const plan = fullPlan();
  byId(plan.steps, "admin-member-status").sha256 = byId(plan.steps, "admin-user-status").sha256;
  assert.throws(() => applyActiveSemanticDependencies(plan), /Selected semantic source differs/u);
});

test("optional retained source remains separately unreviewed rather than implying global completeness", () => {
  const plan = fullPlan(),
    path = "db/mariadb/verification/synthetic_optional.sql";
  const source = Buffer.from("CREATE TABLE synthetic_optional (id BIGINT);\n");
  plan.steps.push({
    id: "synthetic-optional",
    source_path: path,
    sha256: sha(source),
    byte_length: source.length,
    requires: [],
  });
  const result = applyActiveSemanticDependencies(plan, {
    readRepoFile: (file) => (file === path ? source : read(file)),
  });
  assert.equal(result.review.status, "selected_static_dependencies_incomplete");
  assert.equal(result.review.complete_direct_static_dependency_review, false);
  assert.equal(result.review.unreviewed_selected_artifacts[0].id, "synthetic-optional");
});

for (const source of [
  "CREATE TABLE seat_draws (id BIGINT);",
  "SELECT id FROM `team_draws`;",
  "GRANT SELECT ON classhub_mariadb_phase1_dev.duty_rosters TO 'classhub_app'@'%';",
])
  test(`unreviewed optional source cannot reintroduce retired tables: ${source}`, () => {
    const plan = fullPlan(),
      path = "db/mariadb/verification/synthetic_retired.sql",
      bytes = Buffer.from(source);
    plan.steps.push({
      id: "synthetic-retired",
      source_path: path,
      sha256: sha(bytes),
      byte_length: bytes.length,
    });
    assert.throws(
      () =>
        applyActiveSemanticDependencies(plan, {
          readRepoFile: (file) => (file === path ? bytes : read(file)),
        }),
      /Retired table/u,
    );
  });

test("retired historical source and 65-table scope cannot receive the active overlay", () => {
  const plan = fullPlan();
  plan.product_tables.push("seat_draws");
  assert.throws(() => applyActiveSemanticDependencies(plan), /all 54 active tables/u);
  const second = fullPlan();
  second.steps.push({ id: "seat-draws", source_path: "db/mariadb/migrations/0011_seat_draws.sql" });
  assert.throws(() => applyActiveSemanticDependencies(second), /Retired artifact/u);
});

test("quoted SQL, escaped apostrophes, comments and quoted semicolons cannot invent object dependencies", () => {
  const source = String.raw`-- CALL retired(); CREATE TABLE missing (id BIGINT);
CREATE TABLE child (id BIGINT, note TEXT DEFAULT 'escaped\'; CALL fake();', FOREIGN KEY (id) REFERENCES users(id));
/* REFERENCES seat_draws(id); */
INSERT INTO child (note) VALUES ('CREATE TABLE team_draws (id BIGINT);');`;
  const result = inspectMariaDbSemanticSql(source);
  assert.deepEqual(
    result.definitions.map((item) => item.object),
    ["child"],
  );
  assert.deepEqual(
    result.references.map((item) => [item.kind, item.object]),
    [
      ["foreign_key", "users"],
      ["table_insert", "child"],
    ],
  );
});

test("CALL, foreign keys, definer, trigger targets and principal-qualified grants remain typed", () => {
  const result = inspectMariaDbSemanticSql(
    "CREATE DEFINER='classhub_routine'@'%' TRIGGER audit_check BEFORE INSERT ON audit_logs FOR EACH ROW CALL validate_audit(); GRANT EXECUTE ON PROCEDURE classhub_mariadb_phase1_dev.validate_audit TO 'classhub_app'@'%';",
  );
  assert.deepEqual(
    result.references.map((item) => [item.kind, item.object]),
    [
      ["definer", "classhub_routine"],
      ["trigger_target", "audit_logs"],
      ["call", "validate_audit"],
      ["grant_execute", "validate_audit"],
      ["grantee", "classhub_app"],
    ],
  );
});

test("FOR UPDATE is not a table mutation and CREATE OR REPLACE records its previous definition", () => {
  const result = inspectMariaDbSemanticSql(
    "CREATE OR REPLACE DEFINER='classhub_routine'@'%' PROCEDURE replacement() BEGIN SELECT id FROM users FOR UPDATE; UPDATE users SET is_active=0; END;",
  );
  assert.ok(
    result.references.some(
      (item) => item.kind === "replace_procedure" && item.object === "replacement",
    ),
  );
  assert.deepEqual(
    result.references
      .filter((item) => item.kind.startsWith("table_"))
      .map((item) => [item.kind, item.object]),
    [
      ["table_read", "users"],
      ["table_update", "users"],
    ],
  );
});

for (const source of [
  "PREPARE stmt FROM 'SELECT 1';",
  "EXECUTE IMMEDIATE 'SELECT 1';",
  "/*! CREATE TABLE hidden (id BIGINT); */",
  "/*M! CALL hidden(); */",
  "/*+ hidden */",
  "SELECT 'unfinished",
  "/* unfinished",
  "SELECT `unfinished",
  "RENAME TABLE users TO seat_draws;",
  "DROP TABLE users;",
  "REPLACE INTO users (id) VALUES(1);",
  "GRANT SELECT ON classhub_mariadb_phase1_dev.users TO 'classhub_app'@'%', 'classhub_operator'@'%';",
  "GRANT SELECT ON other_database.users TO 'classhub_app'@'%';",
])
  test(`unreviewed dependency syntax is refused: ${source}`, () => {
    assert.throws(() => inspectMariaDbSemanticSql(source));
  });

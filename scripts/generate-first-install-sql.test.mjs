import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { nativeInstalledCatalog } from "../OPERATIONS/mariadb-dev/verify-native-installed-schema.mjs";
import {
  buildFirstInstallSql,
  firstInstallFeatures,
  firstInstallCatalog,
} from "./generate-first-install-sql.mjs";

test("fresh install catalog skips only disposable identity schema privileges and binds the raw package", () => {
  const development = nativeInstalledCatalog(firstInstallFeatures);
  assert.equal(development.final.migrator_schema_all, true);
  for (const profile of ["none", "active"]) {
    const fresh = firstInstallCatalog({ profile });
    assert.equal(fresh.final.migrator_schema_all, false);
    const compared = structuredClone(fresh.final);
    compared.migrator_schema_all = true;
    assert.deepEqual(
      compared,
      nativeInstalledCatalog({ ...firstInstallFeatures, classArchiveRetention: profile }).final,
    );
    assert.equal(fresh.generated_manifest.ledger_rows, profile === "active" ? 98 : 95);
    assert.equal(fresh.installation_contract.skipped_artifact, "development-identities");
    for (const role of ["app", "operator", "worker", "retention", "migrator"]) {
      assert.equal(fresh.final.accounts[`classhub_${role}`].require_ssl, true);
      assert.equal(fresh.final.accounts[`classhub_${role}`].host, "%");
    }
  }
  assert.throws(() => firstInstallCatalog({ profile: "legacy" }));
});

const catalog = nativeInstalledCatalog(firstInstallFeatures);
test("complete deterministic first-install inventory without disposable credentials", () => {
  const result = buildFirstInstallSql({ catalog });
  assert.deepEqual(buildFirstInstallSql({ catalog }), result);
  assert.equal(result.manifest.ledger_rows, 95);
  assert.equal((result.sql.match(/^INSERT INTO classhub_schema_migrations/gmu) ?? []).length, 95);
  assert.match(result.sql, /CREATE DATABASE classhub /u);
  const beforeFirstWrite = result.sql.slice(0, result.sql.indexOf("CREATE DATABASE classhub "));
  assert.match(beforeFirstWrite, /BEGIN NOT ATOMIC/u);
  assert.match(beforeFirstWrite, /FIRST_INSTALL_ACCOUNT_PRIVILEGES_OR_ACTIVITY/u);
  assert.doesNotMatch(
    beforeFirstWrite,
    /^\s*(?:CREATE|ALTER|DROP|GRANT|REVOKE|INSERT|UPDATE|DELETE)\b/gimu,
  );
  assert.doesNotMatch(
    result.sql,
    /CREATE DATABASE IF NOT EXISTS|IDENTIFIED BY|local_driver_|classhub_mariadb_phase1_dev/u,
  );
  assert.equal(createHash("sha256").update(result.sql).digest("hex"), result.manifest.sql_sha256);
  assert.ok(
    result.sql.indexOf("CREATE TABLE classhub_schema_migrations") <
      result.sql.indexOf("CREATE TABLE users"),
  );
  const runtime = result.manifest.artifacts.find(
    (artifact) => artifact.id === "current-runtime-acl",
  );
  assert.ok(runtime);
  assert.ok(
    result.sql.indexOf("REVOKE ALL PRIVILEGES") <
      result.sql.indexOf(`-- source: ${runtime.source_path}`),
  );
});
test("missing, duplicate, reordered and changed artifacts fail closed", () => {
  const missing = structuredClone(catalog);
  missing.plan.steps.pop();
  assert.throws(() => buildFirstInstallSql({ catalog: missing }), /Missing ledger/);
  const duplicate = structuredClone(catalog);
  duplicate.plan.steps[2] = duplicate.plan.steps[1];
  assert.throws(() => buildFirstInstallSql({ catalog: duplicate }), /Duplicate/);
  const reordered = structuredClone(catalog);
  [reordered.plan.steps[1], reordered.plan.steps[2]] = [
    reordered.plan.steps[2],
    reordered.plan.steps[1],
  ];
  assert.throws(() => buildFirstInstallSql({ catalog: reordered }), /prerequisite/);
  assert.throws(
    () =>
      buildFirstInstallSql({
        catalog,
        readRepoFile: (path) => Buffer.concat([readFileSync(path), Buffer.from("x")]),
      }),
    /length changed/,
  );
});

test("first-install library ACL is exact and company configuration cannot assume its installation", () => {
  const result = buildFirstInstallSql({ catalog });
  assert.equal(firstInstallFeatures.teacherLibrary, true);
  assert.equal(result.manifest.ledger_rows, 95);
  assert.match(
    result.sql,
    /GRANT SELECT, INSERT, DELETE ON classhub\.teacher_library_items TO 'classhub_app'@'%'/u,
  );
  const compose = readFileSync(
    new URL("../OPERATIONS/server-release/docker-compose.yml", import.meta.url),
    "utf8",
  );
  assert.match(
    compose,
    /TEACHER_LIBRARY_DATABASE_INSTALLED: \$\{TEACHER_LIBRARY_DATABASE_INSTALLED:\?/u,
  );
  assert.doesNotMatch(compose, /TEACHER_LIBRARY_DATABASE_INSTALLED: "true"/u);
  const guide = readFileSync(new URL("./build-server-release.mjs", import.meta.url), "utf8");
  assert.match(guide, /기존 분리 구성 업데이트에도 필수/u);
  assert.match(guide, /미확인·불일치면 업데이트를 중단/u);
  assert.match(guide, /기존93의 업데이트 성공은 신규95 회사 출시 검증을 통과한 증거가 아니다/u);
});

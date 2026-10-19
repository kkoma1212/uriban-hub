import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { applySourcePostcondition } from "./install-postcondition-source.mjs";
import { authenticationArtifacts, readAuthenticationSql } from "./auth-extensions-followup.mjs";

// 인증 확장(원장 90·91 관리자 패스키, 92·93 소셜 로그인)을 설치·백업 복원 기준표에 쌓는다.
// 해시는 auth-extensions-followup.mjs의 고정값을 그대로 쓴다. 자동 적용하지 않는다(운영 적용은 별도 승인).
const PASSKEY_TABLES = [
  "admin_passkeys",
  "admin_recovery_codes",
  "admin_webauthn_challenges",
  "admin_mfa_stepups",
];
const SOCIAL_TABLES = ["social_identities", "social_oauth_flows"];

function stack(base, { versions, tables, changedTables, tag }) {
  const artifacts = authenticationArtifacts.filter((artifact) =>
    versions.includes(artifact.ledger_version),
  );
  assert.equal(artifacts.length, versions.length);
  // 도움 대화(84·85) 위에만 쌓는다. 같은 확장을 두 번 쌓지 않는다.
  assert(base.plan.steps.some((step) => step.ledger_version === 85));
  assert(!base.plan.steps.some((step) => versions.includes(step.ledger_version)));
  for (const table of tables) assert(!base.final.tables[table], `${table} already installed`);
  const final = structuredClone(base.final);
  for (const artifact of artifacts)
    applySourcePostcondition(final, readAuthenticationSql(artifact), artifact.id);
  // 새 표·그 권한·허용된 기존 표 변경 외에는 아무것도 바뀌지 않았는지 되돌려 비교한다.
  const reversed = structuredClone(final);
  for (const table of tables) {
    assert(reversed.tables[table], `${table} must be created`);
    delete reversed.tables[table];
  }
  for (const table of changedTables) {
    assert.notDeepEqual(final.tables[table], base.final.tables[table], `${table} must change`);
    reversed.tables[table] = base.final.tables[table];
  }
  const addedGrants = final.grants.classhub_app.filter(
    (grant) => !base.final.grants.classhub_app.includes(grant),
  );
  assert(addedGrants.length > 0);
  // 권한 형식: "table|<표>|<권한>|<칸>" — 새로 생긴 권한은 모두 새 표의 것이어야 한다.
  assert(addedGrants.every((grant) => tables.includes(String(grant).split("|")[1])));
  reversed.grants.classhub_app = base.final.grants.classhub_app;
  assert.deepEqual(reversed, base.final, `Unexpected change outside the ${tag} delta`);
  return {
    ...base,
    final,
    plan: {
      ...base.plan,
      plan_sha256: createHash("sha256")
        .update(
          `classhub:mariadb:${tag}:v1\0${base.plan.plan_sha256}\0${artifacts.map(({ sha256 }) => sha256).join("\0")}`,
        )
        .digest("hex"),
      steps: [...base.plan.steps, ...artifacts],
      ledger: {
        ...base.plan.ledger,
        planned_record_count: base.plan.ledger.planned_record_count + artifacts.length,
      },
    },
  };
}

export function withAdminPasskeyPostconditions(base) {
  return stack(base, {
    versions: [90, 91],
    tables: PASSKEY_TABLES,
    // 관리자 인증 기록의 허용 행동 목록(CHECK)만 넓힌다.
    changedTables: ["admin_auth_audit_logs"],
    tag: "admin-passkeys",
  });
}

export function withSocialLoginPostconditions(base) {
  return stack(base, {
    versions: [92, 93],
    tables: SOCIAL_TABLES,
    changedTables: [],
    tag: "social-login",
  });
}

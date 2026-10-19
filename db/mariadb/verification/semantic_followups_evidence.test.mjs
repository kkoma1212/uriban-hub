import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  buildSemanticAclCandidate,
  renderSemanticAcl,
} from "../permissions/semantic_acl_candidate.mjs";
import { deriveSourceAcl } from "./semantic_source_acl.mjs";
import {
  verifySemanticFollowupEvidence,
  semanticFollowupFixedFields,
  semanticFollowupCounts,
  semanticFollowupGates,
  semanticFollowupBlockers,
  semanticFollowupEntries,
  semanticFollowupMigrationFiles,
  semanticFollowupProvenanceFiles,
  semanticFollowupDocuments,
  semanticFollowupStaticTests,
} from "./semantic_followups_evidence.mjs";
import * as identity from "../../../OPERATIONS/mariadb-dev/phase25-identity-scenarios.mjs";
import * as rules from "../../../OPERATIONS/mariadb-dev/semantic-rule-scenarios.mjs";
import { URL } from "node:url";
import { readEvidenceDocument } from "./evidence-document.mjs";

const { structuredClone } = globalThis;
// Markdown 증거 문서는 9/11부터 문서 DB에 같은 경로 이름으로 있다(evidence-document.mjs).
const read = async (path) =>
  path.endsWith(".md")
    ? readEvidenceDocument(path)
    : readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");
const hash = (value) => createHash("sha256").update(value).digest("hex");
const source = await deriveSourceAcl(read);
const candidate = buildSemanticAclCandidate(source);
const repositoryManifest = JSON.parse(await read("db/mariadb/manifest.json"));
const hashFiles = async (paths) =>
  Object.fromEntries(await Promise.all(paths.map(async (path) => [path, hash(await read(path))])));

// This unit fixture exercises the verifier without depending on disposable QA
// result files. It is not a new database run or an attestation that one occurred.
const valid = structuredClone(repositoryManifest);
valid.semantic_migrations = valid.semantic_migrations.map((entry) => {
  const expected = semanticFollowupEntries.find((item) => item.source === entry.source);
  return expected ? { ...entry, ...structuredClone(expected) } : entry;
});
valid.semantic_followups_verification = {
  ...semanticFollowupFixedFields,
  verified_at: "2026-09-05",
  source_migrations: semanticFollowupEntries.map((entry) => entry.source),
  source_set_sha256: source.sourceSetSha256,
  migration_sha256: await hashFiles(semanticFollowupMigrationFiles),
  provenance_sha256: await hashFiles(semanticFollowupProvenanceFiles),
  rendered_candidate_sha256: hash(renderSemanticAcl(candidate)),
  rendered_probe_candidate_sha256: hash(renderSemanticAcl(candidate, true)),
  counts: structuredClone(semanticFollowupCounts),
  gates: structuredClone(semanticFollowupGates),
  blockers: structuredClone(semanticFollowupBlockers),
  documents: [...semanticFollowupDocuments],
  static_test_files: [...semanticFollowupStaticTests],
};
const mutate = (change) => {
  const altered = structuredClone(valid);
  change(altered, altered.semantic_followups_verification);
  return altered;
};

test("complete bounded evidence reads its SQL, provenance, compose, documents and static tests", async () => {
  const paths = new Set();
  await verifySemanticFollowupEvidence(valid, async (path) => {
    paths.add(path);
    return read(path);
  });
  for (const path of [
    ...semanticFollowupMigrationFiles,
    ...semanticFollowupProvenanceFiles,
    ...semanticFollowupDocuments,
    ...semanticFollowupStaticTests,
    "compose.mariadb-semantic-qa.yaml",
  ])
    assert.ok(paths.has(path), `${path} was actually read`);
  assert.equal(semanticFollowupMigrationFiles.length, 4);
  assert.equal(semanticFollowupCounts.semantic_rejection_probes, 95);
  assert.equal(identity.rejectionScenarios.length + rules.rejectionScenarios.length, 95);
  assert.equal(semanticFollowupCounts.semantic_acceptance_probes, 70);
  assert.equal(identity.acceptanceScenarios.length + rules.acceptanceScenarios.length, 70);
  const ids = [
    ...identity.rejectionScenarios,
    ...rules.rejectionScenarios,
    ...identity.acceptanceScenarios,
    ...rules.acceptanceScenarios,
  ].map(([id]) => id);
  assert.equal(new Set(ids).size, 165);
  assert.deepEqual(
    [
      semanticFollowupCounts.acl_acceptance_probes,
      semanticFollowupCounts.acl_rejection_probes,
      semanticFollowupCounts.exact_acl_entries,
      semanticFollowupCounts.tls_identities,
      semanticFollowupCounts.product_tables,
      semanticFollowupCounts.catalog_seed_rows,
      semanticFollowupCounts.persistent_nonseed_rows,
    ],
    [16, 34, 525, 4, 65, 56, 0],
  );
});

test("every reported count rejects both inflation and under-counting", async () => {
  for (const [field, count] of Object.entries(semanticFollowupCounts)) {
    for (const wrong of [count + 1, count - 1])
      await assert.rejects(
        verifySemanticFollowupEvidence(
          mutate((_, evidence) => {
            evidence.counts[field] = wrong;
          }),
          read,
        ),
        /counts drifted/u,
        `${field}=${wrong}`,
      );
  }
  await assert.rejects(
    verifySemanticFollowupEvidence(
      mutate((_, evidence) => {
        delete evidence.counts.persistent_nonseed_rows;
      }),
      read,
    ),
    /counts drifted/u,
  );
});

test("exactly twelve sources are verified while 0010, 0022, 0024 and 0039 remain incomplete", async () => {
  assert.equal(semanticFollowupEntries.length, 16);
  const incomplete = semanticFollowupEntries.filter(
    (entry) => entry.status === "implemented_unverified_on_container",
  );
  assert.deepEqual(
    incomplete.map((entry) => entry.source.slice(6, 10)),
    ["0010", "0022", "0024", "0039"],
  );
  assert.equal(
    semanticFollowupEntries.filter((entry) => entry.status === "verified_on_container").length,
    12,
  );
  for (const expected of semanticFollowupEntries) {
    await assert.rejects(
      verifySemanticFollowupEvidence(
        mutate((manifest) => {
          const entry = manifest.semantic_migrations.find(
            (item) => item.source === expected.source,
          );
          entry.status =
            expected.status === "verified_on_container"
              ? "planned_unimplemented"
              : "verified_on_container";
        }),
        read,
      ),
      /completion status changed/u,
      expected.source,
    );
  }
});

test("missing, duplicated or wrong sources cannot borrow another migration's evidence", async () => {
  const first = semanticFollowupEntries[0].source;
  for (const change of [
    (manifest) => {
      manifest.semantic_migrations = manifest.semantic_migrations.filter(
        (entry) => entry.source !== first,
      );
    },
    (manifest) => {
      manifest.semantic_migrations.push(structuredClone(semanticFollowupEntries[0]));
    },
    (manifest) => {
      manifest.semantic_migrations.find((entry) => entry.source === first).source =
        "wrong-source.sql";
    },
    (_, evidence) => {
      evidence.source_migrations.pop();
    },
    (_, evidence) => {
      evidence.source_migrations[0] = evidence.source_migrations[1];
    },
  ])
    await assert.rejects(verifySemanticFollowupEvidence(mutate(change), read));
  for (const field of ["migration_count", "product_table_count"])
    await assert.rejects(
      verifySemanticFollowupEvidence(
        mutate((manifest) => {
          manifest.source[field]++;
        }),
        read,
      ),
    );
});

test("every source has an exact artifact set, including the actual reviewed candidate SQL", async () => {
  const candidatePath = "db/mariadb/permissions/0028_runtime_acl_candidate.sql";
  assert.ok(semanticFollowupProvenanceFiles.includes(candidatePath));
  for (const expected of semanticFollowupEntries) {
    if (!expected.source.includes("0027000_"))
      assert.ok(expected.artifacts.includes(candidatePath));
    for (const change of [
      (artifacts) => artifacts.slice(1),
      (artifacts) => [...artifacts, "db/mariadb/permissions/unreviewed.sql"],
    ])
      await assert.rejects(
        verifySemanticFollowupEvidence(
          mutate((manifest) => {
            const entry = manifest.semantic_migrations.find(
              (item) => item.source === expected.source,
            );
            entry.artifacts = change(entry.artifacts);
          }),
          read,
        ),
        /artifact inventory changed/u,
      );
  }
});

test("a recheck without clean apply, backfill or stale-grant reconciliation is insufficient", async () => {
  for (const [field, wrong] of [
    ["migration_applied_this_run", false],
    ["existing_row_backfill", "not_exercised_this_run"],
    ["stale_grant_reconciliation_verified", false],
    ["verification_run", "post_apply_recheck"],
    ["scope", "production"],
    ["server_version", "11.4.14-MariaDB"],
  ])
    await assert.rejects(
      verifySemanticFollowupEvidence(
        mutate((_, evidence) => {
          evidence[field] = wrong;
        }),
        read,
      ),
      new RegExp(`lost ${field}`, "u"),
    );
});

test("all full-completion, activation and caller gates remain false and all blockers stay explicit", async () => {
  for (const field of Object.keys(semanticFollowupGates)) {
    assert.equal(semanticFollowupGates[field], false);
    await assert.rejects(
      verifySemanticFollowupEvidence(
        mutate((_, evidence) => {
          evidence.gates[field] = true;
        }),
        read,
      ),
      /activation gates changed/u,
    );
  }
  for (const field of Object.keys(semanticFollowupBlockers))
    await assert.rejects(
      verifySemanticFollowupEvidence(
        mutate((_, evidence) => {
          evidence.blockers[field] = "verified";
        }),
        read,
      ),
      /blockers changed/u,
    );
  await assert.rejects(
    verifySemanticFollowupEvidence(
      mutate((manifest) => {
        manifest.status = "complete";
      }),
      read,
    ),
    /completion remains blocked/u,
  );
  await assert.rejects(
    verifySemanticFollowupEvidence(
      mutate((_, evidence) => {
        evidence.runtime_activation_applied = true;
      }),
      read,
    ),
    /field inventory/u,
  );
});

test("missing and stale migration/provenance hashes fail for every covered file", async () => {
  for (const field of ["migration_sha256", "provenance_sha256"]) {
    for (const path of Object.keys(valid.semantic_followups_verification[field])) {
      await assert.rejects(
        verifySemanticFollowupEvidence(
          mutate((_, evidence) => {
            delete evidence[field][path];
          }),
          read,
        ),
        /exact file inventory/u,
        path,
      );
      await assert.rejects(
        verifySemanticFollowupEvidence(
          mutate((_, evidence) => {
            evidence[field][path] = "0".repeat(64);
          }),
          read,
        ),
        /digest drifted/u,
        path,
      );
    }
  }
  for (const field of [
    "source_set_sha256",
    "rendered_candidate_sha256",
    "rendered_probe_candidate_sha256",
  ])
    await assert.rejects(
      verifySemanticFollowupEvidence(
        mutate((_, evidence) => {
          evidence[field] = "0".repeat(64);
        }),
        read,
      ),
      /digest drifted/u,
      field,
    );
});

test("changed repository bytes invalidate old provenance even if the reported counts still match", async () => {
  for (const path of [
    semanticFollowupMigrationFiles[0],
    "OPERATIONS/mariadb-dev/verify-semantic-qa.mjs",
  ])
    await assert.rejects(
      verifySemanticFollowupEvidence(
        valid,
        async (file) =>
          (await read(file)) + (file === path ? "\n-- changed after verification\n" : ""),
      ),
      /digest drifted/u,
    );
  const sourcePath = "db/migrations/1783700046000_admin-security-audit-read.sql";
  await assert.rejects(
    verifySemanticFollowupEvidence(
      valid,
      async (file) => (await read(file)) + (file === sourcePath ? "\n-- changed original\n" : ""),
    ),
    /source47 derived ACL drifted/u,
  );
});

test("even a refreshed hash cannot conceal extra GRANTs in the reviewable candidate SQL", async () => {
  const path = "db/mariadb/permissions/0028_runtime_acl_candidate.sql";
  const changed =
    (await read(path)) +
    "GRANT DELETE ON classhub_mariadb_phase1_dev.`users` TO 'classhub_app'@'%';\n";
  const altered = mutate((_, evidence) => {
    evidence.provenance_sha256[path] = hash(changed);
  });
  await assert.rejects(
    verifySemanticFollowupEvidence(altered, (file) => (file === path ? changed : read(file))),
    /candidate SQL differs/u,
  );
});

test("missing documents, static files or compose isolation claims cannot pass", async () => {
  for (const path of [...semanticFollowupDocuments, ...semanticFollowupStaticTests])
    await assert.rejects(
      verifySemanticFollowupEvidence(valid, (file) => (file === path ? "" : read(file))),
      /empty evidence artifact/u,
    );
  for (const field of ["documents", "static_test_files"])
    await assert.rejects(
      verifySemanticFollowupEvidence(
        mutate((_, evidence) => {
          evidence[field] = [];
        }),
        read,
      ),
    );
  await assert.rejects(
    verifySemanticFollowupEvidence(valid, async (path) => {
      const content = await read(path);
      return path === "compose.mariadb-semantic-qa.yaml"
        ? content.replace("internal: true", "internal: false")
        : content;
    }),
  );
});

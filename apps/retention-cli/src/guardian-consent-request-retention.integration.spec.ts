import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { createDatabase, type DB } from "@classhub/db";
import { sql } from "kysely";
import {
  startNativeTestService,
  type StartedNativeTestService,
} from "../../../OPERATIONS/native-runtime/test-services.mjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { openRetentionDatabase, type RetentionDatabase } from "./database.js";
import { runGuardianConsentRequestRetention } from "./guardian-consent-request-retention.js";

const bootstrapPath = fileURLToPath(
  new URL("../../../db/bootstrap/001-local-development-roles.sql", import.meta.url),
);
const migrationsDirectory = fileURLToPath(new URL("../../../db/migrations", import.meta.url));

let bootstrapDatabase: ReturnType<typeof createDatabase<DB>>;
let container: StartedNativeTestService;
let retentionDatabase: RetentionDatabase;

function databaseUrl(username: string, password: string): string {
  return `postgresql://${username}:${password}@${container.getHost()}:${container.getMappedPort(5432)}/classhub_dev`;
}

async function applyMigrations(): Promise<void> {
  const migrator = createDatabase<DB>(databaseUrl("classhub_migrator", "local_migrator_password"));
  try {
    await sql`
      CREATE TABLE pgmigrations (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        run_on TIMESTAMPTZ NOT NULL
      )
    `.execute(migrator);
    const migrationNames = (await readdir(migrationsDirectory))
      .filter((name) => /^\d+_[a-z0-9-]+\.sql$/u.test(name))
      .sort();
    for (const name of migrationNames) {
      const migration = await readFile(`${migrationsDirectory}/${name}`, "utf8");
      const up = migration.split("-- Down Migration", 1)[0]!.replace("-- Up Migration", "");
      await migrator.transaction().execute((transaction) => sql.raw(up).execute(transaction));
    }
  } finally {
    await migrator.destroy();
  }
}

async function remainingGuardianEmails(): Promise<string[]> {
  const result = await sql<{ guardian_email_normalized: string }>`
    SELECT guardian_email_normalized
    FROM guardian_consent_requests
    ORDER BY guardian_email_normalized
  `.execute(bootstrapDatabase);
  return result.rows.map((row) => row.guardian_email_normalized);
}

async function seedRequests(): Promise<void> {
  const consumedUser = await sql<{ id: string }>`
    INSERT INTO users (display_name, email_normalized, password_hash)
    VALUES ('동의 완료 학생', 'guardian-consumed-student@example.com', 'fixture-hash')
    RETURNING id
  `.execute(bootstrapDatabase);

  await sql`
    INSERT INTO guardian_consent_requests (
      guardian_email_normalized,
      approval_token_hash,
      completion_token_hash,
      terms_policy_version,
      privacy_policy_version,
      requested_at,
      expires_at
    ) VALUES (
      'guardian-old-pending@example.com',
      sha256('old-pending-approval-token'::bytea),
      sha256('old-pending-completion-token'::bytea),
      'terms-2026-08-30',
      'privacy-2026-08-30',
      clock_timestamp() - interval '10 days',
      clock_timestamp() + interval '4 days'
    )
  `.execute(bootstrapDatabase);

  await sql`
    INSERT INTO guardian_consent_requests (
      guardian_email_normalized,
      completion_token_hash,
      terms_policy_version,
      privacy_policy_version,
      requested_at,
      expires_at,
      approved_at
    ) VALUES (
      'guardian-old-approved@example.com',
      sha256('old-approved-completion-token'::bytea),
      'terms-2026-08-30',
      'privacy-2026-08-30',
      clock_timestamp() - interval '9 days',
      clock_timestamp() + interval '5 days',
      clock_timestamp() - interval '8 days'
    )
  `.execute(bootstrapDatabase);

  await sql`
    INSERT INTO guardian_consent_requests (
      guardian_email_normalized,
      terms_policy_version,
      privacy_policy_version,
      requested_at,
      expires_at,
      invalidated_at
    ) VALUES (
      'guardian-old-invalidated@example.com',
      'terms-2026-08-30',
      'privacy-2026-08-30',
      clock_timestamp() - interval '8 days',
      clock_timestamp() + interval '6 days',
      clock_timestamp() - interval '7 days'
    )
  `.execute(bootstrapDatabase);

  await sql`
    INSERT INTO guardian_consent_requests (
      guardian_email_normalized,
      approval_token_hash,
      completion_token_hash,
      terms_policy_version,
      privacy_policy_version,
      requested_at,
      expires_at
    ) VALUES (
      'guardian-new@example.com',
      sha256('new-approval-token'::bytea),
      sha256('new-completion-token'::bytea),
      'terms-2026-08-30',
      'privacy-2026-08-30',
      clock_timestamp() - interval '1 day',
      clock_timestamp() + interval '13 days'
    )
  `.execute(bootstrapDatabase);

  await sql`
    INSERT INTO guardian_consent_requests (
      guardian_email_normalized,
      terms_policy_version,
      privacy_policy_version,
      requested_at,
      expires_at,
      approved_at,
      consumed_at,
      user_id
    ) VALUES (
      'guardian-consumed@example.com',
      'terms-2026-08-30',
      'privacy-2026-08-30',
      clock_timestamp() - interval '30 days',
      clock_timestamp() - interval '16 days',
      clock_timestamp() - interval '29 days',
      clock_timestamp() - interval '28 days',
      ${consumedUser.rows[0]!.id}::bigint
    )
  `.execute(bootstrapDatabase);
}

beforeAll(async () => {
  container = await startNativeTestService("postgres", {
    POSTGRES_DB: "classhub_dev",
    POSTGRES_PASSWORD: "local_bootstrap_password",
    POSTGRES_USER: "classhub_bootstrap",
  });
  bootstrapDatabase = createDatabase<DB>(
    databaseUrl("classhub_bootstrap", "local_bootstrap_password"),
  );
  await sql.raw(await readFile(bootstrapPath, "utf8")).execute(bootstrapDatabase);
  await applyMigrations();
  retentionDatabase = await openRetentionDatabase(
    databaseUrl("classhub_retention", "local_retention_password"),
  );
  await seedRequests();
}, 180_000);

afterAll(async () => {
  await Promise.allSettled([retentionDatabase?.destroy(), bootstrapDatabase?.destroy()]);
  await container?.stop({ remove: true, removeVolumes: true });
}, 120_000);

describe.sequential("guardian consent request retention", () => {
  it("counts only unconsumed requests older than seven days without changing them", async () => {
    const result = await runGuardianConsentRequestRetention(retentionDatabase, {
      mode: "dry-run",
    });

    expect(result).toMatchObject({
      deleted_count: 0,
      eligible_count: 3,
      mode: "dry-run",
      remaining_eligible_count: 3,
      run_id: null,
    });
    expect(await remainingGuardianEmails()).toHaveLength(5);

    const audits = await sql<{ count: string }>`
      SELECT count(*)::text AS count
      FROM operator_audit_logs
      WHERE target_id = 'guardian_consent_requests'
    `.execute(bootstrapDatabase);
    expect(audits.rows[0]!.count).toBe("0");
    expect(JSON.stringify(result)).not.toContain("@");
    expect(JSON.stringify(result)).not.toContain("token");
  });

  it("deletes old pending, approved, and invalidated rows in bounded batches", async () => {
    const first = await runGuardianConsentRequestRetention(retentionDatabase, {
      batchSize: 2,
      maxBatches: 1,
      mode: "execute",
      runId: "00000000-0000-4000-8000-000000000054",
    });
    expect(first).toMatchObject({
      capped: true,
      deleted_count: 2,
      eligible_count: 3,
      remaining_eligible_count: 1,
    });

    const second = await runGuardianConsentRequestRetention(retentionDatabase, {
      batchSize: 2,
      maxBatches: 1,
      mode: "execute",
      runId: "00000000-0000-4000-8000-000000000055",
    });
    expect(second).toMatchObject({
      capped: false,
      deleted_count: 1,
      eligible_count: 1,
      remaining_eligible_count: 0,
    });

    expect(await remainingGuardianEmails()).toEqual([
      "guardian-consumed@example.com",
      "guardian-new@example.com",
    ]);
    expect(JSON.stringify([first, second])).not.toContain("@");
    expect(JSON.stringify([first, second])).not.toContain("token");
  });

  it("audits only aggregate deletion facts", async () => {
    const audits = await sql<{ after_json: unknown; target_id: string; target_type: string }>`
      SELECT after_json, target_id, target_type
      FROM operator_audit_logs
      WHERE target_id = 'guardian_consent_requests'
      ORDER BY id
    `.execute(bootstrapDatabase);

    expect(audits.rows).toHaveLength(2);
    expect(
      audits.rows.map((entry) => Object.keys(entry.after_json as Record<string, unknown>).sort()),
    ).toEqual([
      ["cutoff_at", "deleted_count", "table_name"],
      ["cutoff_at", "deleted_count", "table_name"],
    ]);
    expect(audits.rows.map((entry) => entry.target_type)).toEqual(["retention", "retention"]);
    const serialized = JSON.stringify(audits.rows);
    expect(serialized).not.toContain("@");
    expect(serialized).not.toContain("token");
    expect(serialized).not.toContain("00000000-0000-4000-8000-00000000005");
  });
});

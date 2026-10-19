import { sql } from "kysely";

import type { ClassHubDatabase } from "../database/database.module.js";

const DATABASE_STATEMENT_TIMEOUT_MS = 1_000;
const DATABASE_IDLE_TRANSACTION_TIMEOUT_MS = 1_500;
export const READINESS_RESPONSE_TIMEOUT_MS = 1_500;

export interface ReadinessProbes {
  database: () => Promise<void>;
  redis: () => Promise<void>;
}

function settleBeforeDeadline(result: Promise<boolean>, timeoutMs: number): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<false>((resolve) => {
    timeout = setTimeout(() => resolve(false), timeoutMs);
    if (typeof timeout === "object") {
      timeout.unref();
    }
  });

  return Promise.race([result, deadline]).finally(() => {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  });
}

export async function probeDatabaseReadiness(database: ClassHubDatabase): Promise<void> {
  await database.transaction().execute(async (transaction) => {
    await sql`
      SELECT
        set_config(
          'statement_timeout',
          ${`${DATABASE_STATEMENT_TIMEOUT_MS}ms`},
          TRUE
        ),
        set_config(
          'idle_in_transaction_session_timeout',
          ${`${DATABASE_IDLE_TRANSACTION_TIMEOUT_MS}ms`},
          TRUE
        )
    `.execute(transaction);

    const result = await sql<{ ready: number }>`SELECT 1::integer AS ready`.execute(transaction);
    if (result.rows.length !== 1 || result.rows[0]?.ready !== 1) {
      throw new Error("PostgreSQL readiness probe returned an unexpected result.");
    }
  });
}

export class ReadinessProbeCoordinator {
  private inFlight: Promise<boolean> | undefined;

  constructor(
    private readonly probes: ReadinessProbes,
    private readonly responseTimeoutMs = READINESS_RESPONSE_TIMEOUT_MS,
  ) {
    if (!Number.isInteger(responseTimeoutMs) || responseTimeoutMs <= 0) {
      throw new RangeError("responseTimeoutMs must be a positive integer.");
    }
  }

  isReady(): Promise<boolean> {
    return settleBeforeDeadline(this.getOrStartProbe(), this.responseTimeoutMs);
  }

  private getOrStartProbe(): Promise<boolean> {
    if (this.inFlight !== undefined) {
      return this.inFlight;
    }

    const probe = Promise.allSettled([
      Promise.resolve().then(this.probes.database),
      Promise.resolve().then(this.probes.redis),
    ]).then((results) => results.every((result) => result.status === "fulfilled"));
    this.inFlight = probe;

    void probe.finally(() => {
      if (this.inFlight === probe) {
        this.inFlight = undefined;
      }
    });

    return probe;
  }
}

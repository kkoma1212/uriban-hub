import {
  createMariaDbDatabase,
  boundedMariaDbPoolFactory,
  MariaDbRuntimeRoleError,
  type DB,
  type MariaDbConnectionOptions,
  type MariaDbPoolFactory,
} from "@classhub/db";
import { sql, type Kysely } from "kysely";
import { markMariaDbOperatorDatabase } from "../operator-engine.js";

type Options = Omit<MariaDbConnectionOptions, "runtimeRole" | "accountHost"> & {
  accountHost: string;
};

/** Every lease repeats exact role/TLS attestation before application statements. */
export async function openMariaDbOperatorDatabase(
  createPool: MariaDbPoolFactory,
  options: Options,
): Promise<Kysely<DB>> {
  const pool = options.onRuntimeObservation
    ? boundedMariaDbPoolFactory(createPool, () => false)
    : createPool;
  const database = createMariaDbDatabase<DB>(pool, { ...options, runtimeRole: "operator" });
  try {
    await sql`SELECT 1`.execute(database);
    return markMariaDbOperatorDatabase(database);
  } catch (error) {
    try {
      await database.destroy();
    } catch {
      throw new MariaDbRuntimeRoleError("query_failed");
    }
    if (error instanceof MariaDbRuntimeRoleError) throw error;
    throw new MariaDbRuntimeRoleError("query_failed");
  }
}

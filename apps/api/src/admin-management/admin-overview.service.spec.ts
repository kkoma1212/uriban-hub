import { ConfigService } from "@nestjs/config";
import { describe, expect, it, vi } from "vitest";
import type { AppEnvironment } from "../config/environment.js";
import type { ClassHubDatabase } from "../database/database.module.js";
import type { RedisRateLimiter } from "../common/rate-limit/redis-rate-limiter.js";
import { AdminOverviewService } from "./admin-overview.service.js";

// Scripted database: no environment, live database or operational data is used.
function database(
  maintenance: () => Promise<unknown> = async () => ({ value_json: { enabled: false } }),
): ClassHubDatabase {
  const query: Record<string, unknown> = {};
  for (const method of ["select", "where", "groupBy", "distinct", "as", "innerJoin"])
    query[method] = () => query;
  query.execute = async () => [];
  query.executeTakeFirstOrThrow = async () => ({ total: 0 });
  query.executeTakeFirst = maintenance;
  return {
    selectFrom: () => query,
    getExecutor: () => ({
      transformQuery: (node: unknown) => node,
      compileQuery: () => ({}),
      executeQuery: async () => ({ rows: [] }),
    }),
  } as unknown as ClassHubDatabase;
}

describe("AdminOverviewService metric scope", () => {
  it.each(["admin", "user", "all"] as const)(
    "reports the configured %s process scope",
    async (surface) => {
      const limiter = { ensureAvailable: vi.fn().mockResolvedValue(undefined) };
      const service = new AdminOverviewService(
        database(),
        new ConfigService<AppEnvironment, true>({ API_SURFACE: surface }),
        limiter as unknown as RedisRateLimiter,
      );
      const result = await service.overview();
      expect(result.server.api_surface).toBe(surface);
      expect(result.server.redis_ok).toBe(true);
      expect(limiter.ensureAvailable).toHaveBeenCalledOnce();
      expect(result.server.errors_last_hour).toBeGreaterThanOrEqual(0);
      expect(result.server.started_at).toEqual(expect.any(String));
    },
  );
});

describe("AdminOverviewService maintenance state", () => {
  it.each([
    ["missing setting", async (): Promise<undefined> => undefined, false],
    ["disabled setting", async () => ({ value_json: { enabled: false } }), false],
    ["enabled setting", async () => ({ value_json: { enabled: true } }), true],
    [
      "failed lookup",
      async () => {
        throw new Error("lookup unavailable");
      },
      null,
    ],
  ] as const)("reports %s without disguising failure as disabled", async (_, lookup, expected) => {
    const service = new AdminOverviewService(
      database(lookup),
      new ConfigService<AppEnvironment, true>({ API_SURFACE: "admin" }),
      { ensureAvailable: vi.fn().mockResolvedValue(undefined) } as unknown as RedisRateLimiter,
    );
    const result = await service.overview();
    expect(result.server.maintenance_mode).toBe(expected);
    expect(result.server.database_ms).not.toBeNull();
    expect(result.server.redis_ok).toBe(true);
  });
});

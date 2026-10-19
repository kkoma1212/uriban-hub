import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { readDatabaseKstToday } from "../src/common/date/database-kst-clock.js";
import {
  app,
  type ClassFixture,
  createClassFixture,
  database,
  setupSuppliesHarness,
  teardownSuppliesHarness,
} from "./supplies-test-harness.js";

let fixture: ClassFixture;
const DAY_MS = 24 * 60 * 60 * 1_000;

beforeAll(setupSuppliesHarness, 120_000);
beforeEach(async () => {
  fixture = await createClassFixture();
});
afterEach(() => vi.useRealTimers());
afterAll(teardownSuppliesHarness, 120_000);

describe("bootstrap DB clock contract", () => {
  it("returns the PostgreSQL KST date when the Node clock moves by plus or minus 24 hours", async () => {
    const serverToday = await readDatabaseKstToday(database);
    const realNow = Date.now();
    await database
      .updateTable("sessions")
      .set({ expires_at: new Date(realNow + 3 * DAY_MS) })
      .where("user_id", "=", fixture.students[0].userId)
      .execute();

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(realNow + DAY_MS));
    const leading = await app.inject({
      method: "GET",
      url: "/api/v1/bootstrap",
      headers: fixture.students[0].headers,
    });
    expect(leading.statusCode).toBe(200);
    expect(leading.json().server_today).toBe(serverToday);

    vi.setSystemTime(new Date(realNow - DAY_MS));
    const lagging = await app.inject({
      method: "GET",
      url: "/api/v1/bootstrap",
      headers: fixture.students[0].headers,
    });
    expect(lagging.statusCode).toBe(200);
    expect(lagging.json().server_today).toBe(serverToday);
    expect(lagging.json().server_today).toBe(leading.json().server_today);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  kyselyConstructor: vi.fn(),
  poolConstructor: vi.fn(),
  poolOn: vi.fn(),
  postgresDialectConstructor: vi.fn(),
}));

vi.mock("pg", () => ({
  Pool: class MockPool {
    constructor(config: unknown) {
      mocks.poolConstructor(config);
    }

    on(event: string, listener: (...arguments_: unknown[]) => void): void {
      mocks.poolOn(event, listener);
    }
  },
}));

vi.mock("kysely", () => ({
  Kysely: class MockKysely {
    constructor(config: unknown) {
      mocks.kyselyConstructor(config);
    }
  },
  PostgresDialect: class MockPostgresDialect {
    constructor(config: unknown) {
      mocks.postgresDialectConstructor(config);
    }
  },
}));

import { createDatabase } from "./connection.js";

function registeredPoolListener(eventName: "connect" | "error") {
  const call = mocks.poolOn.mock.calls.find(([event]) => event === eventName);
  expect(call).toBeDefined();
  return call?.[1] as (...arguments_: unknown[]) => void;
}

function registerClientErrorListener() {
  const clientOn = vi.fn();
  registeredPoolListener("connect")({ on: clientOn });
  const call = clientOn.mock.calls.find(([event]) => event === "error");
  expect(call).toBeDefined();
  return call?.[1] as (error: unknown) => void;
}

describe("createDatabase client error boundary", () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
  });

  it("keeps custom observer options out of PoolConfig", () => {
    const onUnexpectedPoolError = vi.fn();

    createDatabase("postgresql://classhub_app:secret@database/classhub", {
      connectionTimeoutMillis: 5_000,
      onUnexpectedPoolError,
    });

    expect(mocks.poolConstructor).toHaveBeenCalledWith({
      connectionString: "postgresql://classhub_app:secret@database/classhub",
      connectionTimeoutMillis: 5_000,
    });
    expect(mocks.poolOn).toHaveBeenCalledWith("connect", expect.any(Function));
    expect(mocks.poolOn).toHaveBeenCalledWith("error", expect.any(Function));
  });

  it("handles checked-out Client errors and deduplicates the matching Pool event", () => {
    const onUnexpectedPoolError = vi.fn();
    createDatabase("postgresql://classhub_app:secret@database/classhub", {
      onUnexpectedPoolError,
    });
    const error = new Error("postgresql://secret@private-db/classhub");

    registerClientErrorListener()(error);
    registeredPoolListener("error")(error);

    expect(onUnexpectedPoolError).toHaveBeenCalledOnce();
    expect(onUnexpectedPoolError).toHaveBeenCalledWith();
  });

  it("handles Client and Pool errors even when no observer is configured", () => {
    createDatabase("postgresql://classhub_app:secret@database/classhub");
    const error = new Error("connection lost");

    expect(() => registerClientErrorListener()(error)).not.toThrow();
    expect(() => registeredPoolListener("error")(error)).not.toThrow();
  });

  it("does not let an observability callback terminate the process", () => {
    createDatabase("postgresql://classhub_app:secret@database/classhub", {
      onUnexpectedPoolError: () => {
        throw new Error("observer failed");
      },
    });

    expect(() => registerClientErrorListener()(new Error("connection lost"))).not.toThrow();
  });
});

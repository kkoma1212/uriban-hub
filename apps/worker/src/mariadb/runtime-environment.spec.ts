import { describe, expect, it } from "vitest";
import { loadWorkerEnvironment } from "../environment.js";
import { loadWorkerMariaDbEnvironment } from "./runtime-environment.js";

const workerUrl = "mariadb://classhub_worker:synthetic-secret@db.internal/classhub";
const input = {
  DATABASE_ENGINE: "mariadb",
  WORKER_DATABASE_URL: workerUrl,
  WORKER_DATABASE_TLS_CA_FILE: "/synthetic/worker-ca.pem",
  WORKER_DATABASE_ACCOUNT_HOST: "%",
  REDIS_URL: "redis://127.0.0.1:6379",
};

describe("worker MariaDB runtime environment", () => {
  it("selects MariaDB explicitly and preserves the CA/host contract with a default pool of ten", () => {
    expect(loadWorkerEnvironment(input)).toMatchObject({
      databaseEngine: "mariadb",
      workerDatabaseUrl: workerUrl,
      mariaDb: {
        tlsCaFile: input.WORKER_DATABASE_TLS_CA_FILE,
        accountHost: "%",
        connectionLimit: 10,
      },
    });
  });
  it("accepts the decoded strict worker identity and encoded credential punctuation", () => {
    const environment = loadWorkerEnvironment({
      ...input,
      WORKER_DATABASE_URL:
        "mysql://classhub%5Fworker:synthetic%2Fsecret%40value@db.internal/classhub",
    });
    expect(environment.databaseEngine).toBe("mariadb");
  });
  it.each(["1", "1000"])("accepts pool size %s", (value) => {
    expect(
      loadWorkerEnvironment({ ...input, WORKER_DATABASE_POOL_MAX: value }).mariaDb?.connectionLimit,
    ).toBe(Number(value));
  });
  it.each(["", "0", "-1", "01", "1.5", "1e2", " 2", "2 ", "1001", "9007199254740993"])(
    "rejects invalid pool size %s",
    (value) => {
      expect(() => loadWorkerEnvironment({ ...input, WORKER_DATABASE_POOL_MAX: value })).toThrow(
        "WORKER_DATABASE_POOL_MAX",
      );
    },
  );
  it.each([undefined, "", "  "])("requires a nonblank CA path: %s", (value) => {
    expect(() => loadWorkerEnvironment({ ...input, WORKER_DATABASE_TLS_CA_FILE: value })).toThrow(
      "WORKER_DATABASE_TLS_CA_FILE",
    );
  });
  it.each([undefined, "", "host name", "host@user", "host\nname"])(
    "rejects an absent or malformed account host: %s",
    (value) => {
      expect(() =>
        loadWorkerEnvironment({ ...input, WORKER_DATABASE_ACCOUNT_HOST: value }),
      ).toThrow("WORKER_DATABASE_ACCOUNT_HOST");
    },
  );
  it.each([
    "postgresql://classhub_worker:synthetic-secret@db.internal/classhub",
    "mariadb://classhub_app:synthetic-secret@db.internal/classhub",
    "mariadb://classhub_worker:synthetic-secret@127.0.0.1/classhub",
    "mariadb://classhub_worker:synthetic-secret@[::1]/classhub",
    "mariadb://classhub_worker@db.internal/classhub",
    `${workerUrl}?rejectUnauthorized=false`,
    `${workerUrl}?sslmode=verify-full`,
    `${workerUrl}?multipleStatements=true`,
  ])("rejects an incompatible role, authority or URL option: %s", (WORKER_DATABASE_URL) => {
    expect(() => loadWorkerEnvironment({ ...input, WORKER_DATABASE_URL })).toThrow(
      "WORKER_DATABASE_URL",
    );
  });
  it("requires an explicit worker URL", () => {
    expect(() => loadWorkerEnvironment({ ...input, WORKER_DATABASE_URL: undefined })).toThrow(
      "WORKER_DATABASE_URL is required",
    );
  });
  it("keeps parser failures independent of URL secrets and native diagnostics", () => {
    let caught: unknown;
    try {
      loadWorkerMariaDbEnvironment(
        input,
        "mariadb://classhub_worker:private%FFpassword@private.internal/classhub",
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(String(caught) + JSON.stringify(caught)).not.toMatch(
      /private|%FF|URIError|URI malformed/u,
    );
    expect(caught).not.toHaveProperty("cause");
  });
  it("accepts MariaDB production only with TLS Redis as well", () => {
    expect(
      loadWorkerEnvironment({
        ...input,
        NODE_ENV: "production",
        REDIS_URL: "rediss://redis.internal",
      }).databaseEngine,
    ).toBe("mariadb");
    expect(() => loadWorkerEnvironment({ ...input, NODE_ENV: "production" })).toThrow(
      "production REDIS_URL",
    );
  });
  it("keeps the default PostgreSQL role and production TLS validation", () => {
    const postgres = {
      NODE_ENV: "production",
      REDIS_URL: "rediss://redis.internal",
      WORKER_DATABASE_URL:
        "postgresql://classhub_worker:synthetic@db.internal/classhub?sslmode=verify-full",
    };
    expect(loadWorkerEnvironment(postgres)).toMatchObject({ databaseEngine: "postgres" });
    expect(loadWorkerEnvironment(postgres)).not.toHaveProperty("mariaDb");
    expect(() =>
      loadWorkerEnvironment({
        ...postgres,
        WORKER_DATABASE_URL: postgres.WORKER_DATABASE_URL.replace("verify-full", "disable"),
      }),
    ).toThrow("WORKER_DATABASE_URL");
    expect(() =>
      loadWorkerEnvironment({
        ...postgres,
        WORKER_DATABASE_URL: postgres.WORKER_DATABASE_URL.replace(
          "classhub_worker",
          "classhub_app",
        ),
      }),
    ).toThrow("classhub_worker role");
  });
});
